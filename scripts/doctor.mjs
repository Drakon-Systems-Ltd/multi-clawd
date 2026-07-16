#!/usr/bin/env node
/**
 * multi-clawd doctor — one command that says whether this box is actually
 * ready (Case's v0.3 spec). Checks, without ever printing secret values:
 *
 *   1. plugin install + manifest/config key agreement (the --force trap)
 *   2. compiled-artifact freshness (stale dist detection)
 *   3. claude CLI availability + PATH sanity
 *   4. per-account credential-source health
 *   5. per-account rate-limit telemetry (state files, age, windows)
 *   6. pool configuration + sticky state
 *   7. eviction watchdog presence (launchd/systemd)
 *
 * Flags:
 *   --preflight   print the exact config keys to strip before a --force
 *                 install against an older installed manifest
 *   --probe       spend one cheap turn proving the pool answers end-to-end
 *
 * Exit code: 0 all good, 1 any ❌.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const EXT_DIR = join(HOME, ".openclaw", "extensions", "multi-clawd");
const CONFIG_PATH = join(HOME, ".openclaw", "openclaw.json");
const STATE_DIR = join(HOME, ".openclaw", "state", "multi-clawd");
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
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
for (const [label, dir] of [["installed", EXT_DIR], ["checkout", REPO_DIR]]) {
  const src = newestMtime(join(dir, "src"), [".ts"]);
  const dist = newestMtime(join(dir, "dist"), [".js"]);
  if (src.newest === 0) continue;
  if (dist.newest === 0) bad(`${label}: no dist/ — run npm run build`);
  else if (src.newest > dist.newest)
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
const { checkAccountCredential } = await import(join(EXT_DIR, "dist", "login-health.js")).catch(
  () => import(join(REPO_DIR, "dist", "login-health.js")),
);
const io = {
  readFile: (p) => readFileSync(expandHome(p), "utf8"),
  keychainHasClaudeCredentials: () => {
    try {
      execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  },
  platform: process.platform,
};
const accounts = pluginConfig.accounts ?? [];
if (accounts.length === 0) warn("no accounts configured");
for (const account of accounts) {
  if (account.oauthTokenRef) {
    warn(`${account.id}: oauthTokenRef — validated by the gateway's async probe, not doctor`);
    continue;
  }
  const check = checkAccountCredential(account, io);
  if (check.status === "ok") ok(`${account.id}: credential source looks alive`);
  else if (check.status === "unknown") warn(`${account.id}: cannot verify (${check.reason ?? "no source"})`);
  else bad(`${account.id}: ${check.reason}`);
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
  const windows = Object.entries(state.windows ?? {})
    .map(([w, d]) => `${w}:${d.status}${typeof d.utilization === "number" ? `@${Math.round(d.utilization * 100)}%` : ""}`)
    .join(" ");
  ok(`${account.id}: ${windows || "no windows"} (${ageMin}m old)`);
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
  if (sticky) warn(`pool is currently stuck to ${sticky.account} (since ${new Date(sticky.since).toISOString()})`);
  else ok("no sticky — pool is on its home account");
}

// ── 7. watchdog ─────────────────────────────────────────────────────────────
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
if (watchdogFound) ok("watchdog scheduled");
else warn("no watchdog found (needed until openclaw#107596 ships — see README)");

// ── 8. optional live probe ──────────────────────────────────────────────────
if (args.has("--probe")) {
  console.log("live probe (spends one turn)");
  const ref = pool ? `${pool.id ?? "clawd"}/${pool.defaultModel ?? "claude-fable-5"}` : accounts[0] ? `${accounts[0].id}/claude-fable-5` : undefined;
  if (!ref) bad("nothing to probe");
  else {
    try {
      const out = execFileSync(
        "openclaw",
        ["agent", "--agent", "main", "--session-key", "agent:main:mc-doctor-probe", "--model", ref, "--json", "--message", "Reply with exactly this line and nothing else: MC_DOCTOR_OK. Do not use any tools."],
        { encoding: "utf8", timeout: 180000 },
      );
      if (out.includes("MC_DOCTOR_OK")) ok(`${ref} answered end-to-end`);
      else bad(`${ref} probe returned unexpected output`);
    } catch (err) {
      bad(`${ref} probe failed: ${String(err).slice(0, 200)}`);
    }
  }
}

console.log(failures === 0 ? "\ndoctor: READY 🦞" : `\ndoctor: ${failures} problem(s) found`);
process.exit(failures === 0 ? 0 : 1);
