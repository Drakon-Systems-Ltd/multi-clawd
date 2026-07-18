#!/usr/bin/env node
/**
 * multi-clawd eviction watchdog (v0.3, turn-safe) — mitigation for
 * openclaw#107408 using a turn-safe lane-guard pattern.
 *
 * On OpenClaw <= 2026.7.1, core's scoped harness activation can silently drop
 * plugin-registered CLI backends; affected turns fail with
 * `Unknown CLI backend: <id>`. A gateway restart always restores them — but a
 * blind restart can kill a live user turn, so this watchdog:
 *
 *   1. Detects in-flight work two ways (either defers the restart):
 *      a. any agent session transcript written within the last 180s
 *         (newest .jsonl mtime under ~/.openclaw/agents/<agent>/sessions/)
 *      b. opt-in background-worker pidfiles: any live pid recorded in
 *         $MULTI_CLAWD_WORKER_PID_DIR (skipped when unset/missing)
 *   2. Persists the pending eviction and re-evaluates each tick; after
 *      MAX_DEFER (15 min) it restarts anyway — the backends are already
 *      broken, so endless deferral protects nothing.
 *   3. Applies a 10-min restart cooldown on top of once-per-eviction dedupe.
 *   4. Never restarts on missing evidence, and never restarts silently:
 *      every restart is spooled as an operator alert the plugin delivers via
 *      the agent's next heartbeat.
 *
 * Run every ~5 min (launchd/systemd). Remove once openclaw#107596 ships.
 * Env: MULTI_CLAWD_WATCHDOG_STATE, MULTI_CLAWD_WORKER_PID_DIR,
 *      MULTI_CLAWD_WATCHDOG_DRY=1
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "state", "multi-clawd");
const stateFile = process.env.MULTI_CLAWD_WATCHDOG_STATE ?? join(STATE_DIR, "watchdog.json");
const spoolFile = join(STATE_DIR, "alerts-spool.jsonl");
const SIGNATURE = /Unknown CLI backend: /;
const INFLIGHT_GRACE_MS = 180 * 1000;
const MAX_DEFER_MS = 15 * 60 * 1000;
const RESTART_COOLDOWN_MS = 10 * 60 * 1000;

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { decideWatchdogAction } = await import(join(coreDir, "watchdog-core.js"));

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function spoolAlert(severity, text) {
  try {
    mkdirSync(dirname(spoolFile), { recursive: true });
    appendFileSync(
      spoolFile,
      JSON.stringify({ key: `watchdog:${Date.now()}`, severity, text, at: Date.now() }) + "\n",
    );
  } catch {
    /* alerting must never block the watchdog */
  }
}

// ── observations (failure of any = do nothing) ──────────────────────────────
let evictionTimestamp;
try {
  const log = execFileSync("openclaw", ["logs", "--plain"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const hits = log.split("\n").filter((l) => SIGNATURE.test(l));
  if (hits.length > 0) evictionTimestamp = hits[hits.length - 1].slice(0, 30);
} catch (err) {
  console.error(`[watchdog] could not read gateway logs: ${String(err)} — doing nothing`);
  process.exit(0);
}

function newestTranscriptMtime() {
  const agentsDir = join(HOME, ".openclaw", "agents");
  let newest = 0;
  try {
    for (const agent of readdirSync(agentsDir)) {
      const sessions = join(agentsDir, agent, "sessions");
      if (!existsSync(sessions)) continue;
      for (const f of readdirSync(sessions)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = statSync(join(sessions, f)).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  } catch {
    /* unreadable agents dir → no signal */
  }
  return newest;
}

function liveWorkerPids() {
  const dir = process.env.MULTI_CLAWD_WORKER_PID_DIR;
  if (!dir || !existsSync(dir)) return 0;
  let live = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".pid")) continue;
      const pid = Number(readFileSync(join(dir, f), "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        live++;
      } catch {
        /* dead pid */
      }
    }
  } catch {
    /* unreadable dir → no signal */
  }
  return live;
}

const now = Date.now();
const transcriptFresh = now - newestTranscriptMtime() < INFLIGHT_GRACE_MS;
const workers = liveWorkerPids();
const inFlight = transcriptFresh || workers > 0;

const decision = decideWatchdogAction({
  evictionTimestamp,
  state: readState(),
  inFlight,
  nowMs: now,
  maxDeferMs: MAX_DEFER_MS,
  restartCooldownMs: RESTART_COOLDOWN_MS,
});

if (decision.action === "none") {
  console.log(`[watchdog] ${decision.reason}`);
  process.exit(0);
}

if (decision.action === "defer") {
  console.log(
    `[watchdog] eviction pending — ${decision.reason} (transcriptFresh=${transcriptFresh}, workers=${workers})`,
  );
  writeState(decision.nextState);
  process.exit(0);
}

console.log(`[watchdog] restarting gateway: ${decision.reason}`);
if (process.env.MULTI_CLAWD_WATCHDOG_DRY === "1") {
  console.log("[watchdog] dry run — not restarting");
  process.exit(0);
}
try {
  execFileSync("openclaw", ["gateway", "restart"], { encoding: "utf8", timeout: 120000 });
  writeState(decision.nextState);
  spoolAlert(
    "info",
    `eviction watchdog restarted the gateway (${decision.reason}) — backends restored`,
  );
  console.log("[watchdog] gateway restarted; backends restored");
} catch (err) {
  spoolAlert("error", "eviction watchdog FAILED to restart the gateway — backends may be down");
  console.error(`[watchdog] restart failed: ${String(err)}`);
  process.exit(1);
}
