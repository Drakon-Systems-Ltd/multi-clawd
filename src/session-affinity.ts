/** Bounded pins for Claude CLI sessions. No transcripts live here. */
import { createHash, randomBytes } from "node:crypto";
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

/** How far past the caller's `now` a pin may be and still count. A concurrent
 * turn that captured its clock later than ours can finish first: a write must
 * not drop that turn's pin when it rewrites the store, and a read must not
 * discard it either, since a pin recorded while the read runs is the session's
 * latest (#183). */
const CLOCK_SLACK_MS = 60_000;
/** How long a write waits for the store lock before it parks its pin. */
const LOCK_WAIT_MS = 1000;
/** Parked files one write folds at most. Reads have no such limit: see readSessionPin. */
export const MAX_PARKED_PINS = 64;
/** Times a read lists a session's parked files again once one vanished under it. */
const PARKED_READ_ATTEMPTS = 4;

/** Whether a pin counts at `now`: not past the TTL, not further ahead than the slack. */
function current(pin: SessionPin, now: number, ttlMs: number, futureSlackMs: number): boolean {
  return !(pin.servedAt > now + futureSlackMs || now - pin.servedAt >= ttlMs);
}

/** The well-formed pins in a store or parked-pin text, whatever their age. Anything else is no pin. */
function parseAllPins(text: string | undefined): Pins {
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
        typeof pin.servedAt !== "number" || !Number.isFinite(pin.servedAt)) continue;
    pins[id] = { account: pin.account, servedAt: pin.servedAt };
  }
  return pins;
}

/** The valid, unexpired pins in a store or parked-pin text. Anything else is no pin. */
function parsePins(text: string | undefined, now: number, ttlMs: number, futureSlackMs: number): Pins {
  const pins = parseAllPins(text);
  for (const [id, pin] of Object.entries(pins)) {
    if (!current(pin, now, ttlMs, futureSlackMs)) delete pins[id];
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
 * `<servedAt>-<session key>-<park time>-<pid>-<per-process sequence>-<random>`,
 * every part fixed width. The session key (a hash of the session id) lets a
 * read pick out one session's files from the directory listing without
 * opening anyone else's. Names sort by `servedAt` first, so the least recently
 * served pins are the first folded and the first given up when the parked
 * files reach their bound; for one session and one `servedAt` they sort by
 * park time. The content, a one-entry store, is what counts: the name only
 * selects and orders files.
 */
const PARKED = /^(\d{13})-([0-9a-f]{32})-\d{13}-\d{10}-\d{9}-[0-9a-f]{12}$/;
const MAX_NAMED_TIME = 9_999_999_999_999;
let parkSequence = 0;

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/**
 * What the lock over one session's parked files is taken on (the lock file is
 * this path plus `.lock`). A parker removes that session's superseded files
 * only while it holds the lock, and a read that lost a file takes it to list
 * and open the session's files with no such removal possible. It is separate
 * from the store lock, which a live holder may keep for a whole turn: this one
 * is held for a listing and a few small files. The name never matches PARKED.
 */
function parkedLockTarget(file: string, key: string): string {
  return `${file}.parked-${key}`;
}

function parkedName(file: string, sessionId: string, servedAt: number): string {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  const named = Number.isFinite(servedAt) ? Math.min(Math.max(Math.floor(servedAt), 0), MAX_NAMED_TIME) : 0;
  return `${file}.pending-${fixed(named, 13)}-${sessionKey(sessionId)}-${fixed(Math.min(Date.now(), MAX_NAMED_TIME), 13)}-${fixed(process.pid, 10)}-${fixed(parkSequence++ % 1_000_000_000, 9)}-${randomBytes(6).toString("hex")}`;
}

interface ParkedFile { path: string; servedAt: number; key: string }

/** Parked pin files in name order. Throws when the directory exists and cannot be listed. */
function parkedFiles(file: string): ParkedFile[] {
  const prefix = `${basename(file)}.pending-`;
  let names: string[];
  try { names = readdirSync(dirname(file)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: ParkedFile[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(prefix)) continue;
    const match = PARKED.exec(name.slice(prefix.length));
    if (match) found.push({ path: join(dirname(file), name), servedAt: Number(match[1]), key: match[2] });
  }
  return found;
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

function remove(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* a later park or fold deals with it */ }
}

/**
 * Park `own`, then keep the parked files bounded without the store lock, which
 * a live holder may keep for as long as it runs. Three rules:
 *
 * - One file per session. Of the session's parked pins this writer counts as
 *   valid, the one served latest stays (for equal `servedAt`, the one parked
 *   last) and the rest are removed. This runs only under the session's
 *   parked-file lock, taken without waiting: a parker that finds it held
 *   removes nothing of that session and leaves the trim to the next one. A
 *   file is removed only while a file that supersedes it is already published,
 *   so the session's latest pin is on disk throughout, and a reader holding
 *   the same lock sees none of its session's files replaced under it (#183).
 * - No expired files. A file whose every pin is past the TTL is removed. No
 *   reader would have used it.
 * - At most MAX_SESSION_PINS files, the bound the store itself keeps. Beyond
 *   it files that a later-named file of the same session supersedes go first,
 *   so a session whose trim was skipped gives up its own surplus before any
 *   session gives up its only pin; then the least recently served, as a store
 *   rewrite does.
 *
 * Publishing comes first and is the only step that can fail the park; the
 * rest is best effort and repeated by the next parker.
 */
function park(file: string, sessionId: string, own: SessionPin, now: number, ttlMs: number): void {
  publish(parkedName(file, sessionId, own.servedAt), { [sessionId]: own });
  try {
    const key = sessionKey(sessionId);
    const removed = new Set<string>();
    const drop = (path: string) => { remove(path); removed.add(path); };

    const lock = acquireShimLock(parkedLockTarget(file, key), 0);
    if (lock) {
      try {
        const mine: { path: string; pin: SessionPin }[] = [];
        for (const entry of parkedFiles(file)) {
          if (entry.key !== key) continue;
          let pin: SessionPin | undefined;
          try { pin = parsePins(readText(entry.path), now, ttlMs, CLOCK_SLACK_MS)[sessionId]; } catch { continue; }
          if (pin) mine.push({ path: entry.path, pin });
        }
        // Name order within one session and one servedAt is park order: >= keeps the last parked.
        const latest = mine.reduce<typeof mine[number] | undefined>(
          (best, entry) => !best || entry.pin.servedAt >= best.pin.servedAt ? entry : best, undefined);
        for (const entry of mine) {
          if (entry === latest) continue;
          if (!lock.held()) break;
          drop(entry.path);
        }
      } finally { lock(); }
    }

    for (const entry of parkedFiles(file)) {
      if (removed.has(entry.path) || now - entry.servedAt < ttlMs) continue;
      let pins: Pins;
      try { pins = parseAllPins(readText(entry.path)); } catch { continue; }
      const held = Object.values(pins);
      if (held.length > 0 && held.every((pin) => now - pin.servedAt >= ttlMs)) drop(entry.path);
    }

    const left = parkedFiles(file);
    const over = left.length - MAX_SESSION_PINS;
    if (over > 0) {
      const last = new Map<string, string>();
      for (const entry of left) last.set(entry.key, entry.path);
      const superseded = left.filter((entry) => last.get(entry.key) !== entry.path);
      const only = left.filter((entry) => last.get(entry.key) === entry.path);
      for (const entry of [...superseded, ...only].slice(0, over)) remove(entry.path);
    }
  } catch { /* the pin is parked; bounding is retried by the next parker */ }
}

/** Test seams for a reader's interleavings with parkers and folders. */
interface ReadSessionPinHooks {
  /** Runs after each listing of the session's parked files, before any is opened. */
  afterParkedList?: () => void;
  /** Runs between the parked-pin read and the store read. */
  afterParked?: () => void;
}

/**
 * The session's parked pin served latest, from however many files the pool
 * has parked.
 *
 * The first pass takes no lock. A file that is listed and then gone was folded
 * into the store, which is read next, or was superseded by a newer parked pin
 * of the session. Listing again is not enough for the second case: each new
 * park can replace the file the new listing shows (#183). So a read that lost
 * a file takes the session's parked-file lock and lists again under it. A
 * parker removes a session's superseded files only while holding that lock,
 * and publishes the superseding file first, so under the lock every pin the
 * session had parked when the read began is in a file this pass opens, in a
 * newer one, or already in the store. Parkers that arrive meanwhile still
 * park; they only skip the trim.
 *
 * The wait for the lock is bounded. When the lock cannot be taken in that
 * time the read goes on without it, for a bounded number of passes. A process
 * that keeps the lock that long also keeps every parker from trimming the
 * session, so those passes lose a file only to a fold, to the TTL, or to the
 * parked-file bound. Only different holders following one another for the
 * whole wait, each trimming the session again, could still leave such a read
 * with an older pin.
 */
function readParkedPin(
  file: string, sessionId: string, now: number, ttlMs: number, hooks: ReadSessionPinHooks,
): SessionPin | undefined {
  const key = sessionKey(sessionId);
  let latest: SessionPin | undefined;
  /** One listing, every listed file opened. True when a listed file was gone. */
  const pass = (): boolean => {
    const mine = parkedFiles(file).filter((entry) => entry.key === key);
    hooks.afterParkedList?.();
    let vanished = false;
    for (const { path } of mine) {
      let text: string | undefined;
      try { text = readText(path); } catch { continue; /* unreadable: no pin */ }
      if (text === undefined) { vanished = true; continue; }
      const pin = parsePins(text, now, ttlMs, CLOCK_SLACK_MS)[sessionId];
      if (pin && (!latest || pin.servedAt >= latest.servedAt)) latest = pin;
    }
    return vanished;
  };
  if (!pass()) return latest;
  let release: ShimLockRelease | undefined;
  try {
    release = acquireShimLock(parkedLockTarget(file, key), LOCK_WAIT_MS);
    for (let attempt = 0; attempt < PARKED_READ_ATTEMPTS; attempt++) if (!pass()) break;
  } finally {
    release?.();
  }
  return latest;
}

/**
 * The session's pin: the store's, or a parked one served later. Parked pins
 * are read before the store because a fold replaces the store before it
 * removes a parked file: a file that vanishes under this read is already in
 * the store this read then opens.
 *
 * The result is at least as recent as the session's latest valid pin, stored
 * or parked, at the moment the read began, however many pins the session
 * parks while the read runs. A pin recorded during the read was served after
 * the read's `now`; it counts, up to CLOCK_SLACK_MS ahead.
 *
 * Only the session's own parked files are opened, all of them, so what other
 * sessions have parked cannot hide this session's pin. A parker keeps one
 * file per session, so that is normally one file.
 */
export function readSessionPin(
  file: string, sessionId: string, now: number, ttlMs: number, hooks: ReadSessionPinHooks = {},
): SessionPin | undefined {
  let parked: SessionPin | undefined;
  try { parked = readParkedPin(file, sessionId, now, ttlMs, hooks); } catch { /* store only */ }
  hooks.afterParked?.();
  let pins: Pins = {};
  try { pins = parsePins(readText(file), now, ttlMs, CLOCK_SLACK_MS); } catch { /* unreadable: parked pin only */ }
  if (parked) fold(pins, { [sessionId]: parked });
  return pins[sessionId];
}

/**
 * Atomic replacement under the store lock. A corrupt or missing store starts
 * empty; a failed write never affects a turn.
 *
 * For every session the pin served latest wins, whichever writer arrives
 * last: this writer's own pin replaces a stored one only when it was not
 * served earlier, and a parked pin only when it was served strictly later.
 *
 * A writer that cannot take the lock within LOCK_WAIT_MS never replaces the
 * store (that could erase another writer's pin) and does not drop its pin
 * either: it parks the pin in a pending file. Readers combine parked pins
 * with the store, and a later lock holder folds them in. The same happens
 * when the store exists and cannot be read, or the lock was replaced under
 * its holder.
 *
 * A fold is safe to repeat and to interrupt: it keeps, per session, the pin
 * served latest, so a parked file applied twice, or left behind by a holder
 * that stopped after its replace, changes nothing. A lock holder removes a
 * parked file only after it read it, committed a store that includes it, and
 * still owned the lock afterwards. One write folds at most MAX_PARKED_PINS
 * files, least recently served first.
 *
 * Parked files stay bounded while no writer can take the lock at all: see
 * park(). Nothing is signalled or killed, and every wait stays bounded.
 */
export function recordSessionPin(file: string, sessionId: string, account: string, now: number, ttlMs: number): void {
  let release: ShimLockRelease | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const own: SessionPin = { account, servedAt: now };
    const lock = release = acquireShimLock(file, LOCK_WAIT_MS);
    if (!lock) return park(file, sessionId, own, now, ttlMs);

    let pins: Pins;
    let parked: ParkedFile[];
    try {
      pins = parsePins(readText(file), now, ttlMs, CLOCK_SLACK_MS);
      parked = parkedFiles(file).slice(0, MAX_PARKED_PINS);
    } catch { return park(file, sessionId, own, now, ttlMs); }
    const stored = pins[sessionId];
    if (!stored || own.servedAt >= stored.servedAt) pins[sessionId] = own;
    const consumed: string[] = [];
    for (const { path } of parked) {
      let text: string | undefined;
      try { text = readText(path); } catch { continue; }
      if (text === undefined) continue;
      fold(pins, parsePins(text, now, ttlMs, CLOCK_SLACK_MS));
      consumed.push(path);
    }
    const entries = Object.entries(pins);
    const bounded = entries.length > MAX_SESSION_PINS
      ? entries.sort((a, b) => b[1].servedAt - a[1].servedAt).slice(0, MAX_SESSION_PINS)
      : entries;
    if (!lock.held()) return park(file, sessionId, own, now, ttlMs);
    publish(file, Object.fromEntries(bounded));
    if (!lock.held()) return;
    for (const path of consumed) remove(path);
  } catch {
    // A failed write must never affect a turn.
  } finally {
    release?.();
  }
}
