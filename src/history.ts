/** Small, private account activity journal shared by concurrent shims. */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireShimLock, type ShimLockRelease } from "./shim-lock.js";

export const HISTORY_FILE = "history.jsonl";
export const HISTORY_MAX_BYTES = 64 * 1024;
export const HISTORY_MAX_EVENTS = 500;
/** Pending files one locked write folds; the rest wait for the next one. */
export const HISTORY_FOLD_MAX = 100;
export type HistoryReason = "model_limit" | "auth_failure" | "transient" | "billing" | "pool_selection";
export type HistoryEvent = {
  at: string;
  kind: "served" | "retry" | "rotation";
  accountId: string;
  toAccountId?: string;
  modelId?: string;
  reason?: HistoryReason;
};

export function historyFile(stateFile: string): string {
  return join(dirname(stateFile), HISTORY_FILE);
}

const safeAccount = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
const safeModel = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: readonly unknown[] = ["served", "retry", "rotation"];
const REASONS: readonly unknown[] = ["model_limit", "auth_failure", "transient", "billing", "pool_selection"];

function valid(raw: unknown): HistoryEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  // Exact primitive values only. Nothing is coerced, so an object that merely
  // prints as an allowed value is rejected and never serialized.
  if (typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) ||
      typeof e.kind !== "string" || !KINDS.includes(e.kind) || !safeAccount(e.accountId) ||
      (e.toAccountId !== undefined && !safeAccount(e.toAccountId)) ||
      (e.reason !== undefined && (typeof e.reason !== "string" || !REASONS.includes(e.reason)))) return undefined;
  // Rebuild from an allowlist, so unknown fields can never enter the journal.
  // The timestamp is rewritten in canonical form: a date string can carry
  // free text and still parse, and every stored line stays a bounded size.
  return { at: new Date(Date.parse(e.at)).toISOString(), kind: e.kind as HistoryEvent["kind"], accountId: e.accountId,
    ...(e.toAccountId ? { toAccountId: e.toAccountId as string } : {}),
    ...(safeModel(e.modelId) ? { modelId: e.modelId } : {}),
    ...(e.reason ? { reason: e.reason as HistoryReason } : {}) };
}

const line = (event: HistoryEvent): string => JSON.stringify(event) + "\n";
const byEventTime = (a: HistoryEvent, b: HistoryEvent): number => Date.parse(a.at) - Date.parse(b.at);
/**
 * One stream in event-time order. The sort is stable, so events with the same
 * timestamp keep the order of the arguments: journal, then parked events in
 * park order, then a new event. The cap applies to this merge, never to a
 * concatenation, so an older batch cannot push out newer events.
 */
const chronological = (...streams: HistoryEvent[][]): HistoryEvent[] => streams.flat().sort(byEventTime);

/**
 * A journal is event lines plus, after a write that folded pending files, one
 * receipt line `{"folded":[ids]}` naming every pending file that write
 * consumed. The receipt is not an event, so the cap never trims it.
 */
function parse(raw: string): { events: HistoryEvent[]; folded: Set<string> } {
  const events: HistoryEvent[] = [];
  const folded = new Set<string>();
  for (const text of raw.split("\n")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; }
    const event = valid(value);
    if (event) { events.push(event); continue; }
    const ids = (value as { folded?: unknown } | null)?.folded;
    if (!Array.isArray(ids)) continue;
    // No write consumes more than HISTORY_FOLD_MAX files, so a longer receipt
    // is not one of ours; honouring it could crowd the events out of the cap.
    for (const id of ids) if (folded.size < HISTORY_FOLD_MAX && typeof id === "string" && UUID.test(id)) folded.add(id);
  }
  return { events, folded };
}

/** Undefined when the file does not exist. Any other read failure throws: unreadable is not empty. */
function readText(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** For readers, which can only do their best with what is readable. */
function readTextOrNothing(file: string): string | undefined {
  try { return readText(file); } catch { return undefined; }
}

/**
 * A reader's copy of the journal: its text, and which file that text came
 * from (inode, change time, size, taken from the same open file). Every
 * write replaces the journal with a new file, so two copies with the same
 * text and the same identity are the same replace, as far as a file system's
 * inode numbers and timestamps can tell.
 */
function journalCopy(file: string): { text: string | undefined; identity: string } {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const { ino, ctimeNs, size } = fstatSync(fd, { bigint: true });
    return { text: readFileSync(fd, "utf8"), identity: `${ino}:${ctimeNs}:${size}` };
  } catch { return { text: undefined, identity: "" }; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } }
}

/**
 * An event parked by a writer that could not take the lock in time (#145).
 * A name is `<park time>-<pid>-<per-process sequence>-<id>`, every part fixed
 * width, so names sort by the wall-clock millisecond the event was parked,
 * then by pid, then by the writer's own sequence. Within one writer that is
 * call order. Across writers inside one millisecond it is only a fixed
 * order. The id is random and identifies the file in a fold receipt.
 */
type Pending = { path: string; id: string };
const PENDING = /^\d{13}-\d{10}-\d{9}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
let parkSequence = 0;

function pendingName(file: string): string {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  return `${file}.pending-${fixed(Date.now(), 13)}-${fixed(process.pid, 10)}-${fixed(parkSequence++ % 1_000_000_000, 9)}-${randomUUID()}`;
}

/** Sorted by name. Throws when the directory exists and cannot be listed. */
function pendingFiles(file: string): Pending[] {
  const prefix = `${basename(file)}.pending-`;
  let names: string[];
  try { names = readdirSync(dirname(file)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.startsWith(prefix)).sort().flatMap((name) => {
    const id = PENDING.exec(name.slice(prefix.length))?.[1];
    return id ? [{ path: join(dirname(file), name), id }] : [];
  });
}

/** The journal's bound: the newest HISTORY_MAX_EVENTS lines within `maxBytes`, given events oldest first. */
function capped(events: HistoryEvent[], maxBytes: number): HistoryEvent[] {
  const kept = events.slice(-HISTORY_MAX_EVENTS);
  let bytes = kept.reduce((sum, event) => sum + Buffer.byteLength(line(event)), 0);
  while (bytes > maxBytes && kept.length) bytes -= Buffer.byteLength(line(kept.shift()!));
  return kept;
}

/** Atomic publish: readers and the folding lock holder see a whole file or none. */
function publish(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  } finally {
    try { unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

/** Test seam: runs between a reader's pending-file read and its journal read. */
interface ReadHistoryHooks {
  afterPending?: () => void;
}

/**
 * The journal plus the parked events no write has consumed yet, inside the
 * journal's own 500-event / 64 KiB bound, oldest first by event time. A
 * reader includes parked events, with one exception: if the journal is
 * replaced during all three of its attempts it returns the last journal
 * alone, which can omit events that are still parked. It never gets back
 * more than the bound however many are parked, and opens at most the 500
 * most recently parked files.
 *
 * A fold replaces the journal, receipt included, before it removes a pending
 * file, and a later write drops a receipt once the files it names are gone.
 * Pending contents are therefore only combined with a journal that was not
 * replaced while they were read: the journal is read before and after them,
 * and the read is repeated unless the two copies have the same text and come
 * from the same file (a replace that restores earlier bytes is still a
 * replace). If the journal was replaced under all three attempts, the last
 * journal is returned on its own. That result is a committed state; under
 * such continuous writes it can omit events that are still parked.
 */
export function readHistory(file: string, hooks: ReadHistoryHooks = {}): HistoryEvent[] {
  let latest: HistoryEvent[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = journalCopy(file);
    let pending: Pending[] = [];
    try { pending = pendingFiles(file).slice(-HISTORY_MAX_EVENTS); } catch { /* journal only */ }
    const parked = pending.map(({ path, id }) => ({ id, events: parse(readTextOrNothing(path) ?? "").events }));
    hooks.afterPending?.();
    const after = journalCopy(file);
    const journal = parse(after.text ?? "");
    latest = journal.events;
    if (before.text !== after.text || before.identity !== after.identity) continue;
    const unfolded = parked.filter(({ id }) => !journal.folded.has(id)).flatMap(({ events }) => events);
    return capped(chronological(journal.events, unfolded), HISTORY_MAX_BYTES);
  }
  return capped(chronological(latest), HISTORY_MAX_BYTES);
}

/**
 * Serialize read/trim/replace under the same advisory lock as health state.
 * A writer that cannot take the lock within its budget never replaces the
 * journal (that could erase another writer's events or exceed the cap) and
 * never drops its event either (#145): it parks the event in a pending file
 * for a later lock holder to fold in. The wait for the lock is bounded by
 * the lock budget. The file work after it is synchronous and has no
 * deadline: one directory listing, and at most HISTORY_FOLD_MAX pending
 * files read and removed per write.
 *
 * A fold is safe to repeat and to interrupt. The journal replace is its
 * commit point, and the replacement carries a receipt naming every pending
 * file the fold consumed. A holder that stops before the replace leaves the
 * journal and the pending files as they were. One that stops after it,
 * before or part-way through removing the files, leaves files the receipt
 * names: later holders keep them in the receipt for as long as they exist,
 * remove them, and never apply them again, whether or not the cap has since
 * trimmed their events from the journal.
 *
 * Nothing unread is replaced, folded or lost. If the journal or the
 * directory cannot be read the writer parks its event and leaves both alone.
 * A pending file that cannot be read is not folded and stays for a later
 * write. A pending file is removed only by a writer that took the lock and
 * found it still its own after its replace, and only once a committed
 * replace names the file in its receipt, which means the writer that first
 * committed its name had read it; a later writer removes such a file without
 * reading it again. That ownership check comes before the removals, not
 * around each one, so the lease limit below applies to them too.
 * Pending files are folded oldest first, so those beyond one write's share
 * wait their turn and the journal's tail stays its newest events. Until a
 * writer takes the lock, pending files accumulate without a bound of their
 * own.
 *
 * Live holders are never reclaimed by age (#151), but a lock can still be
 * replaced externally. Before the replace and before removing files the
 * holder asks whether it still owns this acquisition, and backs off if not.
 * That check does not make the check-and-rename or check-and-remove atomic.
 * A removal is still only of a file a committed receipt names.
 */
export function recordHistory(stateFile: string | undefined, event: HistoryEvent): void {
  if (!stateFile) return;
  let release: ShimLockRelease | undefined;
  try {
    const checked = valid(event);
    if (!checked) return;
    const file = historyFile(stateFile);
    const park = () => publish(pendingName(file), line(checked));
    const lock = release = acquireShimLock(file);
    if (!lock) return park();

    let journal: ReturnType<typeof parse>;
    let pending: Pending[];
    try {
      journal = parse(readText(file) ?? "");
      pending = pendingFiles(file);
    } catch { return park(); }

    // Named by an earlier write's receipt and still here: that write did not
    // get to remove them. They stay consumed and are not read again.
    const consumed = pending.filter(({ id }) => journal.folded.has(id));
    const share = Math.max(0, HISTORY_FOLD_MAX - consumed.length);
    const folded: HistoryEvent[] = [];
    for (const candidate of pending.filter(({ id }) => !journal.folded.has(id)).slice(0, share)) {
      let text: string | undefined;
      try { text = readText(candidate.path); } catch { continue; }
      if (text === undefined) continue;
      folded.push(...parse(text).events);
      consumed.push(candidate);
    }
    const receipt = consumed.length ? JSON.stringify({ folded: consumed.map(({ id }) => id) }) + "\n" : "";
    const events = capped(chronological(journal.events, folded, [checked]), HISTORY_MAX_BYTES - Buffer.byteLength(receipt));
    if (!lock.held()) return park();
    publish(file, receipt + events.map(line).join(""));
    if (!lock.held()) return;
    for (const { path } of consumed) try { unlinkSync(path); } catch { /* the receipt covers it until a later holder removes it */ }
  } catch { /* history cannot affect the launch */ }
  finally { release?.(); }
}

export function parseHistorySince(value: string): number {
  const match = /^(\d+)([dh])$/.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 3650) {
    throw new Error("--since must be a positive duration such as 7d or 24h");
  }
  return Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
}

export function renderHistory(events: HistoryEvent[], accountIds: string[], since: string, nowMs = Date.now()): string {
  const cutoff = nowMs - parseHistorySince(since);
  const recent = events.filter((e) => Date.parse(e.at) >= cutoff && Date.parse(e.at) <= nowMs);
  const ids = [...new Set([...accountIds, ...recent.map((e) => e.accountId)])];
  const lines = [`Account history (last ${since}):`];
  if (!ids.length) return [...lines, "  No accounts configured."].join("\n");
  for (const id of ids) {
    const own = recent.filter((e) => e.accountId === id);
    const count = (kind: HistoryEvent["kind"]) => own.filter((e) => e.kind === kind).length;
    const last = own.filter((e) => e.kind === "served")
      .reduce<string | undefined>((latest, e) => !latest || Date.parse(e.at) > Date.parse(latest) ? e.at : latest, undefined);
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    lines.push(`  ${id}: ${n(count("served"), "served launch", "served launches")}, ${n(count("retry"), "retry", "retries")}, ${n(count("rotation"), "rotation", "rotations")}; last served ${last ?? "never in this window"}`);
  }
  return lines.join("\n");
}
