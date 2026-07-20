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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = "@drakon-systems/multi-clawd";
const HOME = homedir();
const BOLD = process.stdout.isTTY ? "\x1b[1m" : "";
const DIM = process.stdout.isTTY ? "\x1b[2m" : "";
const RESET = process.stdout.isTTY ? "\x1b[0m" : "";

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`
${BOLD}🦞 multi-clawd${RESET} — multi-account Claude failover for OpenClaw

  ${BOLD}setup${RESET}     guided setup wizard (accounts, pool, watchdog)
  ${BOLD}update${RESET}    update the plugin to the latest version
  ${BOLD}doctor${RESET}    health check (add --probe for a live turn)
  ${BOLD}version${RESET}   show CLI + installed plugin versions

Run via npx (${DIM}npx ${PKG} <command>${RESET}) or install globally
(${DIM}npm i -g ${PKG}${RESET}) for a bare ${DIM}multi-clawd <command>${RESET}.
`);
}

/** Same resolution as the doctor: path install wins, else newest npm-project install. */
function resolveInstallDir() {
  const extDir = join(HOME, ".openclaw", "extensions", "multi-clawd");
  if (existsSync(join(extDir, "openclaw.plugin.json"))) return extDir;
  const projects = join(HOME, ".openclaw", "npm", "projects");
  let best;
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
  console.log(`\n${BOLD}  health check${RESET}`);
  const doc = spawnSync(process.execPath, [join(__dirname, "doctor.mjs")], { stdio: "inherit" });
  if (doc.status !== 0) {
    console.log(`\n  ⚠ doctor found problems — if it flagged the watchdog, run ${BOLD}multi-clawd setup${RESET} to repair it.`);
    process.exit(doc.status ?? 1);
  }
  console.log(`\n  ✅ done — now on v${installedVersion() ?? "?"}`);
}

switch (cmd) {
  case "setup":
    runSibling("setup.mjs", rest);
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
