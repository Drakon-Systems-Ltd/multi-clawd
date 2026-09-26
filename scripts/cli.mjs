#!/usr/bin/env node
/**
 * multi-clawd CLI — the friendly front door.
 *
 *   npx @drakon-systems/multi-clawd setup     guided setup wizard
 *   npx @drakon-systems/multi-clawd update    update to the latest version
 *   npx @drakon-systems/multi-clawd doctor    health check
 *   npx @drakon-systems/multi-clawd hermes    sync/diagnose Hermes credentials
 *   npx @drakon-systems/multi-clawd version   versions (CLI + installed plugin)
 *
 * (Installed globally via `npm i -g @drakon-systems/multi-clawd`, the same
 * commands are just `multi-clawd setup` / `multi-clawd update` / …)
 *
 * `update` wraps the whole upgrade dance — registry version check, the
 * openclaw install with the right flags, gateway restart, doctor — so nobody
 * has to remember `--pin --force`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync as existsSyncEarly } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir as osHomedir } from "node:os";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = "@drakon-systems/multi-clawd";
const BOLD = process.stdout.isTTY ? "\x1b[1m" : "";
const DIM = process.stdout.isTTY ? "\x1b[2m" : "";
const RESET = process.stdout.isTTY ? "\x1b[0m" : "";

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`
${BOLD}🦞 multi-clawd${RESET} — multi-account Claude failover for OpenClaw

  ${BOLD}setup${RESET}     guided setup wizard (accounts, pool, watchdog)
  ${BOLD}login${RESET}     log a configured account in (or re-auth it) — right dir, right env
  ${BOLD}explain${RESET}   your setup in plain English — accounts, pool, fallback chain
  ${BOLD}chain${RESET}     audit your model routing — what actually serves each turn
  ${BOLD}direct${RESET}    the direct anthropic/* route — status, or \`direct sync\` to store profiles
  ${BOLD}update${RESET}    update the plugin to the latest version
  ${BOLD}doctor${RESET}    health check (add --probe for a live turn)
  ${BOLD}hermes${RESET}    sync or diagnose Hermes Agent's Anthropic credential pool
  ${BOLD}version${RESET}   show CLI + installed plugin versions

Run via npx (${DIM}npx ${PKG} <command>${RESET}) or install globally
(${DIM}npm i -g ${PKG}${RESET}) for a bare ${DIM}multi-clawd <command>${RESET}.
`);
}

const { resolveInstallDir } = await import(join(__dirname, "_shared.mjs"));

function installedVersion() {
  const dir = resolveInstallDir();
  if (!dir) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function latestVersion() {
  try {
    return execFileSync("npm", ["view", PKG, "version"], { encoding: "utf8", timeout: 15000 })
      .trim();
  } catch {
    return undefined;
  }
}

function haveOpenclaw() {
  try {
    execFileSync("openclaw", ["--version"], { stdio: "pipe", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function runSibling(script, args) {
  const r = spawnSync(process.execPath, [join(__dirname, script), ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function askYes(question, dflt = true) {
  if (!process.stdin.isTTY) return dflt;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  if (!a) return dflt;
  return a.startsWith("y");
}

/** This package's own version (the CLI half). */
/**
 * Why a `dist/` import failed, in the user's terms.
 *
 * The bare "reinstall the package" message was wrong in the one case that
 * actually happens: this CLI installs globally, `openclaw` is a peerDependency,
 * and on a box where the peer is not resolvable from this directory a perfectly
 * complete build still throws ERR_MODULE_NOT_FOUND. Reinstalling cannot fix
 * that, so "reinstall the package" sends people in circles — it did, on a Mac,
 * 18 Aug 2026. Check the file exists first, then report the real cause.
 */
function distFailure(cmd, mod, err) {
  const path = resolve(__dirname, "..", "dist", mod);
  if (!existsSyncEarly(path)) {
    return `${cmd}: built dist/${mod} is missing — reinstall the package.`;
  }
  const missingPeer = /Cannot find package '([^']+)'/.exec(String(err?.message ?? ""));
  if (missingPeer) {
    const peer = missingPeer[1];
    return [
      `${cmd}: dist/${mod} is present but cannot load — the "${peer}" package is not`,
      `resolvable from this install (${resolve(__dirname, "..")}).`,
      `Install "${peer}" globally alongside this CLI, or run the CLI with npx from a`,
      `directory where "${peer}" resolves.`,
    ].join("\n  ");
  }
  return `${cmd}: dist/${mod} failed to load — ${err?.message ?? err}`;
}

function cliVersion() {
  return JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")).version;
}

/**
 * Skew advice for the current install, or undefined when the two halves agree.
 * Loads the pure classifier from dist; stays silent if dist is unavailable so
 * a missing build can never turn an informational note into a hard failure.
 */
async function cliSkewNote(cli = cliVersion(), plugin = installedVersion()) {
  try {
    const uc = await import(resolve(__dirname, "..", "dist", "update-core.js"));
    return uc.formatCliSkew({
      cliVersion: cli,
      pluginVersion: plugin,
      installKind: uc.detectCliInstallKind(resolve(__dirname, "..")),
      pkg: PKG,
    });
  } catch {
    return undefined;
  }
}


/** The OpenClaw config as parsed JSON, or undefined when unreadable. */
function readOpenclawConfigSync() {
  try {
    return JSON.parse(readFileSync(join(osHomedir(), ".openclaw", "openclaw.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Everything the direct-route surfaces need, loaded from dist. None of these
 * modules import the `openclaw` peer, so they load from a global install.
 * Returns undefined when no account mentions `direct` — callers then print
 * nothing new (the compatibility contract).
 */
async function loadDirect(config) {
  const pc = config?.plugins?.entries?.["multi-clawd"]?.config ?? {};
  const accounts = Array.isArray(pc.accounts) ? pc.accounts : [];
  if (!accounts.some((a) => a && a.direct !== undefined && a.direct !== false)) return undefined;
  let dr, ds, rep, run, shim;
  try {
    dr = await import(resolve(__dirname, "..", "dist", "direct-route.js"));
    ds = await import(resolve(__dirname, "..", "dist", "direct-sync.js"));
    rep = await import(resolve(__dirname, "..", "dist", "direct-report.js"));
    run = await import(resolve(__dirname, "..", "dist", "openclaw-runner.js"));
    shim = await import(resolve(__dirname, "..", "dist", "shim-core.js"));
  } catch (err) {
    console.error(distFailure("direct", "direct-report.js", err));
    process.exit(1);
  }
  const { readFileSync: rf } = await import("node:fs");
  const { homedir } = await import("node:os");
  const stateDir = join(homedir(), ".openclaw", "state", "multi-clawd");
  const pool = pc.pool;
  const directRoute = pc.directRoute ?? {};
  const agents = Array.isArray(directRoute.agents) && directRoute.agents.length > 0 ? directRoute.agents : ["main"];
  const configOrder = Array.isArray(config?.auth?.order?.anthropic) ? config.auth.order.anthropic : undefined;
  const readHealth = (id) => {
    try {
      return shim.parseStoredState(rf(join(stateDir, `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
  };
  let sticky;
  try {
    sticky = JSON.parse(rf(join(stateDir, "direct-order.sticky.json"), "utf8"));
  } catch {
    /* none */
  }
  const runner = run.createOpenclawRunner(directRoute.openclawCommand ?? "openclaw");
  const healthOptions = {
    utilizationThreshold: pool?.utilizationThreshold,
    staleAfterMs: pool?.staleAfterMs,
    rotateOnOverage: pool?.rotateOnOverage,
  };
  const gather = (agentId, opts = {}) =>
    rep.gatherDirectStatus({
      accounts,
      poolAccounts: pool?.accounts ?? [],
      agentId,
      runner,
      readHealth,
      healthOptions,
      configOrder,
      sticky,
      minDwellMs: pool?.minDwellMs,
      nowMs: Date.now(),
      ...opts,
    });
  return { dr, ds, rep, runner, accounts, pool, directRoute, agents, configOrder, readHealth, gather, healthOptions, sticky };
}

/**
 * `direct` — status (default) or `direct sync`: store each opted-in account's
 * setup-token as an OpenClaw `anthropic` profile through OpenClaw's own CLI
 * (secrets apply for refs — no copy; paste-token on stdin for files), then
 * put every managed agent's order in pool-health order right away instead of
 * waiting for the gateway's next tick.
 */
async function direct(args = []) {
  const { readFileSync: rf, mkdtempSync, writeFileSync, rmSync, statSync } = await import("node:fs");
  const { homedir, tmpdir } = await import("node:os");
  const config = readOpenclawConfigSync();
  if (!config) {
    console.error("direct: could not read your OpenClaw config");
    process.exit(1);
  }
  const ctx = await loadDirect(config);
  const sub = args.find((a) => !a.startsWith("--")) ?? "status";
  console.log(`\n${BOLD}🦞 multi-clawd — direct anthropic/* route${RESET}\n`);
  if (!ctx) {
    console.log("  Not configured: no account sets `direct`, so anthropic/* turns use OpenClaw's own");
    console.log("  anthropic profiles and the pool steers CLI turns only. See the README (\"Direct route\").\n");
    return;
  }
  if (sub === "sync") {
    const dryRun = args.includes("--dry-run");
    const resync = args.includes("--resync");
    const { members, problems } = ctx.dr.collectDirectMembers(ctx.accounts, ctx.pool?.accounts ?? []);
    for (const p of problems) console.log(`  ⚠️  ${p.accountId}: skipped — ${p.reason}`);
    if (members.length === 0) {
      console.log("  nothing to sync.\n");
      process.exit(problems.length > 0 ? 1 : 0);
    }
    const agentId = ctx.agents[0];
    if (!dryRun && !args.includes("--yes")) {
      console.log(`  Will store missing anthropic profiles for agent ${agentId}${resync ? " (and re-store existing ones)" : ""}:`);
      for (const m of members) console.log(`    ${m.accountId} → ${m.profileId}  (${ctx.rep.describeDirectSource(m)})`);
      console.log(`  ${DIM}Refs are stored as SecretRefs (secrets apply — the token is never copied). Token files go`);
      console.log(`  through paste-token on stdin; OpenClaw also records those in its config (auth.profiles/auth.order).${RESET}`);
      if (!(await askYes("  Proceed?"))) return;
    }
    const expand = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
    const { results, listError } = await ctx.ds.syncDirectProfiles({
      members,
      agentId,
      runner: ctx.runner,
      resync,
      dryRun,
      readTokenFile: (p) => {
        const abs = expand(p);
        const mode = statSync(abs).mode & 0o777;
        if (mode & 0o077) console.log(`  ⚠️  ${abs} is mode ${mode.toString(8)} — chmod 600 it.`);
        return rf(abs, "utf8");
      },
      writePlanFile: (plan) => {
        const dir = mkdtempSync(join(tmpdir(), "multi-clawd-plan-"));
        const path = join(dir, "plan.json");
        writeFileSync(path, JSON.stringify(plan, null, 2), { mode: 0o600 });
        return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
      },
    });
    if (listError) {
      console.error(`  ❌ could not read OpenClaw's anthropic profiles: ${listError}`);
      process.exit(1);
    }
    const icon = { present: "✅", adopted: "✅", stored: "✅", "would-store": "📝", "adopt-missing": "❌", failed: "❌" };
    for (const r of results) {
      console.log(`  ${icon[r.action] ?? "•"} ${r.accountId} → ${r.profileId}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
    }
    const failed = results.filter((r) => r.action === "failed" || r.action === "adopt-missing");
    if (!dryRun && ctx.directRoute.manageOrder !== false) {
      for (const agent of ctx.agents) {
        const status = await ctx.gather(agent, { skipCooldowns: true });
        if (!status || status.errors.length > 0) {
          console.log(`  ⚠️  agent ${agent}: order not checked (${status?.errors.join("; ") ?? "no status"})`);
          continue;
        }
        if (!status.pendingOrder) {
          console.log(`  ✅ agent ${agent}: anthropic order already in pool-health order`);
          continue;
        }
        const r = await ctx.runner(ctx.ds.orderSetArgs(agent, status.pendingOrder), { timeoutMs: 60000 });
        console.log(
          r.code === 0
            ? `  ✅ agent ${agent}: anthropic order → ${status.pendingOrder.join(" → ")}`
            : `  ❌ agent ${agent}: order set ${ctx.ds.safeCliError(r)}`,
        );
        if (r.code !== 0) failed.push({ action: "failed" });
      }
    }
    console.log("");
    process.exit(failed.length > 0 ? 1 : 0);
  }
  // status
  const ec = await import(resolve(__dirname, "..", "dist", "explain-core.js"));
  let problems = 0;
  for (const agent of ctx.agents) {
    const status = await ctx.gather(agent);
    if (!status) continue;
    console.log(`${DIM}agent ${agent}${RESET}`);
    console.log(ec.renderDirectSection(status.explain, Date.now()).join("\n"));
    for (const v of status.verdicts) console.log(`  health ${v.accountId}: ${v.verdict}`);
    if (status.pendingOrder) {
      console.log(`  ⏳ pending order (the gateway applies it within a minute, or run \`multi-clawd direct sync\`):`);
      console.log(`     ${status.pendingOrder.join(" → ")}`);
    }
    for (const e of status.errors) {
      problems++;
      console.log(`  ⚠️  ${e}`);
    }
    problems += status.explain.problems.length + status.explain.members.filter((m) => m.stored === false).length;
    console.log("");
  }
  process.exit(problems > 0 ? 1 : 0);
}

/**
 * `chain` — one place that answers "what actually serves my turns, and does it
 * match what I meant?".
 *
 * Every routing fault this project has hit was config that no longer matched
 * intent: a per-agent chain shadowing the defaults, sessions pinned off-pool,
 * allowlist rungs naming retired providers. Each was individually invisible and
 * each defeated cross-account failover — the entire point of the product. The
 * audits already existed for doctor; this gives them a home where the fix is
 * printed next to the finding.
 */
async function chain(args = []) {
  const { readFileSync: rf, existsSync, readdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const raw = args.includes("--raw");

  let ca;
  try {
    ca = await import(resolve(__dirname, "..", "dist", "chain-audit.js"));
  } catch (err) {
    console.error(distFailure("chain", "chain-audit.js", err));
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(rf(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
  } catch {
    console.error("chain: could not read ~/.openclaw/openclaw.json");
    process.exit(1);
  }

  const pc = config?.plugins?.entries?.["multi-clawd"]?.config ?? {};
  const poolId = pc.pool?.id?.trim() || (pc.pool ? "clawd" : undefined);
  const chainCfg = config?.agents?.defaults?.model;
  // v1.9: anthropic/* is pooled when the direct route serves two accounts.
  let directPooled = false;
  try {
    const dr = await import(resolve(__dirname, "..", "dist", "direct-route.js"));
    directPooled = dr.directRoutePools(Array.isArray(pc.accounts) ? pc.accounts : [], pc.directRoute);
  } catch {
    /* older dist: no direct route */
  }

  console.log(`\n${BOLD}🦞 multi-clawd — model routing${RESET}\n`);

  console.log(`${BOLD}DEFAULT CHAIN${RESET}  ${DIM}(agents.defaults.model)${RESET}`);
  const rungs = [chainCfg?.primary, ...(chainCfg?.fallbacks ?? [])].filter(
    (r) => typeof r === "string",
  );
  if (rungs.length === 0) console.log("  (none configured)");
  rungs.forEach((r, i) => {
    const pooled = poolId && r.startsWith(`${poolId}/`);
    const directRung = directPooled && /^anthropic\//i.test(r);
    console.log(
      `  ${i + 1}. ${r}${pooled ? `  ${DIM}→ pooled${RESET}` : directRung ? `  ${DIM}→ pooled (direct route)${RESET}` : ""}`,
    );
  });
  console.log("");

  let problems = 0;
  const section = (title, findings, renderRef) => {
    if (findings.length === 0) return;
    console.log(`${BOLD}${title}${RESET}`);
    for (const f of findings) {
      const icon = f.severity === "warn" ? "⚠️ " : "ℹ️ ";
      if (f.severity === "warn") problems++;
      console.log(`  ${icon} ${renderRef(f)}`);
      console.log(`      ${DIM}${f.reason}${RESET}`);
    }
    console.log("");
  };

  section("AGENTS WITH THEIR OWN CHAIN", ca.auditChainShadowing(config), (f) =>
    `${f.surface} → ${f.ref}`,
  );

  const configFindings = ca.auditEffectiveChain(config, poolId, { directPooled });
  section(
    "OFF-POOL REFERENCES",
    configFindings.filter((f) => f.severity === "warn"),
    (f) => `${f.surface}: ${f.ref}`,
  );
  const notes = configFindings.filter((f) => f.severity === "note");
  if (notes.length > 0) {
    console.log(
      `${DIM}  (${notes.length} allowlist entr${notes.length === 1 ? "y" : "ies"} name a non-pool Claude ref — registered, not a live tier)${RESET}\n`,
    );
  }

  // Session pins, across every agent's session store (2026.8.x SQLite database
  // or the older sessions.json — src/session-store.ts owns the where/how).
  const sessionFindings = [];
  const agentsDir = join(homedir(), ".openclaw", "agents");
  try {
    const store = await import(resolve(__dirname, "..", "dist", "session-store.js"));
    for (const agent of readdirSync(agentsDir)) {
      const location = store.locateSessionStore(join(agentsDir, agent));
      if (!location) continue;
      const read = await store.readSessionStore(location);
      if (!read.entries) {
        console.log(`${DIM}  (session store ${location.path} not audited: ${read.error} — see doctor)${RESET}`);
        continue;
      }
      sessionFindings.push(...ca.auditSessionOverrides(read.entries, Boolean(poolId), { directPooled }));
    }
  } catch {
    /* no agents dir, or dist not built — doctor reports install health */
  }
  section("SESSION PINS", sessionFindings, (f) =>
    raw ? f.surface : f.surface.replace(/^session (.*)$/, (_, k) => `session ${ca.maskSessionKey(k)}`),
  );

  if (problems === 0) {
    console.log(`✅ routing is consistent — every live Claude tier goes through the pool.\n`);
  } else {
    console.log(
      `${problems} thing${problems === 1 ? "" : "s"} to look at. ${DIM}Session ids are masked; --raw shows them in full.${RESET}\n`,
    );
  }
}

async function update() {
  let uc;
  try {
    uc = await import(resolve(__dirname, "..", "dist", "update-core.js"));
  } catch (err) {
    console.error(distFailure("update", "update-core.js", err));
    process.exit(1);
  }
  console.log(`\n${BOLD}🦞 multi-clawd update${RESET}\n`);
  if (!haveOpenclaw()) {
    console.error("  ❌ the `openclaw` CLI is not on PATH — install OpenClaw first.");
    process.exit(1);
  }
  const installed = installedVersion();
  process.stdout.write(`  checking registry… `);
  const latest = latestVersion();
  console.log(latest ? `latest is v${latest}` : "unreachable");
  const banner = uc.formatUpdateBanner({ installed, latest });
  const action = uc.decideUpdateAction({ installed, latest });
  console.log(`  ${action === "up-to-date" ? "✅" : action === "unknown" ? "⚠️ " : "⬆️ "} ${banner}\n`);
  if (action === "up-to-date") return;
  if (action === "unknown") {
    console.log("  Check your network and try again.");
    process.exit(1);
  }
  if (!(await askYes(`  ${action === "install" ? "Install" : "Update"} now?`))) return;

  console.log(`\n  ${DIM}openclaw plugins install ${PKG} --pin --force${RESET}`);
  const inst = spawnSync("openclaw", ["plugins", "install", PKG, "--pin", "--force"], {
    stdio: "inherit",
  });
  if (inst.status !== 0) {
    console.error("\n  ❌ install failed — see output above.");
    process.exit(1);
  }
  if (await askYes("\n  Restart the gateway to load it? (briefly interrupts running turns)")) {
    const r = spawnSync("openclaw", ["gateway", "restart"], { stdio: "inherit" });
    if (r.status !== 0) console.log("  ⚠ restart failed — run `openclaw gateway restart` yourself.");
  } else {
    console.log("  ⏳ remember: the new version loads on the next gateway restart.");
  }
  await healWatchdogUnit();
  await offerDirectSync();
  await offerCliSelfUpdate(uc);
  console.log(`\n${BOLD}  health check${RESET}`);
  const doc = spawnSync(process.execPath, [join(__dirname, "doctor.mjs")], { stdio: "inherit" });
  if (doc.status !== 0) {
    console.log(`\n  ⚠ doctor found problems — if it flagged the watchdog, run ${BOLD}npx ${PKG} setup${RESET} to repair it.`);
    process.exit(doc.status ?? 1);
  }
  console.log(`\n  ✅ done — now on v${installedVersion() ?? "?"}`);
}

/**
 * v1.9: when any account opts into the direct route, store any profile that
 * is missing and bring the order into health order as part of the update —
 * the same `direct sync` the operator can run on its own. Skipped silently
 * when nothing is configured, so updates for CLI-only users are unchanged.
 */
async function offerDirectSync() {
  const config = readOpenclawConfigSync();
  const accounts = config?.plugins?.entries?.["multi-clawd"]?.config?.accounts ?? [];
  if (!accounts.some((a) => a && a.direct !== undefined && a.direct !== false)) return;
  if (!(await askYes("\n  Sync direct-route (anthropic/*) profiles and order now?"))) {
    console.log(`  ${DIM}Skipped — run \`multi-clawd direct sync\` when you're ready.${RESET}`);
    return;
  }
  const r = spawnSync(process.execPath, [join(__dirname, "cli.mjs"), "direct", "sync", "--yes"], { stdio: "inherit" });
  if (r.status !== 0) console.log("  ⚠ direct sync reported problems — see above (`multi-clawd direct` for status).");
}

/**
 * `update` upgrades the PLUGIN; this finishes the job by offering to upgrade
 * the CLI too, so "update" means what a user reasonably assumes it means.
 *
 * Runs LAST in the update flow on purpose: `npm i -g` replaces this package's
 * own directory, so nothing may dynamically import from it afterwards. Skipped
 * silently when the halves already agree, and never forced — a global install
 * can need permissions we shouldn't assume, and npx users have nothing to
 * update at all.
 */
async function offerCliSelfUpdate(uc) {
  const cli = cliVersion();
  const plugin = installedVersion();
  if (uc.classifyCliSkew({ cliVersion: cli, pluginVersion: plugin }) !== "cli-behind") return;

  const kind = uc.detectCliInstallKind(resolve(__dirname, ".."));
  const fix = uc.cliUpdateCommand(kind, PKG);
  console.log(
    `\n  ⚠️  Your ${BOLD}multi-clawd${RESET} command is v${cli} but the plugin is now v${plugin}.`,
  );
  console.log(
    `     ${DIM}doctor and setup run from the command, so they'd report on the new plugin using old logic.${RESET}`,
  );

  if (kind !== "global") {
    console.log(`     Bring it up to date with: ${BOLD}${fix}${RESET}`);
    return;
  }
  if (!(await askYes(`     Update the command now? (${fix})`))) {
    console.log(`     ${DIM}Skipped — run \`${fix}\` when you're ready.${RESET}`);
    return;
  }
  const r = spawnSync("npm", ["i", "-g", `${PKG}@latest`], { stdio: "inherit" });
  if (r.status === 0) {
    console.log(`  ✅ command updated — the new version applies from your next run.`);
  } else {
    console.log(`  ⚠ that failed (permissions?) — run it yourself: ${BOLD}${fix}${RESET}`);
  }
}

/**
 * Self-heal the scheduled watchdog after an update: the npm install dir is
 * regenerated on every update, so a unit pointing into it just orphaned.
 * Move any broken-or-fragile unit onto the stable launcher; refresh the
 * launcher's content when a unit already uses it. Never fatal.
 */
async function healWatchdogUnit() {
  try {
    const wds = await import(resolve(__dirname, "..", "dist", "watchdog-schedule.js"));
    const { WATCHDOG_LAUNCHER } = await import(join(__dirname, "_shared.mjs"));
    const { existsSync, readdirSync, readFileSync: rf, writeFileSync, mkdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { dirname: dn } = await import("node:path");
    for (const d of [
      join(homedir(), "Library", "LaunchAgents"),
      join(homedir(), ".config", "systemd", "user"),
    ]) {
      let files = [];
      try {
        files = readdirSync(d);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/\.(plist|service|timer)$/.test(f)) continue;
        const file = join(d, f);
        let text;
        try {
          text = rf(file, "utf8");
        } catch {
          continue;
        }
        const target = wds.extractWatchdogTarget(text);
        if (!target) continue;
        const refreshLauncher = () => {
          mkdirSync(dn(WATCHDOG_LAUNCHER), { recursive: true });
          writeFileSync(WATCHDOG_LAUNCHER, wds.renderWatchdogLauncher());
        };
        if (target === WATCHDOG_LAUNCHER) {
          refreshLauncher();
          continue;
        }
        if (!existsSync(target) || wds.isFragileWatchdogTarget(target)) {
          refreshLauncher();
          writeFileSync(file, text.split(target).join(WATCHDOG_LAUNCHER));
          if (d.endsWith("LaunchAgents")) {
            // Direct spawns, not a `sh -c` string: no quoting to get wrong and
            // no shell for a path to break out of. Both calls are best-effort —
            // unload fails harmlessly when nothing is loaded yet.
            spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
            spawnSync("launchctl", ["load", file], { stdio: "ignore" });
          } else {
            try {
              execFileSync("systemctl", ["--user", "daemon-reload"]);
            } catch {
              /* manual reload needed */
            }
          }
          console.log(`  🔧 watchdog unit ${f} → stable launcher (survives future updates)`);
        }
      }
    }
  } catch {
    /* healing is best-effort; doctor still reports the truth */
  }
}

/** `explain` — gather config + live health, render the plain-English view. */
async function explain() {
  const { readFileSync: rf, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  let ec, health, shim;
  try {
    ec = await import(resolve(__dirname, "..", "dist", "explain-core.js"));
    health = await import(resolve(__dirname, "..", "dist", "health.js"));
    shim = await import(resolve(__dirname, "..", "dist", "shim-core.js"));
  } catch (err) {
    console.error(distFailure("explain", "explain-core.js", err));
    process.exit(1);
  }
  let config = {};
  try {
    config = JSON.parse(rf(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
  } catch {
    console.error("explain: could not read ~/.openclaw/openclaw.json");
    process.exit(1);
  }
  const pc = config?.plugins?.entries?.["multi-clawd"]?.config ?? {};
  const accounts = Array.isArray(pc.accounts) ? pc.accounts : [];
  const pool = pc.pool
    ? { ...pc.pool, id: pc.pool.id?.trim() || "clawd", accounts: pc.pool.accounts ?? [] }
    : undefined;
  const chain = config?.agents?.defaults?.model;
  const stateDir = join(homedir(), ".openclaw", "state", "multi-clawd");
  const now = Date.now();
  const rel = (ms) => {
    const m = Math.round((ms - now) / 60000);
    return m >= 90 ? `~${Math.round(m / 60)}h` : `~${m}m`;
  };
  const healthRows = accounts.map((a) => {
    let state;
    try {
      state = shim.parseStoredState(rf(join(stateDir, `${a.id}.json`), "utf8"));
    } catch {
      /* no telemetry yet */
    }
    const h = health.classifyAccountHealth(state, {
      utilizationThreshold: pool?.utilizationThreshold,
      staleAfterMs: pool?.staleAfterMs,
    }, now);
    let detail = h.reason;
    if (h.verdict === "exhausted" && h.resumeAt) {
      detail = `${h.reason ?? "limit hit"} — back in ${rel(h.resumeAt)}`;
    }
    const usage = health.summarizeWindowUsage(state, {
      utilizationThreshold: pool?.utilizationThreshold,
      staleAfterMs: pool?.staleAfterMs,
    }, now);
    return { id: a.id, verdict: h.verdict, detail, usage };
  });
  let stickyAccount;
  if (pool) {
    try {
      const sticky = JSON.parse(rf(join(stateDir, `pool-${pool.id}.sticky.json`), "utf8"));
      if (sticky?.account && sticky.account !== pool.accounts[0]) stickyAccount = sticky.account;
    } catch {
      /* no sticky state */
    }
  }
  // v1.9: the direct anthropic/* route, when any account opted in.
  let direct;
  const dctx = await loadDirect(config);
  if (dctx) {
    const status = await dctx.gather(dctx.agents[0]);
    direct = status?.explain;
    for (const e of status?.errors ?? []) console.log(`${DIM}(direct route: ${e})${RESET}`);
  }
  console.log(`\n${BOLD}🦞 multi-clawd — your setup, in plain English${RESET}\n`);
  console.log(
    ec.renderExplanation({ accounts, pool, chain, health: healthRows, stickyAccount, nowMs: now, direct }),
  );
  console.log(`\n${DIM}(health checks: multi-clawd doctor · change things: multi-clawd setup)${RESET}`);
}

/**
 * `login <account>` — launch the RIGHT Claude login flow for a configured
 * account: correct config-dir environment, dir created if missing, verified
 * afterwards (shows which email is signed in). The human does the OAuth; this
 * never captures, stores, or prints a token value.
 */
async function login() {
  const { readFileSync: rf, existsSync, mkdirSync, chmodSync, statSync, mkdtempSync, rmSync } =
    await import("node:fs");
  const { homedir, tmpdir } = await import("node:os");
  let lp, ec, idx;
  try {
    lp = await import(resolve(__dirname, "..", "dist", "login-plan.js"));
    ec = await import(resolve(__dirname, "..", "dist", "explain-core.js"));
    // credential-state.js, NOT index.js: this is the one call login needs from
    // the plugin side, and index.js drags in the `openclaw` peer, which is not
    // resolvable from a global CLI install on every machine.
    idx = await import(resolve(__dirname, "..", "dist", "credential-state.js"));
  } catch (err) {
    console.error(distFailure("login", "login-plan.js", err));
    process.exit(1);
  }
  let config = {};
  try {
    config = JSON.parse(rf(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
  } catch {
    console.error("login: could not read ~/.openclaw/openclaw.json — run `multi-clawd setup` first.");
    process.exit(1);
  }
  const accounts = config?.plugins?.entries?.["multi-clawd"]?.config?.accounts ?? [];
  if (accounts.length === 0) {
    console.error("login: no multi-clawd accounts configured — run `multi-clawd setup` first.");
    process.exit(1);
  }
  const target = rest[0];
  const acc = accounts.find((a) => a.id === target);
  if (!acc) {
    console.log(`\n${BOLD}Which account?${RESET}  multi-clawd login <id>\n`);
    for (const a of accounts) {
      console.log(`  ${BOLD}${a.id}${RESET}${a.label ? `  "${a.label}"` : ""}`);
      console.log(`    → ${ec.describeAccount(a)}`);
    }
    process.exit(target ? 1 : 0);
  }
  const plan = lp.loginPlanForAccount(acc);
  const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  let scratch;
  if (plan.scratchDir) {
    scratch = mkdtempSync(join(tmpdir(), "multi-clawd-login-"));
    env.CLAUDE_CONFIG_DIR = scratch;
  } else if (plan.configDir) {
    const dir = expand(plan.configDir);
    if (plan.ensureDir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    env.CLAUDE_CONFIG_DIR = dir;
  }
  if (plan.warn) console.log(`  ⚠ ${plan.warn}`);
  console.log(`\n  Launching ${DIM}${plan.command.join(" ")}${RESET} for ${BOLD}${acc.id}${RESET}${acc.label ? ` ("${acc.label}")` : ""}.`);
  console.log(`  ${BOLD}Sign in as the account this slot is for${RESET} — not your other one!\n`);
  const r = spawnSync(plan.command[0], plan.command.slice(1), { stdio: "inherit", env });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (r.status !== 0) {
    console.error(`\n  ❌ ${plan.command.join(" ")} exited with ${r.status ?? "an error"}.`);
    process.exit(1);
  }
  // Explicit re-authentication ends any recorded runtime credential failure
  // immediately (#8) — without this the freshly re-authed account stays
  // benched until the 15-minute TTL expires, which reads to the operator as
  // "logging back in did nothing".
  try {
    if (idx.clearAccountCredentialFailure?.(acc.id)) {
      console.log(`\n  ↻ cleared ${acc.id}'s recorded login failure — the pool can use it again.`);
    }
  } catch {
    /* clearing is a courtesy; never fail a login over it */
  }
  if (plan.verify === "auth-status") {
    try {
      const out = spawnSync("claude", ["auth", "status"], { encoding: "utf8", env }).stdout ?? "";
      const email = out.match(/"email"\s*:\s*"([^"]+)"/)?.[1];
      const loggedIn = /"loggedIn"\s*:\s*true/.test(out);
      if (loggedIn) console.log(`\n  ✅ ${acc.id} is signed in${email ? ` as ${BOLD}${email}${RESET}` : ""} — double-check that's the right account for this slot.`);
      else console.log("\n  ⚠ auth status does not show a login — try again or check `claude auth status` yourself.");
    } catch {
      console.log("\n  (could not verify — run `claude auth status` to confirm)");
    }
  } else if (plan.verify === "token-file" && acc.oauthTokenFile) {
    const f = expand(acc.oauthTokenFile);
    console.log(`\n  Now: ${plan.afterNote}`);
    if (await askYes("  Done — token saved?")) {
      if (existsSync(f) && statSync(f).size > 0) {
        chmodSync(f, 0o600);
        console.log(`  ✅ ${f} present (permissions set to 600). Restart the gateway to pick it up.`);
      } else {
        console.log(`  ❌ ${f} is missing or empty — the account won't authenticate until it's there.`);
      }
    }
  } else if (plan.afterNote) {
    console.log(`\n  Now: ${plan.afterNote}`);
    console.log("  Then restart the gateway; its login probe will confirm within ~15 min (or run `multi-clawd doctor`).");
  }
}

switch (cmd) {
  case "setup":
    runSibling("setup.mjs", rest);
    break;
  case "login":
    await login();
    break;
  case "explain":
    await explain();
    break;
  case "chain":
    await chain(rest);
    break;
  case "direct":
    await direct(rest);
    break;
  case "doctor":
    runSibling("doctor.mjs", rest);
    break;
  case "hermes":
    runSibling("hermes.mjs", rest);
    break;
  case "update":
    await update();
    break;
  case "version":
  case "--version":
  case "-v": {
    const cliVersion = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    ).version;
    const pluginVersion = installedVersion();
    console.log(`cli: v${cliVersion}`);
    console.log(`installed plugin: ${pluginVersion ? `v${pluginVersion}` : "(not installed)"}`);
    // Two versions printed side by side invite exactly one question — "is that
    // a problem?" — so answer it here rather than leaving the reader to guess.
    const skewNote = await cliSkewNote(cliVersion, pluginVersion);
    if (skewNote) console.log(`\n⚠️  ${skewNote}`);
    break;
  }
  default:
    usage();
    process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
}
