/** Best-effort, bounded pins for Claude CLI sessions. No transcripts live here. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function readPins(file: string, now: number, ttlMs: number): Pins {
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
          pin.servedAt > now || now - pin.servedAt >= ttlMs) continue;
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
  const pins = readPins(file, now, ttlMs);
  pins[sessionId] = { account, servedAt: now };
  const bounded = Object.entries(pins)
    .sort((a, b) => b[1].servedAt - a[1].servedAt)
    .slice(0, MAX_SESSION_PINS);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(bounded)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}
