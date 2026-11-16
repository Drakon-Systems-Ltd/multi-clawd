/** Bounded pins for Claude CLI sessions. No transcripts live here. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resumeSessionId } from "./session-handover.js";
import { acquireShimLock, shimLockFile, type ShimLockRelease } from "./shim-lock.js";

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
/**
 * Pins by session id. A session id may be a name every plain object inherits
 * (`constructor`, `toString`, ...): launchSessionId accepts those. So a pin
 * dictionary is made without a prototype (emptyPins) and is looked up only
 * through pinOf, an own-property check: an id with no pin is `undefined`,
 * never an inherited function (#186).
 */
type Pins = Record<string, SessionPin>;

function emptyPins(): Pins {
  return Object.create(null) as Pins;
}

/** The pin stored under `id` itself, or undefined. */
function pinOf(pins: Pins, id: string): SessionPin | undefined {
  return Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : undefined;
}

/** A dictionary holding one pin. */
function onePin(id: string, pin: SessionPin): Pins {
  const pins = emptyPins();
  pins[id] = pin;
  return pins;
}

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

/** How far ahead of a clock reading a pin may be and still count. A concurrent
 * turn that captured its clock later than ours can finish first: a write must
 * not drop that turn's pin when it rewrites the store. A read measures from
 * the later of its caller's `now` and the clock when it lists the files: see
 * readSessionPin. */
const CLOCK_SLACK_MS = 60_000;
/** How long a write waits for the store lock before it parks its pin. */
const LOCK_WAIT_MS = 1000;
/** Parked files one write folds at most. Reads have no such limit: see readSessionPin. */
export const MAX_PARKED_PINS = 64;
/**
 * Parked files one session has at most (#186). A write that finds this many
 * makes room first or is refused: see park().
 */
export const MAX_SESSION_PARKED = 32;
/**
 * Parked files in all at most (#186): the store's own bound, plus one
 * session's worth of files that could not be removed when they were
 * superseded. A write that finds this many makes room first or is refused:
 * see park().
 */
export const MAX_PARKED_FILES = MAX_SESSION_PINS + MAX_SESSION_PARKED;
/**
 * Listings one read makes at most: one before it announces itself and three
 * after. Three is not a tuning value. Once a read is announced at most one
 * parker can still be removing files of its session, from one listing, oldest
 * first, and that costs a read two listings at most before one must settle:
 * see readSessionPin.
 */
const PARKED_READ_LISTINGS = 4;

/** Whether a pin counts: not past the TTL at `now`, not served after `latest`. */
function current(pin: SessionPin, now: number, ttlMs: number, latest: number): boolean {
  return !(pin.servedAt > latest || now - pin.servedAt >= ttlMs);
}

/** The well-formed pins in a store or parked-pin text, whatever their age. Anything else is no pin. */
function parseAllPins(text: string | undefined): Pins {
  const pins = emptyPins();
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
function parsePins(text: string | undefined, now: number, ttlMs: number, latest: number): Pins {
  const pins = parseAllPins(text);
  for (const [id, pin] of Object.entries(pins)) {
    if (!current(pin, now, ttlMs, latest)) delete pins[id];
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
 * this path plus `.lock`). A parker removes a parked file, for whatever
 * reason, only while it holds the lock of that file's session, so at any
 * moment at most one process is removing files of a session. It is separate
 * from the store lock, which a live holder may keep for a whole turn: this one
 * is held for a listing and a few small files, and nobody waits for it. A
 * read never takes it. The name never matches PARKED.
 */
function parkedLockTarget(file: string, key: string): string {
  return `${file}.parked-${key}`;
}

/**
 * A read that lost a parked file announces itself with a marker,
 * `<store>.parked-<session key>.reader-<pid>-<random>.lock`, until it returns.
 * A parker that holds a session's lock looks for markers before it removes
 * anything of that session and removes nothing while a live reader has one.
 * Markers are per reader, so a read never waits for another read or for a
 * parker.
 *
 * The marker holds what a shim lock holds (pid, time, token, process
 * generation), so a parker tells a live reader from one that died with the
 * same check a lock gets. It is written under a private name and renamed into
 * place: it is never visible half written, when its age alone could get it
 * removed.
 */
function announceReader(file: string, key: string): (() => void) | undefined {
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const staged = acquireShimLock(`${file}.reader-${id}`, 0);
  if (!staged) return undefined;
  const marker = `${file}.parked-${key}.reader-${id}.lock`;
  try {
    if (!staged.held()) return undefined;
    renameSync(shimLockFile(`${file}.reader-${id}`), marker);
  } catch {
    staged();
    return undefined;
  }
  return () => remove(marker);
}

/** Whether a live reader has announced itself for the session. A dead reader's marker is removed. */
function readerAnnounced(file: string, key: string, names: readonly string[]): boolean {
  const prefix = `${basename(file)}.parked-${key}.reader-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".lock")) continue;
    // Taking the marker as a lock succeeds only when its reader is gone. A
    // try with no wait can also remove a dead reader's marker and then run
    // out of time before taking it: the marker is gone then, which is what
    // tells that case from a live reader's.
    const marker = join(dirname(file), name);
    const taken = acquireShimLock(marker.slice(0, -".lock".length), 0);
    if (taken) taken();
    else if (existsSync(marker)) return true;
  }
  return false;
}

function parkedName(file: string, sessionId: string, servedAt: number): string {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  const named = Number.isFinite(servedAt) ? Math.min(Math.max(Math.floor(servedAt), 0), MAX_NAMED_TIME) : 0;
  return `${file}.pending-${fixed(named, 13)}-${sessionKey(sessionId)}-${fixed(Math.min(Date.now(), MAX_NAMED_TIME), 13)}-${fixed(process.pid, 10)}-${fixed(parkSequence++ % 1_000_000_000, 9)}-${randomBytes(6).toString("hex")}`;
}

interface ParkedFile { path: string; servedAt: number; key: string }

/** The names in the store's directory. Throws when it exists and cannot be listed. */
function stateNames(file: string): string[] {
  try { return readdirSync(dirname(file)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Parked pin files in name order. Throws when the directory exists and cannot be listed. */
function parkedFiles(file: string, names: readonly string[] = stateNames(file)): ParkedFile[] {
  const prefix = `${basename(file)}.pending-`;
  const found: ParkedFile[] = [];
  for (const name of [...names].sort()) {
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
    const held = pinOf(into, id);
    if (!held || pin.servedAt > held.servedAt) into[id] = pin;
  }
}

function remove(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* a later park or fold deals with it */ }
}

/**
 * Remove parked files of the sessions in `keys`, each only under its session's
 * lock. Every lock is tried once, without waiting; the directory is listed
 * once after that; `choose` then names what to remove from one session's
 * files in that listing. A session is left alone when its lock is busy, when
 * a live reader has announced itself for it, or once the lock is no longer
 * ours. A session's files are removed oldest first.
 *
 * `full` names the one session, if any, that has reached MAX_SESSION_PARKED:
 * for it alone an announced reader does not stop the removal (#186). Its lock
 * is still required.
 */
function removeParked(
  file: string, keys: Iterable<string>, choose: (key: string, files: ParkedFile[]) => ParkedFile[],
  full?: string,
): void {
  const locks = new Map<string, ShimLockRelease>();
  try {
    for (const key of new Set(keys)) {
      const lock = acquireShimLock(parkedLockTarget(file, key), 0);
      if (lock) locks.set(key, lock);
    }
    if (locks.size === 0) return;
    const names = stateNames(file);
    const listed = parkedFiles(file, names);
    for (const [key, lock] of locks) {
      if (key !== full && readerAnnounced(file, key, names)) continue;
      for (const entry of choose(key, listed.filter((entry) => entry.key === key))) {
        if (!lock.held()) break;
        remove(entry.path);
      }
    }
  } finally {
    for (const lock of locks.values()) lock();
  }
}

/**
 * Keep the parked files bounded without the store lock, which a live holder
 * may keep for as long as it runs. Three rules:
 *
 * - One file per session. Of the session's parked pins this writer counts as
 *   valid, the one served latest stays (for equal `servedAt`, the one parked
 *   last) and the rest are removed. A file is removed only while a file that
 *   supersedes it is already published, so the session's latest pin is on
 *   disk throughout.
 * - No expired files. A file whose every pin is past the TTL is removed.
 * - At most MAX_SESSION_PINS files, the bound the store itself keeps. Beyond
 *   it files that a later-named file of the same session supersedes go first,
 *   so a session whose trim was skipped gives up its own surplus before any
 *   session gives up its only pin; then the least recently served, as a store
 *   rewrite does.
 *
 * Every one of these removals goes through removeParked: under the lock of
 * the file's session, and not while a reader of that session has announced
 * itself (#183). A file that cannot be removed now stays for the next parker,
 * so the count can pass MAX_SESSION_PINS by the files of sessions that are
 * being read or trimmed at that moment, and by no other file. How far it can
 * pass is what park() bounds.
 *
 * `full` is set when the writer's own session has reached MAX_SESSION_PARKED:
 * the first rule then applies to it whether or not a reader is announced.
 * Nothing else changes: the same files are chosen, under the same lock.
 */
function trimParked(file: string, sessionId: string, now: number, ttlMs: number, full: boolean): void {
  const key = sessionKey(sessionId);
  const pastTtl = (entry: ParkedFile) => now - entry.servedAt >= ttlMs;
  const expired = (entry: ParkedFile): boolean => {
    if (!pastTtl(entry)) return false;
    let pins: SessionPin[];
    try { pins = Object.values(parseAllPins(readText(entry.path))); } catch { return false; }
    return pins.length > 0 && pins.every((pin) => now - pin.servedAt >= ttlMs);
  };
  const stale = parkedFiles(file).filter(pastTtl).map((entry) => entry.key);
  removeParked(file, [key, ...stale], (session, files) => {
    const gone = new Set(files.filter(expired));
    if (session !== key) return [...gone];
    const mine: { entry: ParkedFile; pin: SessionPin }[] = [];
    for (const entry of files) {
      if (gone.has(entry)) continue;
      let pin: SessionPin | undefined;
      try { pin = pinOf(parsePins(readText(entry.path), now, ttlMs, now + CLOCK_SLACK_MS), sessionId); } catch { continue; }
      if (pin) mine.push({ entry, pin });
    }
    // Name order within one session and one servedAt is park order: >= keeps the last parked.
    const latest = mine.reduce<typeof mine[number] | undefined>(
      (best, each) => !best || each.pin.servedAt >= best.pin.servedAt ? each : best, undefined);
    for (const each of mine) if (each !== latest) gone.add(each.entry);
    return files.filter((entry) => gone.has(entry));
  }, full ? key : undefined);

  const left = parkedFiles(file);
  const over = left.length - MAX_SESSION_PINS;
  if (over > 0) {
    const last = new Map<string, string>();
    for (const entry of left) last.set(entry.key, entry.path);
    const superseded = left.filter((entry) => last.get(entry.key) !== entry.path);
    const only = left.filter((entry) => last.get(entry.key) === entry.path);
    const surplus = new Set(superseded.slice(0, over).map((entry) => entry.path));
    const evicted = new Set(only.slice(0, Math.max(0, over - surplus.size)).map((entry) => entry.path));
    const chosen = [...superseded, ...only].filter((entry) => surplus.has(entry.path) || evicted.has(entry.path));
    removeParked(file, chosen.map((entry) => entry.key), (_session, files) =>
      // A surplus file goes only while a later file of its session is still there.
      files.filter((entry, i) => evicted.has(entry.path) || (surplus.has(entry.path) && i < files.length - 1)));
  }
}

/**
 * Say that a pin was not recorded, on the channel the shim's other notes use
 * (stderr, `[multi-clawd shim] ...`). No session id, account or path is named.
 */
function reportRefusal(why: string): void {
  try { process.stderr.write(`[multi-clawd shim] session pin not recorded: ${why}\n`); }
  catch { /* a failed write must never affect a turn */ }
}

/**
 * Say that a bounded read ended unsettled and returned the latest pin it saw
 * (#189), on the same channel. No session id, account or path is named.
 */
function reportUnsettledRead(): void {
  try {
    process.stderr.write(
      `[multi-clawd shim] session pin read unsettled after ${PARKED_READ_LISTINGS} listings: using the latest pin seen\n`);
  } catch { /* a failed write must never affect a turn */ }
}

/**
 * Park `own` in a file of its own, within two bounds that hold whatever
 * another process holds and however long it is stopped (#186):
 *
 * - one session has at most MAX_SESSION_PARKED parked files;
 * - there are at most MAX_PARKED_FILES parked files in all.
 *
 * The files are counted before anything is written. Under both bounds the
 * park is what it was: publish, then trimParked, best effort, repeated by the
 * next parker. At a bound the trim runs first and the files are counted
 * again, and what gives way is chosen:
 *
 * - The session is at its bound. That takes MAX_SESSION_PARKED parks whose
 *   trim was skipped, which means a reader's marker or the session's lock has
 *   been held across all of them. A marker held that long is a stopped
 *   reader's, and its protection gives way: under the session's lock the
 *   superseded files are removed, the latest pin's file stays, and the pin is
 *   then parked. The read guarantee is what it was for every read during
 *   which fewer than MAX_SESSION_PARKED pins of its session are parked (see
 *   readSessionPin).
 * - The session is still at its bound after that: its lock is held by a
 *   process that is not letting go, and nothing of the session may be removed
 *   without it. The write gives way. It is refused: no file is written, the
 *   session's latest parked pin stays readable, and the refusal is reported.
 * - The total is at its bound after the trim (several sessions' surplus is
 *   behind locks or markers that are not released). The write is refused in
 *   the same way. A reader's protection does not give way for the total.
 *
 * Never: a live holder's lock removed, a file of a session removed without
 * its lock, or another writer's file overwritten. Nothing waits.
 *
 * The count and the publish are not one step, because a park under the bound
 * takes no lock (it must not depend on one that a stopped process may hold).
 * A parker stopped between the two publishes its one file when it resumes. So
 * the exact statement is: MAX_SESSION_PARKED per session and MAX_PARKED_FILES
 * in all, plus at most one file for each parker that was between counting and
 * publishing at that moment. Each parker is a turn that parks once, and the
 * surplus stays without growing until that session's lock is free; the next
 * park then trims it.
 *
 * When the files cannot be counted the write is refused as well: a bound that
 * is not checked is not kept.
 */
function park(file: string, sessionId: string, own: SessionPin, now: number, ttlMs: number): void {
  const key = sessionKey(sessionId);
  const count = () => {
    const all = parkedFiles(file);
    return { session: all.filter((entry) => entry.key === key).length, total: all.length };
  };
  const within = (found: { session: number; total: number }) =>
    found.session < MAX_SESSION_PARKED && found.total < MAX_PARKED_FILES;
  let found: { session: number; total: number };
  try {
    found = count();
    if (!within(found)) {
      try { trimParked(file, sessionId, now, ttlMs, found.session >= MAX_SESSION_PARKED); }
      catch { /* what could not be removed is counted below */ }
      found = count();
    }
  } catch {
    return reportRefusal("its parked pin files could not be counted");
  }
  if (found.session >= MAX_SESSION_PARKED) {
    return reportRefusal(`this session already has ${MAX_SESSION_PARKED} parked pin files and none could be removed`);
  }
  if (found.total >= MAX_PARKED_FILES) {
    return reportRefusal(`${MAX_PARKED_FILES} parked pin files are already waiting and none could be removed`);
  }
  publish(parkedName(file, sessionId, own.servedAt), onePin(sessionId, own));
  try { trimParked(file, sessionId, now, ttlMs, false); }
  catch { /* the pin is parked; bounding is retried by the next parker */ }
}

/** Test seams for a reader's interleavings with parkers and folders. */
interface ReadSessionPinHooks {
  /** Runs after each listing of the session's parked files, before any is opened. */
  afterParkedList?: () => void;
  /** Runs between each parked-pin read and the store read that follows it. */
  afterParked?: () => void;
  /** The clock a read consults when it lists files; Date.now by default. */
  clock?: () => number;
}

/**
 * The session's pin: the store's, or a parked one served later. Parked pins
 * are read before the store because a fold replaces the store before it
 * removes a parked file: a file that vanishes under this read is already in
 * the store this read then opens. Only the session's own parked files are
 * opened, all of them, so what other sessions have parked cannot hide this
 * session's pin. A parker keeps one file per session, so that is normally one
 * file, and a read of it takes no lock and writes nothing.
 *
 * The result is at least as recent as the session's latest valid pin, stored
 * or parked, at the moment the read began, whatever any process holds or
 * however long it stops while the read runs, for every read during which
 * fewer than MAX_SESSION_PARKED pins of its session are parked (#183, #186:
 * the last paragraph but two says why that number). The read itself never
 * waits.
 *
 * How. One listing, every listed file opened, newest first, then the store,
 * is a pass. A pass settles the read when each listed file that was gone on
 * opening is covered: the pass found a pin, parked or stored, served no
 * earlier than that file's. A file removed before the listing is covered by
 * what replaced it, which is listed, or in the store, or was itself evicted.
 * So is a file a fold removed. An uncovered file was removed by a parker
 * whose replacement was published after this pass listed. Listing again
 * cannot be enough: every new park can do the same to the new listing. So
 * the read announces itself (announceReader) and passes again. From then on:
 *
 * - A parker removes files of a session only under that session's lock and,
 *   having taken it, only if no reader is announced. So at most one parker
 *   still removes files of this session: the one that held the lock when the
 *   marker appeared. Every later one removes nothing, whoever holds the lock
 *   and for however long.
 * - That one parker removes what it chose from a single listing, oldest
 *   first. If a pass loses a file to it uncovered, the next pass lists after
 *   that parker did, so the files the parker has yet to remove are listed,
 *   and the newest of them, opened first, covers the others. That pass is
 *   left uncovered only if the parker removes that newest file as well, and
 *   then the parker has nothing left to remove and the pass after settles.
 *
 * So three passes after the marker always include one that settles; the
 * marker is removed on return, and a dead reader's marker by the next parker.
 * The read ends unsettled, with the latest pin it saw, only if the marker
 * cannot be written (the state directory refuses a new file), files are
 * removed by something other than this code, or the session reaches its
 * bound while the read runs, which is the next paragraph. Such a read says so
 * on the shim's stderr channel (#189), naming no session, account or path.
 *
 * A session's files are bounded even while a reader that stopped keeps its
 * marker (#186), so there is one more remover: a parker that finds the
 * session at MAX_SESSION_PARKED files removes the superseded ones under the
 * session's lock, marker or not, and leaves the latest pin's file (park()).
 * That removal leaves one file, so the session is next at its bound only
 * after MAX_SESSION_PARKED - 1 more parks; and a file it takes from a pass
 * was superseded by a file parked after that pass listed. A read that the
 * removals above leave unsettled therefore needs one of these to remove the
 * newest file of a pass after the marker: that file and at least
 * MAX_SESSION_PARKED - 1 parked after it, all parked while the read ran. With
 * fewer, some pass opens the newest file it listed and settles.
 *
 * What ends a pin's life is not this race: a pin past the TTL, a session
 * outside the 1000 most recently served, or a pin more than CLOCK_SLACK_MS
 * ahead of the clock of the writer that rewrites the store is no longer a
 * valid pin, and a read that runs across that moment may return without it.
 *
 * A pin served after the caller's `now` counts: a turn that records a pin
 * while the read runs read its clock later. "Ahead" is measured from the
 * later of `now` and the clock at each listing, so a read that was stopped
 * for longer than the slack still counts the pin that replaced its file.
 */
export function readSessionPin(
  file: string, sessionId: string, now: number, ttlMs: number, hooks: ReadSessionPinHooks = {},
): SessionPin | undefined {
  const key = sessionKey(sessionId);
  const clock = hooks.clock ?? Date.now;
  let parked: SessionPin | undefined;
  let found: SessionPin | undefined;
  let leave: (() => void) | undefined;
  let settled = false;
  try {
    for (let listing = 0; listing < PARKED_READ_LISTINGS; listing++) {
      /** The latest `servedAt` named by a listed file that was gone on opening and would have counted. */
      let lost: number | undefined;
      let latest = Math.max(now, clock()) + CLOCK_SLACK_MS;
      try {
        const mine = parkedFiles(file).filter((entry) => entry.key === key).reverse();
        latest = Math.max(now, clock()) + CLOCK_SLACK_MS;
        hooks.afterParkedList?.();
        for (const { path, servedAt } of mine) {
          let text: string | undefined;
          try { text = readText(path); } catch { continue; /* unreadable: no pin */ }
          if (text === undefined) {
            if (lost === undefined && servedAt <= latest && now - servedAt < ttlMs) lost = servedAt;
            continue;
          }
          const pin = pinOf(parsePins(text, now, ttlMs, latest), sessionId);
          if (pin && (!parked || pin.servedAt > parked.servedAt)) parked = pin;
        }
      } catch { /* the parked files cannot be listed: store only */ }
      hooks.afterParked?.();
      let pins = emptyPins();
      try { pins = parsePins(readText(file), now, ttlMs, latest); } catch { /* unreadable: parked pin only */ }
      if (parked) fold(pins, onePin(sessionId, parked));
      const pin = pinOf(pins, sessionId);
      if (pin && (!found || pin.servedAt >= found.servedAt)) found = pin;
      if (lost === undefined || (found && found.servedAt >= lost)) { settled = true; break; }
      leave ??= announceReader(file, key);
    }
    if (!settled) reportUnsettledRead();
    return found;
  } finally {
    leave?.();
  }
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
      pins = parsePins(readText(file), now, ttlMs, now + CLOCK_SLACK_MS);
      parked = parkedFiles(file).slice(0, MAX_PARKED_PINS);
    } catch { return park(file, sessionId, own, now, ttlMs); }
    const stored = pinOf(pins, sessionId);
    if (!stored || own.servedAt >= stored.servedAt) pins[sessionId] = own;
    const consumed: string[] = [];
    for (const { path } of parked) {
      let text: string | undefined;
      try { text = readText(path); } catch { continue; }
      if (text === undefined) continue;
      fold(pins, parsePins(text, now, ttlMs, now + CLOCK_SLACK_MS));
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
