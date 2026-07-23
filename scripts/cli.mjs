#!/usr/bin/env node
/**
 * multi-clawd CLI — the friendly front door.
 *
 *   npx @drakon-systems/multi-clawd setup     guided setup wizard
 *   npx @drakon-systems/multi-clawd update    update to the latest version
 *   npx @drakon-systems/multi-clawd doctor    health check
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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  ${BOLD}update${RESET}    update the plugin to the latest version
  ${BOLD}doctor${RESET}    health check (add --probe for a live turn)
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

async function update() {
  let uc;
  try {
    uc = await import(resolve(__dirname, "..", "dist", "update-core.js"));
  } catch {
    console.error("update: built dist/ is missing — reinstall the package.");
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
  console.log(`\n${BOLD}  health check${RESET}`);
  const doc = spawnSync(process.execPath, [join(__dirname, "doctor.mjs")], { stdio: "inherit" });
  if (doc.status !== 0) {
    console.log(`\n  ⚠ doctor found problems — if it flagged the watchdog, run ${BOLD}npx ${PKG} setup${RESET} to repair it.`);
    process.exit(doc.status ?? 1);
  }
  console.log(`\n  ✅ done — now on v${installedVersion() ?? "?"}`);
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
            try {
              execFileSync("/bin/sh", ["-c", `launchctl unload "${file}" 2>/dev/null; launchctl load "${file}" 2>&1 || true`]);
            } catch {
              /* manual load needed */
            }
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
  } catch {
    console.error("explain: built dist/ is missing — reinstall the package.");
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
  console.log(`\n${BOLD}🦞 multi-clawd — your setup, in plain English${RESET}\n`);
  console.log(
    ec.renderExplanation({ accounts, pool, chain, health: healthRows, stickyAccount, nowMs: now }),
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
  let lp, ec;
  try {
    lp = await import(resolve(__dirname, "..", "dist", "login-plan.js"));
    ec = await import(resolve(__dirname, "..", "dist", "explain-core.js"));
  } catch {
    console.error("login: built dist/ is missing — reinstall the package.");
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
  case "doctor":
    runSibling("doctor.mjs", rest);
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
    console.log(`cli: v${cliVersion}`);
    console.log(`installed plugin: ${installedVersion() ? `v${installedVersion()}` : "(not installed)"}`);
    break;
  }
  default:
    usage();
    process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
}
