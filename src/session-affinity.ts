/** Best-effort, bounded pins for Claude CLI sessions. No transcripts live here. */
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resumeSessionId } from "./session-handover.js";

export const SESSION_AFFINITY_ENV = "MULTI_CLAWD_SESSION_AFFINITY";
export const DEFAULT_SESSION_AFFINITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_PINS = 1000;

export function launchSessionId(argv: readonly string[]): string | undefined {
  const resumed = resumeSessionId(argv);
  if (resumed) return resumed;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = arg === "--session-id" ? argv[i + 1]
      : arg.startsWith("--session-id=") ? arg.slice("--session-id=".length) : undefined;
    if (value !== undefined) return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : undefined;
  }
  return undefined;
}

export interface SessionPin { account: string; servedAt: number }
type Pins = Record<string, SessionPin>;

/** A pin may only win for a current, usable pool member. */
export function eligibleSessionAccount(
  pin: SessionPin | undefined,
  currentAccount: string,
  verdicts: readonly { id: string; verdict: string }[],
  availableAccounts: readonly string[],
): string | undefined {
  if (!pin) return undefined;
  if (!verdicts.some((v) => v.id === pin.account &&
      (v.verdict === "ok" || v.verdict === "no_data"))) return undefined;
  return pin.account === currentAccount || availableAccounts.includes(pin.account)
    ? pin.account : undefined;
}

/** How far past `now` a stored pin may be when a write rewrites the store. A
 * concurrent turn that captured its clock later than ours can finish first. */
const WRITE_CLOCK_SLACK_MS = 60_000;

function readPins(file: string, now: number, ttlMs: number, futureSlackMs = 0): Pins {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const pins: Pins = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) continue;
      if (!value || typeof value !== "object") continue;
      const pin = value as Partial<SessionPin>;
      if (typeof pin.account !== "string" || !pin.account ||
          typeof pin.servedAt !== "number" || !Number.isFinite(pin.servedAt) ||
          pin.servedAt > now + futureSlackMs || now - pin.servedAt >= ttlMs) continue;
      pins[id] = { account: pin.account, servedAt: pin.servedAt };
    }
    return pins;
  } catch {
    return {};
  }
}

export function readSessionPin(file: string, sessionId: string, now: number, ttlMs: number): SessionPin | undefined {
  return readPins(file, now, ttlMs)[sessionId];
}

/** Atomic replacement. A bad or missing old file starts empty; write failures never affect a turn. */
export function recordSessionPin(file: string, sessionId: string, account: string, now: number, ttlMs: number): void {
  const lock = `${file}.lock`;
  let locked = false;
  let tmp: string | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 1000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!locked) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        locked = true;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true });
        } catch { /* another writer may have released it */ }
        if (Date.now() >= deadline) return;
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    const pins = readPins(file, now, ttlMs, WRITE_CLOCK_SLACK_MS);
    pins[sessionId] = { account, servedAt: now };
    const entries = Object.entries(pins);
    const bounded = entries.length > MAX_SESSION_PINS
      ? entries.sort((a, b) => b[1].servedAt - a[1].servedAt).slice(0, MAX_SESSION_PINS)
      : entries;
    tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(bounded)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Pins are best effort; a failed write must never affect a turn.
  } finally {
    if (tmp) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    if (locked) {
      try { rmSync(lock, { force: true }); } catch { /* best effort */ }
    }
  }
}
