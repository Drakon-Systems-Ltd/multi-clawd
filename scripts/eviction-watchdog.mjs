#!/usr/bin/env node
/**
 * multi-clawd eviction watchdog — mitigation for openclaw#107408.
 *
 * On OpenClaw <= 2026.7.1, core's scoped harness activation can silently drop
 * plugin-registered CLI backends from the live registry; affected turns fail
 * with `Unknown CLI backend: <id>`. A gateway restart always restores them
 * (startup loads are full-scope). This script tails the gateway log for that
 * signature and restarts the gateway at most once per eviction event.
 *
 * Run it periodically (cron/launchd/systemd timer), e.g. every 5 minutes:
 *   node scripts/eviction-watchdog.mjs
 *
 * Options via env:
 *   MULTI_CLAWD_WATCHDOG_STATE  state file (default ~/.openclaw/state/multi-clawd/watchdog.json)
 *   MULTI_CLAWD_WATCHDOG_DRY    set to 1 to report without restarting
 *
 * Remove once the upstream fix (openclaw#107596) ships in your OpenClaw.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SIGNATURE = /Unknown CLI backend: /;
const stateFile =
  process.env.MULTI_CLAWD_WATCHDOG_STATE ??
  join(homedir(), ".openclaw", "state", "multi-clawd", "watchdog.json");

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { lastHandled: "" };
  }
}

function writeState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function gatewayLog() {
  try {
    return execFileSync("openclaw", ["logs", "--plain"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[watchdog] could not read gateway logs: ${String(err)}`);
    process.exit(0); // don't restart on observation failure
  }
}

const state = readState();
const lines = gatewayLog().split("\n");
const hits = lines.filter((l) => SIGNATURE.test(l));
if (hits.length === 0) {
  console.log("[watchdog] no eviction signature found");
  process.exit(0);
}
const newest = hits[hits.length - 1];
const timestamp = newest.slice(0, 30); // ISO prefix of the log line
if (timestamp <= state.lastHandled) {
  console.log(`[watchdog] newest eviction (${timestamp}) already handled`);
  process.exit(0);
}

console.log(`[watchdog] eviction detected: ${newest.trim()}`);
if (process.env.MULTI_CLAWD_WATCHDOG_DRY === "1") {
  console.log("[watchdog] dry run — not restarting");
  process.exit(0);
}
try {
  execFileSync("openclaw", ["gateway", "restart"], { encoding: "utf8", timeout: 120000 });
  writeState({ lastHandled: timestamp, restartedAt: new Date().toISOString() });
  console.log("[watchdog] gateway restarted; backends restored");
} catch (err) {
  console.error(`[watchdog] restart failed: ${String(err)}`);
  process.exit(1);
}
