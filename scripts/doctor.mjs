#!/usr/bin/env node
/**
 * multi-clawd doctor — one command that says whether this box is actually
 * ready (per the v0.3 spec). Checks, without ever printing secret values:
 *
 *   1. plugin install + manifest/config key agreement (the --force trap)
 *   2. compiled-artifact freshness (stale dist detection)
 *   3. claude CLI availability + PATH sanity
 *   4. per-account credential-source health + which Claude login each
 *      account actually authenticates as (and whether two share one)
 *   5. per-account rate-limit telemetry (state files, age, windows)
 *   6. pool configuration, sticky state, and the account the next turn runs on
 *   7. effective chain — Claude tiers must route through the clawd pool
 *   8. chain auth — every non-Claude rung must have a usable auth profile
 *   9. eviction watchdog presence (launchd/systemd)
 *
 * Flags:
 *   --preflight   print the exact config keys to strip before a --force
 *                 install against an older installed manifest
 *   --probe       spend one cheap turn per account (plus the pool) proving
 *                 each login answers end-to-end
 *   --probe-pool  with --probe: the pool ref only, one turn total
 *   --raw         print login emails and session keys unmasked
 *   --verbose     list allowlist rungs, per-account verdicts, every surface
 *
 * Exit code: 0 all good, 1 any ❌.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();

/**
 * Where is the plugin actually installed? Path installs land in
 * ~/.openclaw/extensions/multi-clawd; registry installs (npm spec) land in
 * ~/.openclaw/npm/projects/<pkg-hash>/node_modules/@drakon-systems/multi-clawd.
 * Prefer the extensions dir when both exist (it shadows), else the newest
 * npm-project install carrying a manifest.
 */
function resolveInstallDir() {
  const extDir = join(HOME, ".openclaw", "extensions", "multi-clawd");
  if (existsSync(join(extDir, "openclaw.plugin.json"))) return extDir;
  const projects = join(HOME, ".openclaw", "npm", "projects");
  let best = extDir;
  let bestM = -1;
  try {
    for (const p of readdirSync(projects)) {
      if (!p.startsWith("drakon-systems-multi-clawd-")) continue;
      const dir = join(projects, p, "node_modules", "@drakon-systems", "multi-clawd");
      const manifest = join(dir, "openclaw.plugin.json");
      if (!existsSync(manifest)) continue;
      const m = statSync(manifest).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = dir;
      }
    }
  } catch {
    /* no npm projects dir */
  }
  return best;
}
const EXT_DIR = resolveInstallDir();
const CONFIG_PATH = join(HOME, ".openclaw", "openclaw.json");
const STATE_DIR = join(HOME, ".openclaw", "state", "multi-clawd");
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
// Hoisted: doctor output is pasted into issues and support threads, so every
// section that can print an identifying value (login emails in §4/§6, session
// keys in §7) masks by default and honours the same single --raw opt-in.
const VERBOSE = process.env.DOCTOR_VERBOSE === "1" || args.has("--verbose");
const RAW = process.env.DOCTOR_RAW === "1" || args.has("--raw");
let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const note = (msg) => console.log(`  ℹ️  ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  ❌ ${msg}`);
};

function expandHome(p) {
  if (p === "~") return HOME;
  if (p?.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Import a compiled module, preferring the INSTALLED plugin so findings
 * describe the artifact that actually runs — but falling back to this
 * checkout when the installed copy predates an export doctor needs.
 *
 * The fallback is the point: a bare `import(EXT).catch(() => import(REPO))`
 * only catches a missing FILE. An older installed dist that loads fine but
 * lacks a newly added export produced `X is not a function` mid-report, with
 * every earlier section already printed as if all was well.
 */
async function importDist(file, required = [], prefer = "installed") {
  // `prefer: "cli"` for pure static analysis (the chain audits): that logic is
  // doctor's own, so it must run at the CLI's version. Mixing the two — a new
  // section reading the checkout while an older section read the install —
  // produced two different views of the same config in one report.
  const dirs = prefer === "cli" ? [REPO_DIR, EXT_DIR] : [EXT_DIR, REPO_DIR];
  const candidates = dirs.map((d) => join(d, "dist", file));
  let firstError;
  for (const path of candidates) {
    try {
      const mod = await import(path);
      if (required.every((name) => typeof mod[name] === "function")) return mod;
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error(`no usable dist/${file} (missing: ${required.join(", ")})`);
}

function newestMtime(dir, exts) {
  let newest = 0;
  let newestFile = "";
  try {
    for (const f of readdirSync(dir)) {
      if (!exts.some((e) => f.endsWith(e))) continue;
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > newest) {
        newest = m;
        newestFile = f;
      }
    }
  } catch {
    /* missing dir */
  }
  return { newest, newestFile };
}

console.log("multi-clawd doctor\n");

// ── 1. install + manifest/config agreement ─────────────────────────────────
console.log("install & config");
const manifest = readJson(join(EXT_DIR, "openclaw.plugin.json"));
const config = readJson(CONFIG_PATH);
const entry = config?.plugins?.entries?.["multi-clawd"];
const pluginConfig = entry?.config ?? {};
if (!manifest) bad(`no installed manifest at ${EXT_DIR}`);
else ok(`installed at ${EXT_DIR}`);

// Doctor itself ships in the CLI half, so a stale CLI means these very
// findings were produced by older logic than the plugin they describe. That
// has to be the first thing reported, or every line below is suspect.
{
  // REPO_DIR first, unlike the health imports below: this is CLI-side logic and
  // doctor IS the CLI half, so it must use its own copy. Reaching for the
  // plugin's copy would ask a possibly-older artifact whether it is older.
  const uc = await import(join(REPO_DIR, "dist", "update-core.js")).catch(() =>
    import(join(EXT_DIR, "dist", "update-core.js")).catch(() => undefined),
  );
  const cliVer = readJson(join(REPO_DIR, "package.json"))?.version;
  const pluginVer = manifest?.version;
  const note =
    uc && cliVer && typeof uc.formatCliSkew === "function"
      ? uc.formatCliSkew({
          cliVersion: cliVer,
          pluginVersion: pluginVer,
          installKind: uc.detectCliInstallKind(REPO_DIR),
          pkg: "@drakon-systems/multi-clawd",
        })
      : undefined;
  if (note) warn(note);
  else if (cliVer && pluginVer) ok(`CLI and plugin both v${cliVer}`);

  // Is the installed plugin behind what npm publishes? Nothing else asks:
  // `openclaw plugins update --all` compares against the PINNED spec and so
  // always reports a pinned plugin up to date (found 1 Aug 2026), and doctor
  // did no registry lookup at all. Cached, short-timeout, and silent when the
  // registry cannot be reached — an offline box has no finding to report.
  if (uc && pluginVer && typeof uc.formatRegistryLag === "function") {
    const cacheFile = join(STATE_DIR, "registry-check.json");
    const cached = readJson(cacheFile);
    let latest = uc.registryCacheIsFresh(cached?.checkedAt, Date.now())
      ? cached?.latest
      : undefined;
    if (!latest) {
      try {
        latest = execFileSync("npm", ["view", "@drakon-systems/multi-clawd", "version"], {
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        try {
          mkdirSync(STATE_DIR, { recursive: true });
          writeFileSync(
            cacheFile,
            JSON.stringify({ latest, checkedAt: Date.now() }, null, 2) + "\n",
          );
        } catch {
          /* cache is an optimisation, never a requirement */
        }
      } catch {
        latest = undefined; // offline / registry down — stay silent
      }
    }
    const lag = uc.formatRegistryLag({ installed: pluginVer, latest });
    if (lag?.level === "warn") warn(lag.text);
    else if (lag?.level === "ok") ok(lag.text);
  }
}
if (!entry) bad("no plugins.entries[\"multi-clawd\"] in openclaw.json");
else if (entry.enabled !== true) bad("plugin entry present but not enabled");
else ok("plugin entry enabled");
const allow = config?.plugins?.allow;
if (Array.isArray(allow) && !allow.includes("multi-clawd")) {
  bad('plugins.allow exists but does not include "multi-clawd"');
} else ok("plugins.allow OK");

const unknownKeys = [];
if (manifest && pluginConfig) {
  const schemaProps = manifest.configSchema?.properties ?? {};
  for (const key of Object.keys(pluginConfig)) {
    if (!schemaProps[key]) unknownKeys.push(key);
  }
  const accountProps = schemaProps.accounts?.items?.properties ?? {};
  for (const [i, account] of (pluginConfig.accounts ?? []).entries()) {
    for (const key of Object.keys(account)) {
      if (!accountProps[key]) unknownKeys.push(`accounts[${i}].${key}`);
    }
  }
  const poolProps = schemaProps.pool?.properties ?? {};
  for (const key of Object.keys(pluginConfig.pool ?? {})) {
    if (!poolProps[key]) unknownKeys.push(`pool.${key}`);
  }
}
if (unknownKeys.length > 0) {
  bad(
    `config keys the INSTALLED manifest does not know: ${unknownKeys.join(", ")} — a --force install will refuse. Strip them, install, re-add (SETUP-AGENT.md §6).`,
  );
} else ok("config keys all known to installed manifest");
if (args.has("--preflight")) {
  console.log(
    unknownKeys.length > 0
      ? `\npreflight: strip these keys first → ${unknownKeys.join(", ")}\n`
      : "\npreflight: config is manifest-clean; --force install is safe as-is\n",
  );
}

// ── 2. dist freshness ───────────────────────────────────────────────────────
console.log("build artifacts");
// Tolerance matters: `openclaw plugins install` copies dist/ before src/ with
// fresh mtimes, so the installed copy's src is always seconds "newer". A
// genuinely stale dist (pulled src, forgot to build) lags by minutes-to-days.
const STALE_TOLERANCE_MS = 120_000;
for (const [label, dir] of [["installed", EXT_DIR], ["checkout", REPO_DIR]]) {
  const src = newestMtime(join(dir, "src"), [".ts"]);
  const dist = newestMtime(join(dir, "dist"), [".js"]);
  if (src.newest === 0) continue;
  if (dist.newest === 0) bad(`${label}: no dist/ — run npm run build`);
  else if (src.newest > dist.newest + STALE_TOLERANCE_MS)
    bad(`${label}: dist is STALE (src ${src.newestFile} newer than dist) — run npm run build`);
  else ok(`${label}: dist fresh`);
}

// ── 3. claude CLI + PATH ────────────────────────────────────────────────────
console.log("claude CLI");
try {
  const v = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
  ok(`claude on PATH (${v.split("\n")[0]})`);
} catch {
  bad("claude CLI not found on PATH");
}

// ── 4. account credentials (values never printed) ──────────────────────────
console.log("account credentials");
const { checkAccountCredential, keychainServiceForConfigDir } = await importDist("login-health.js", [
  "checkAccountCredential",
  "keychainServiceForConfigDir",
]);
const { summarizeWindowUsage, classifyAccountHealth } = await importDist("health.js", [
  "summarizeWindowUsage",
  "classifyAccountHealth",
]);
const { resolveAccountIdentity, describeIdentity, findDuplicateLogins, maskEmail } =
  await importDist("account-identity.js", [
    "resolveAccountIdentity",
    "describeIdentity",
    "findDuplicateLogins",
    "maskEmail",
  ]);
const { decideStickySelection } = await importDist("sticky.js", ["decideStickySelection"]);
const io = {
  readFile: (p) => readFileSync(expandHome(p), "utf8"),
  keychainHasClaudeCredentials: () => keychainHasService("Claude Code-credentials"),
  keychainHasClaudeCredentialsForDir: (dir) =>
    keychainHasService(keychainServiceForConfigDir(expandHome(dir))),
  platform: process.platform,
};
// Metadata-only probe (no `-w`): the secret is never read.
function keychainHasService(service) {
  try {
    execFileSync("security", ["find-generic-password", "-s", service], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
// A native account's child sets no CLAUDE_CONFIG_DIR, so it authenticates
// against whatever the default dir is in the ENV THE GATEWAY RUNS IN. Doctor
// reads the same variable and prints the path it used, so a box that exports
// CLAUDE_CONFIG_DIR globally shows its real source rather than a guess.
const identityIo = {
  readFile: (p) => readFileSync(expandHome(p), "utf8"),
  expandHome,
  defaultConfigDir: process.env.CLAUDE_CONFIG_DIR
    ? expandHome(process.env.CLAUDE_CONFIG_DIR)
    : join(HOME, ".claude"),
};
const accounts = pluginConfig.accounts ?? [];
const identities = [];
if (accounts.length === 0) warn("no accounts configured");
for (const account of accounts) {
  // WHO this account is, before WHETHER its credential works. An id is a
  // label the operator chose; the login is the thing quota is spent against,
  // and the two drift apart silently (a config dir re-logged-in as the wrong
  // user looks perfectly healthy on every other line of this report).
  const identity = resolveAccountIdentity(account, identityIo);
  identities.push(identity);
  const source = account.native
    ? `native login, ${identityIo.defaultConfigDir}`
    : account.configDir
      ? `config dir ${account.configDir}`
      : account.oauthTokenFile
        ? "token file"
        : account.oauthTokenRef
          ? "token ref"
          : "no declared source";
  if (identity.status === "resolved") {
    note(`${account.id} → ${describeIdentity(identity, { raw: RAW })} (${source})`);
  } else if (account.oauthTokenFile || account.oauthTokenRef) {
    // Expected, not a fault: the identity is inside the token. Proving it
    // would cost a real turn, which doctor does not spend unless --probe.
    note(`${account.id} → login not knowable at rest (${source}) — ${identity.reason}`);
  } else {
    warn(`${account.id}: cannot tell which Claude login this is — ${identity.reason}`);
  }
  // RUNTIME credential health first: the source check below only proves a
  // credential EXISTS, and #8 is exactly the case where a present credential
  // is a session the Claude CLI has already rejected. A recorded runtime
  // failure is the stronger evidence, so it is reported as such.
  const recorded = readJson(join(STATE_DIR, `${account.id}.json`))?.credential;
  if (recorded?.status === "failed") {
    const ageMin = Math.round((Date.now() - recorded.seenAt) / 60000);
    bad(
      `${account.id}: the Claude CLI rejected this login ${ageMin}m ago${
        recorded.reason ? ` (${recorded.reason})` : ""
      } — excluded from the pool; fix with \`multi-clawd login ${account.id}\``,
    );
    continue;
  }
  if (account.oauthTokenRef) {
    warn(`${account.id}: oauthTokenRef — validated by the gateway's async probe, not doctor`);
    continue;
  }
  const check = checkAccountCredential(account, io);
  if (check.status === "ok") ok(`${account.id}: credential source looks alive`);
  else if (check.status === "unknown") warn(`${account.id}: cannot verify (${check.reason ?? "no source"})`);
  else bad(`${account.id}: ${check.reason}`);
}

// Two ids, one login. This is the failure the rest of doctor cannot see: every
// section still says READY while "failover" rotates onto the quota it just
// exhausted. Scoped to pool members when a pool exists — outside a pool,
// sharing a login is a legitimate way to run two profiles of one account.
{
  const poolMembers = pluginConfig.pool?.accounts;
  const scoped = Array.isArray(poolMembers)
    ? identities.filter((i) => poolMembers.includes(i.accountId))
    : identities;
  for (const dupe of findDuplicateLogins(scoped)) {
    const who = dupe.email
      ? ` (${RAW ? dupe.email : maskEmail(dupe.email)})`
      : "";
    bad(
      `${dupe.accountIds.join(" and ")} are the SAME Claude login${who} — rotating between them ` +
        `buys no extra quota. Log one of them into a different account (\`multi-clawd login <account>\`).`,
    );
  }
  if (scoped.filter((i) => i.status === "resolved").length > 1 && findDuplicateLogins(scoped).length === 0) {
    ok("pool accounts are distinct Claude logins");
  }
}

// ── 5. telemetry state ──────────────────────────────────────────────────────
console.log("rate-limit telemetry");
for (const account of accounts) {
  const state = readJson(join(STATE_DIR, `${account.id}.json`));
  if (!state) {
    warn(`${account.id}: no health state yet (fills after its first turn)`);
    continue;
  }
  const ageMin = Math.round((Date.now() - (state.updatedAt ?? 0)) / 60000);
  // A window whose own reset has PASSED describes the previous cycle, and the
  // rotation logic already voids it ("a passed reset voids the observation",
  // health.ts). Doctor used to print it raw beside a fresh `(0m old)` stamp,
  // so a five-day-dead `seven_day@96%` read as "96% used right now" when
  // nothing was acting on it. The age stamp is the age of the OBSERVATION,
  // never the window's validity.
  //
  // `summarizeWindowUsage` is the same function `explain` uses, so all three
  // surfaces — rotation, explain, doctor — agree on what counts as live
  // rather than each carrying its own copy of the rule.
  const live = new Set(
    summarizeWindowUsage(state, { staleAfterMs: pluginConfig.pool?.staleAfterMs }, Date.now()).map(
      (u) => u.window,
    ),
  );
  const windows = Object.entries(state.windows ?? {})
    .map(([w, d]) => {
      const hasUtil = typeof d.utilization === "number";
      const util = hasUtil ? `@${Math.round(d.utilization * 100)}%` : "";
      // Only utilization-bearing account windows are summarised; a window
      // carrying a number that did NOT survive is one the pool ignores.
      const stale = hasUtil && !w.startsWith("model:") && !live.has(w);
      return `${w}:${d.status}${util}${stale ? " (expired — ignored)" : ""}`;
    })
    .join(" ");
  ok(`${account.id}: ${windows || "no windows"} (observed ${ageMin}m ago)`);
}

// ── 6. pool ─────────────────────────────────────────────────────────────────
console.log("pool");
const pool = pluginConfig.pool;
if (!pool) warn("no pool configured — direct backends only, no proactive rotation");
else {
  const members = (pool.accounts ?? []).filter((id) => accounts.some((a) => a.id === id));
  if (members.length < 2) bad(`pool "${pool.id ?? "clawd"}" has ${members.length} valid member(s); needs ≥ 2`);
  else ok(`pool "${pool.id ?? "clawd"}": ${members.join(" → ")}`);
  const sticky = readJson(join(STATE_DIR, `pool-${pool.id ?? "clawd"}.sticky.json`));

  // WHICH ACCOUNT IS ACTUALLY BEING USED. Everything above describes the pool
  // as configured; this answers the question an operator actually asks — whose
  // subscription does the next turn spend? Re-run the real selection (the same
  // classify → sticky-dwell decision index.ts makes at launch) rather than
  // inferring it from the sticky file, because "no sticky" means home, a live
  // sticky can be about to expire, and health outranks both.
  if (members.length > 0) {
    const now = Date.now();
    const verdicts = members.map((id) => ({
      id,
      verdict: classifyAccountHealth(
        readJson(join(STATE_DIR, `${id}.json`)),
        {
          staleAfterMs: pool.staleAfterMs,
          utilizationThreshold: pool.utilizationThreshold,
          rotateOnOverage: pool.rotateOnOverage,
        },
        now,
      ).verdict,
    }));
    const decision = decideStickySelection({
      verdicts,
      sticky,
      nowMs: now,
      minDwellMs: pool.minDwellMs,
    });
    const identity = identities.find((i) => i.accountId === decision.account);
    const who =
      identity?.status === "resolved" ? ` (${describeIdentity(identity, { raw: RAW })})` : "";
    const verdict = verdicts.find((v) => v.id === decision.account)?.verdict ?? "no_data";
    const home = members[0];
    if (decision.account === home) {
      ok(`serving on ${decision.account}${who} — home account, health ${verdict}`);
      if (sticky) {
        note(
          `sticky to ${sticky.account} (since ${new Date(sticky.since).toISOString()}) is spent — ` +
            `the next turn returns home`,
        );
      }
    } else {
      // Rotated away from home is normal operation, not a fault: warn so it is
      // visible, never bad, or a healthy rotation would flip READY.
      warn(
        `serving on ${decision.account}${who} — ROTATED off home (${home} is ${
          verdicts[0].verdict
        })${sticky ? `, sticky since ${new Date(sticky.since).toISOString()}` : ""}`,
      );
    }
    // The launch decision is model-aware (a 429 can bench one account for one
    // model only); doctor has no model in hand, so this is the account-wide
    // answer. Say so rather than let a model-scoped exception read as a lie.
    if (VERBOSE) {
      note(`account-wide verdicts: ${verdicts.map((v) => `${v.id}:${v.verdict}`).join(" ")}`);
    }
  }
}

// ── 7. effective chain (pool-bypass sweep — CASE 1 config + CASE 2 session) ──
//
// CASE 1: a STATIC, at-rest scan of openclaw.json. Every Claude model reference
// under `agents` must route through the clawd pool; a Claude tier pinned to
// `anthropic/…`, `claude-cli/…`, or a single `claw<N>/…` account silently
// defeats cross-account failover — yet doctor used to still say READY (e.g.
// a Claude fallback pinned to `anthropic/claude-fable-5`).
//
// CASE 2: a STATIC scan of session state. A persisted per-session `/model`
// override (`~/.openclaw/agents/<agent>/sessions/sessions.json`) bypasses the
// pool exactly like a config pin but lives outside openclaw.json — invisible to
// case 1. Same off-pool predicate, same warn classes.
//
// Both emit warn(), never bad(): a box may *intentionally* pin one account or
// one session, so neither may flip the exit code / READY.
console.log("effective chain");
if (!pool) {
  // No clawd pool ⇒ nothing to bypass; skip the whole section (mirrors §6).
} else {
  const { auditEffectiveChain, auditSessionOverrides, maskSessionKey } = await importDist(
    "chain-audit.js",
    ["auditEffectiveChain", "auditSessionOverrides", "maskSessionKey"],
    "cli",
  );
  const poolId = pool.id ?? "clawd";
  // Session keys embed the operator's private channel id (e.g. a Telegram chat
  // id). Mask the id tail by default so doctor output is safe to paste into
  // issues/support threads; `--raw` (hoisted, shared with the login identities
  // in §4/§6) restores full keys for local exact-match debugging. Only case-2
  // session surfaces carry a key; config surfaces don't.
  const renderSurface = (surface) =>
    RAW ? surface : surface.replace(/^session (.+)$/, (_m, k) => `session ${maskSessionKey(k)}`);

  // ── case 1: config-level refs ──────────────────────────────────────────────
  const findings = auditEffectiveChain(config, poolId);
  const warns = findings.filter((f) => f.severity === "warn");
  const notes = findings.filter((f) => f.severity === "note");
  for (const f of warns) warn(`${f.surface}: ${f.ref} ${f.reason}`);
  // Allowlist entries are registered-but-not-live rungs: informational only,
  // and there are typically many (every non-pool Claude id someone MAY ref).
  // Collapse to one line so the section stays scannable; DOCTOR_VERBOSE lists
  // them. A dead-noisy section trains people to skip it — the opposite of the
  // point. (Live-tier bypasses above are always listed in full.)
  if (notes.length > 0) {
    if (VERBOSE) {
      for (const f of notes) {
        note(`${f.surface}: ${f.ref} (allowlist entry, not a live tier) ${f.reason}`);
      }
    } else {
      note(
        `${notes.length} allowlist rung(s) name a non-pool Claude ref (registered, not a live tier) — run with --verbose to list`,
      );
    }
  }
  if (warns.length === 0) ok(`effective chain: all live Claude tiers route through the ${poolId} pool`);

  // ── case 2: session-level /model overrides ─────────────────────────────────
  // Enumerate every agent's session store — the 2026.8.x per-agent SQLite
  // database, or the older sessions.json map (src/session-store.ts owns the
  // where and the how). A store that is expected but absent/unreadable gets a
  // LOUD skip — never a silent pass; a missed off-pool pin is worse than an
  // extra line.
  const { locateSessionStore, readSessionStore } = await importDist("session-store.js", [
    "locateSessionStore",
    "readSessionStore",
  ]);
  const AGENTS_DIR = join(HOME, ".openclaw", "agents");
  const stores = [];
  try {
    for (const agent of readdirSync(AGENTS_DIR)) {
      const location = locateSessionStore(join(AGENTS_DIR, agent));
      if (location) stores.push(location);
    }
  } catch {
    /* no agents dir at all */
  }
  if (stores.length === 0) {
    note("session overrides: no agent session stores found (clean environment)");
  } else {
    let sessionWarns = 0;
    let readable = 0;
    for (const location of stores) {
      const read = await readSessionStore(location);
      if (!read.entries) {
        warn(`session-override check SKIPPED for ${location.path} (${read.error})`);
        continue;
      }
      readable++;
      if (read.skippedRows > 0) {
        warn(`${location.path}: ${read.skippedRows} session row(s) unparseable — those sessions were not audited`);
      }
      const sessionFindings = auditSessionOverrides(read.entries, true);
      for (const f of sessionFindings) {
        warn(`${renderSurface(f.surface)}: ${f.ref} ${f.reason}`);
        sessionWarns++;
      }
    }
    if (readable > 0 && sessionWarns === 0) ok("session overrides: no off-pool /model pins");
  }
}

// ── 8. chain auth — can each non-Claude rung actually authenticate? ─────────
//
// §7 proves the chain is ROUTED correctly. It says nothing about whether the
// rungs it routes to hold a credential. A fallback whose provider has no
// eligible auth profile is a rung that does not exist, and the gap only shows
// up at the moment the tier above it dies — the one moment it was supposed to
// help. The auth store is read through the documented CLI (`models auth list
// --json`), never by guessing at its on-disk shape, and cached because that
// call costs seconds.
console.log("chain auth");
{
  const { auditChainAuth } = await importDist("chain-auth.js", ["auditChainAuth"], "cli");
  const { collectChainRefs } = await importDist("chain-audit.js", ["collectChainRefs"], "cli");
  const AUTH_CACHE_TTL_MS = 15 * 60 * 1000;
  const agentIds = Object.keys(config?.agents?.entries ?? {});
  // Which store answers for a surface that names no agent (agents.defaults,
  // cron sections): the default agent. `main` when it exists, else the first
  // configured entry — the same fallback the CLI applies.
  const defaultAgent = agentIds.includes("main") ? "main" : agentIds[0];

  function ownerOf(surface) {
    const entry = surface.match(/^agents\.entries\.([^.]+)\./)?.[1];
    if (entry) return entry;
    const list = surface.match(/^agents\.list\[([^\]]+)\]/)?.[1];
    if (list && agentIds.includes(list)) return list;
    const named = surface.match(/^agents\.([^.]+)\./)?.[1];
    if (named && agentIds.includes(named)) return named;
    return defaultAgent;
  }

  function loadProfiles(agentId) {
    const cacheFile = join(STATE_DIR, `auth-profiles-${agentId}.json`);
    const cached = readJson(cacheFile);
    if (cached && Date.now() - (cached.checkedAt ?? 0) < AUTH_CACHE_TTL_MS) {
      return { profiles: cached.profiles ?? [], cached: true };
    }
    try {
      const out = execFileSync(
        "openclaw",
        ["models", "auth", "list", "--agent", agentId, "--json"],
        { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const profiles = JSON.parse(out)?.profiles ?? [];
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(
          cacheFile,
          JSON.stringify({ profiles, checkedAt: Date.now() }, null, 2) + "\n",
        );
      } catch {
        /* cache is an optimisation, never a requirement */
      }
      return { profiles, cached: false };
    } catch (err) {
      // A LOUD skip. Silently passing here would turn "doctor could not read
      // the auth store" into "the chain is fine", which is the failure class
      // this whole section exists to remove.
      return { error: String(err).split("\n")[0].slice(0, 160) };
    }
  }

  const refs = collectChainRefs(config ?? {});
  const byAgent = new Map();
  for (const ref of refs) {
    const agentId = ownerOf(ref.surface);
    if (!agentId) continue;
    const list = byAgent.get(agentId) ?? [];
    list.push(ref);
    byAgent.set(agentId, list);
  }
  if (byAgent.size === 0) {
    note("no chain refs to check");
  }
  for (const [agentId, agentRefs] of [...byAgent.entries()].sort()) {
    const loaded = loadProfiles(agentId);
    if (loaded.error) {
      warn(`chain-auth check SKIPPED for agent ${agentId} — auth store unreadable (${loaded.error})`);
      continue;
    }
    const findings = auditChainAuth({
      refs: agentRefs,
      profiles: loaded.profiles,
      order: config?.auth?.order,
      poolId: pluginConfig.pool?.id ?? "clawd",
      nowMs: Date.now(),
    });
    if (findings.length === 0) {
      ok(`${agentId}: every live non-Claude rung has a usable auth profile`);
      continue;
    }
    for (const f of findings) {
      const where = VERBOSE ? ` [${f.surfaces.join(", ")}]` : ` [${f.surfaces[0]}${f.surfaces.length > 1 ? ` +${f.surfaces.length - 1}` : ""}]`;
      const line = `${agentId}: ${f.provider}${where} — ${f.reason}`;
      if (f.severity === "bad") bad(line);
      else if (f.severity === "warn") warn(line);
      else note(line);
    }
  }
}

// ── 9. watchdog ─────────────────────────────────────────────────────────────
console.log("eviction watchdog");
let watchdogFound = false;
try {
  const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
  if (out.includes("multiclawd")) watchdogFound = true;
} catch {
  /* not macOS */
}
try {
  const out = execFileSync("systemctl", ["--user", "list-timers", "--all"], { encoding: "utf8" });
  if (out.includes("multi-clawd") || out.includes("multiclawd") || out.includes("eviction")) watchdogFound = true;
} catch {
  /* not systemd */
}
if (watchdogFound) {
  // "Scheduled" is not enough: the unit points at a script INSIDE an install
  // dir, and installs move (path→registry migration, uninstall/reinstall).
  // An orphaned unit fires every tick against a missing file — silently.
  // Deliberately self-contained (no dist import): the check must work even
  // when the install itself is the thing that went missing.
  let orphan;
  for (const d of [
    join(HOME, "Library", "LaunchAgents"),
    join(HOME, ".config", "systemd", "user"),
  ]) {
    let files = [];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      // Only real unit files — launchd loads *.plist, systemd *.service/*.timer;
      // backups like *.plist.bak-... are inert and must not be flagged.
      if (!/\.(plist|service|timer)$/.test(f)) continue;
      let text;
      try {
        text = readFileSync(join(d, f), "utf8");
      } catch {
        continue;
      }
      const target = text.match(/[^<>\s="']*(?:eviction-watchdog|watchdog-launcher)\.mjs/)?.[0];
      if (target && !existsSync(target)) orphan = { file: join(d, f), target };
      else if (target && target.includes("/.openclaw/npm/projects/")) {
        warn(
          `watchdog unit ${join(d, f)} points INTO the npm install dir — regenerated on every update, so it WILL orphan. Run the setup wizard (or \`update\`) to move it to the stable launcher.`,
        );
      }
    }
  }
  if (orphan) {
    bad(
      `watchdog unit ${orphan.file} points at a MISSING script (${orphan.target}) — it fails silently every tick. Repoint it at ${join(EXT_DIR, "scripts", "eviction-watchdog.mjs")} or run the setup wizard to repair.`,
    );
  } else ok("watchdog scheduled");
} else warn("no watchdog found (needed until openclaw#107596 ships — see README)");

// ── 10. optional live probe ─────────────────────────────────────────────────
if (args.has("--probe")) {
  // EVERY account, not just the pool ref. The pool ref proves whichever
  // account selection happens to pick right now — so a dead second account
  // stayed invisible until the day rotation needed it, which is the day it
  // could least afford to be wrong. One turn per account plus one for the
  // pool; `--probe-pool` keeps the old single-turn behaviour.
  const model = pool?.defaultModel ?? "claude-fable-5";
  const targets = [];
  if (pool) targets.push({ label: `pool ${pool.id ?? "clawd"}`, ref: `${pool.id ?? "clawd"}/${model}` });
  if (!args.has("--probe-pool")) {
    for (const account of accounts) targets.push({ label: account.id, ref: `${account.id}/${model}` });
  }
  console.log(`live probe (spends ${targets.length} turn${targets.length === 1 ? "" : "s"})`);
  if (targets.length === 0) bad("nothing to probe");
  for (const target of targets) {
    try {
      const out = execFileSync(
        "openclaw",
        [
          "agent",
          "--agent",
          "main",
          // Per-target session key: one shared key would resume the previous
          // probe's session, and a resumed Claude session can answer from the
          // account that STARTED it — the probe would then prove the wrong
          // account while looking perfectly green.
          "--session-key",
          `agent:main:mc-doctor-probe:${target.ref.replace(/[^a-z0-9]+/gi, "-")}`,
          "--model",
          target.ref,
          "--json",
          "--message",
          "Reply with exactly this line and nothing else: MC_DOCTOR_OK. Do not use any tools.",
        ],
        // stderr captured, not inherited: a refusal is classified below and
        // reported as one line, instead of dumping the CLI's own error block
        // into the middle of the report.
        { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (out.includes("MC_DOCTOR_OK")) ok(`${target.label}: ${target.ref} answered end-to-end`);
      else bad(`${target.label}: ${target.ref} probe returned unexpected output`);
    } catch (err) {
      const text = String(err.stderr ?? "") + String(err.stdout ?? "") + String(err);
      // A model-policy refusal says nothing about the ACCOUNT: the gateway
      // declined the ref before any login was used. Reporting it as a probe
      // failure would accuse a perfectly healthy account (pool members are
      // normally reached through `<pool>/*`, so a direct `claw<N>/…` ref is
      // often simply not allowlisted).
      if (/modelPolicy\.allow/.test(text)) {
        warn(
          `${target.label}: not probed — \`${target.ref}\` is blocked by agents.defaults.modelPolicy.allow. ` +
            `Add \`${target.ref.split("/")[0]}/*\` to probe this account directly; its pool routing is unaffected.`,
        );
      } else {
        bad(`${target.label}: ${target.ref} probe failed: ${String(err).slice(0, 200)}`);
      }
    }
  }
}

console.log(failures === 0 ? "\ndoctor: READY 🦞" : `\ndoctor: ${failures} problem(s) found`);
process.exit(failures === 0 ? 0 : 1);
