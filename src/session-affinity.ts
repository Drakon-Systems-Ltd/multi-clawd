/** Bounded pins for Claude CLI sessions. No transcripts live here. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resumeSessionId } from "./session-handover.js";
import { acquireShimLock, type ShimLockRelease } from "./shim-lock.js";

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
/** How long a write waits for the store lock before it parks its pin. */
const LOCK_WAIT_MS = 1000;
/** Parked pins one read combines, and one write folds, at most. */
export const MAX_PARKED_PINS = 64;

/** The valid, unexpired pins in a store or parked-pin text. Anything else is no pin. */
function parsePins(text: string | undefined, now: number, ttlMs: number, futureSlackMs: number): Pins {
  const pins: Pins = {};
  if (text === undefined) return pins;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return pins; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return pins;
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
}

/** The file's text, or undefined when there is no file. Throws when it exists and cannot be read. */
function readText(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * A pin parked by a writer that could not take the lock in time. The name is
 * `<park time>-<pid>-<per-process sequence>-<random>`, the first three parts
 * fixed width, so names sort by the millisecond the pin was parked. The
 * content is a one-entry store.
 */
const PARKED = /^\d{13}-\d{10}-\d{9}-[0-9a-f]{12}$/;
let parkSequence = 0;

function parkedName(file: string): string {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  return `${file}.pending-${fixed(Date.now(), 13)}-${fixed(process.pid, 10)}-${fixed(parkSequence++ % 1_000_000_000, 9)}-${randomBytes(6).toString("hex")}`;
}

/** Parked pin files, oldest first. Throws when the directory exists and cannot be listed. */
function parkedFiles(file: string): string[] {
  const prefix = `${basename(file)}.pending-`;
  let names: string[];
  try { names = readdirSync(dirname(file)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.startsWith(prefix) && PARKED.test(name.slice(prefix.length)))
    .sort().map((name) => join(dirname(file), name));
}

/** Atomic publish: readers and the folding lock holder see a whole file or none. */
function publish(target: string, pins: Pins): void {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(pins), { mode: 0o600 });
    renameSync(tmp, target);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/** A parked pin replaces a stored one only when it was served strictly later. */
function fold(into: Pins, parked: Pins): void {
  for (const [id, pin] of Object.entries(parked)) {
    if (!into[id] || pin.servedAt > into[id].servedAt) into[id] = pin;
  }
}

/** Test seam: runs between a reader's parked-pin read and its store read. */
interface ReadSessionPinHooks {
  afterParked?: () => void;
}

/**
 * The session's pin: the store's, or a parked one served later. Parked pins
 * are read before the store because a fold replaces the store before it
 * removes a parked file: a file that vanishes under this read is already in
 * the store this read then opens. At most the MAX_PARKED_PINS most recently
 * parked files are opened.
 */
export function readSessionPin(
  file: string, sessionId: string, now: number, ttlMs: number, hooks: ReadSessionPinHooks = {},
): SessionPin | undefined {
  const parked: Pins = {};
  try {
    for (const path of parkedFiles(file).slice(-MAX_PARKED_PINS)) {
      try { fold(parked, parsePins(readText(path), now, ttlMs, 0)); } catch { /* unreadable: no pin */ }
    }
  } catch { /* store only */ }
  hooks.afterParked?.();
  let pins: Pins = {};
  try { pins = parsePins(readText(file), now, ttlMs, 0); } catch { /* unreadable: parked pins only */ }
  fold(pins, parked);
  return pins[sessionId];
}

/**
 * Atomic replacement under the store lock. A corrupt or missing store starts
 * empty; a failed write never affects a turn.
 *
 * A writer that cannot take the lock within LOCK_WAIT_MS never replaces the
 * store (that could erase another writer's pin) and no longer drops its pin
 * either: it parks the pin in a pending file. Readers combine parked pins
 * with the store, and a later lock holder folds them in. The same happens
 * when the store exists and cannot be read, or the lock was replaced under
 * its holder.
 *
 * A fold is safe to repeat and to interrupt: it keeps, per session, the pin
 * served latest, so a parked file applied twice, or left behind by a holder
 * that stopped after its replace, changes nothing. A parked file is removed
 * only by a holder that read it, committed a store that includes it, and
 * still owned the lock afterwards. One write folds at most MAX_PARKED_PINS
 * files, oldest first; until some writer takes the lock, parked files
 * accumulate without a bound of their own.
 */
export function recordSessionPin(file: string, sessionId: string, account: string, now: number, ttlMs: number): void {
  let release: ShimLockRelease | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const own: Pins = { [sessionId]: { account, servedAt: now } };
    const park = () => publish(parkedName(file), own);
    const lock = release = acquireShimLock(file, LOCK_WAIT_MS);
    if (!lock) return park();

    let pins: Pins;
    let parked: string[];
    try {
      pins = parsePins(readText(file), now, ttlMs, WRITE_CLOCK_SLACK_MS);
      parked = parkedFiles(file).slice(0, MAX_PARKED_PINS);
    } catch { return park(); }
    pins[sessionId] = own[sessionId];
    const consumed: string[] = [];
    for (const path of parked) {
      let text: string | undefined;
      try { text = readText(path); } catch { continue; }
      if (text === undefined) continue;
      fold(pins, parsePins(text, now, ttlMs, WRITE_CLOCK_SLACK_MS));
      consumed.push(path);
    }
    const entries = Object.entries(pins);
    const bounded = entries.length > MAX_SESSION_PINS
      ? entries.sort((a, b) => b[1].servedAt - a[1].servedAt).slice(0, MAX_SESSION_PINS)
      : entries;
    if (!lock.held()) return park();
    publish(file, Object.fromEntries(bounded));
    if (!lock.held()) return;
    for (const path of consumed) {
      try { rmSync(path, { force: true }); } catch { /* a later holder folds it again, harmlessly */ }
    }
  } catch {
    // A failed write must never affect a turn.
  } finally {
    release?.();
  }
}
