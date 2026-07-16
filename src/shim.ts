/**
 * multi-clawd stream shim — a transparent wrapper around the `claude` CLI.
 *
 * The gateway spawns this instead of `claude` directly. It passes stdin,
 * stdout, stderr, argv, and the exit code through untouched, while scanning
 * the stream-json output for `rate_limit_event` records and folding them into
 * a per-account health-state file (MULTI_CLAWD_STATE_FILE). The steering hook
 * reads that file to rotate accounts *before* they hit their usage limits.
 *
 * Invariants:
 * - Passthrough fidelity beats capture: stream bytes are forwarded as-is,
 *   and any capture/state failure is swallowed (stderr note only) — a broken
 *   state file must never break a live turn.
 * - Tolerant parsing: rate_limit_event is CLI-internal and undocumented;
 *   unknown fields, statuses, and window types are preserved or ignored,
 *   never fatal.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createLineScanner,
  mergeHealthStates,
  parseRateLimitEvent,
  parseStoredState,
  updateHealthState,
  type AccountHealthState,
} from "./shim-core.js";

function resolveClaudeCommand(): { command: string; prependArgs: string[] } {
  const override = process.env.MULTI_CLAWD_CLAUDE_BIN;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === "string")) {
        return { command: parsed[0], prependArgs: parsed.slice(1) };
      }
    } catch {
      // not JSON — treat as a plain binary path
    }
    return { command: override, prependArgs: [] };
  }
  return { command: "claude", prependArgs: [] };
}

const stateFile = process.env.MULTI_CLAWD_STATE_FILE;
const accountId = process.env.MULTI_CLAWD_ACCOUNT_ID ?? "unknown";

let state: AccountHealthState = { accountId, windows: {} };

function readPersistedState(): AccountHealthState | undefined {
  if (!stateFile) return undefined;
  try {
    return parseStoredState(readFileSync(stateFile, "utf8"));
  } catch {
    return undefined; // missing or unreadable file — start fresh
  }
}

function persistState(): void {
  if (!stateFile) return;
  try {
    // Read-merge-write on every persist: windows observed by earlier
    // invocations (or a concurrent shim on the same account) must survive a
    // turn that only emits a different window type — otherwise a
    // five_hour-only response erases the last seven_day utilization and a
    // near-limit crossing becomes invisible. Per-window `seenAt` decides
    // which side wins; expiring old windows is the reader's job (health.ts).
    const disk = readPersistedState();
    if (disk) state = mergeHealthStates(disk, state);
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch (err) {
    process.stderr.write(`[multi-clawd shim] state write failed: ${String(err)}\n`);
  }
}

const { command, prependArgs } = resolveClaudeCommand();
const child = spawn(command, [...prependArgs, ...process.argv.slice(2)], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

process.stdin.pipe(child.stdin);

const scanner = createLineScanner((line) => {
  try {
    const event = parseRateLimitEvent(line);
    if (event) {
      state = updateHealthState(state, event, Date.now());
      persistState();
    }
  } catch {
    // capture must never interfere with the stream
  }
});

child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk); // passthrough first, always
  scanner.push(chunk.toString("utf8"));
});
child.stdout.on("end", () => scanner.flush());

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  process.stderr.write(`[multi-clawd shim] failed to spawn claude: ${String(err)}\n`);
  process.exit(127);
});
