/** Small, private account activity journal shared by concurrent shims. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireShimLock } from "./shim-lock.js";

export const HISTORY_FILE = "history.jsonl";
export const HISTORY_MAX_BYTES = 64 * 1024;
export const HISTORY_MAX_EVENTS = 500;
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
/**
 * A line on disk: the event plus, for an event that was parked, the random id
 * its writer gave it. The id is what lets a fold apply a parked event exactly
 * once (#145); readers never see it.
 */
type Stored = HistoryEvent & { id?: string };

function valid(raw: unknown): HistoryEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) ||
      !["served", "retry", "rotation"].includes(String(e.kind)) || !safeAccount(e.accountId) ||
      (e.toAccountId !== undefined && !safeAccount(e.toAccountId)) ||
      (e.reason !== undefined && !["model_limit", "auth_failure", "transient", "billing", "pool_selection"].includes(String(e.reason)))) return undefined;
  // Rebuild from an allowlist, so unknown fields can never enter the journal.
  return { at: e.at, kind: e.kind as HistoryEvent["kind"], accountId: e.accountId,
    ...(e.toAccountId ? { toAccountId: e.toAccountId as string } : {}),
    ...(safeModel(e.modelId) ? { modelId: e.modelId } : {}),
    ...(e.reason ? { reason: e.reason as HistoryReason } : {}) };
}

/** A line read back from disk keeps a well-formed parked-event id and nothing else. */
function stored(raw: unknown): Stored | undefined {
  const event = valid(raw);
  const id = (raw as { id?: unknown } | null)?.id;
  return event && typeof id === "string" && UUID.test(id) ? { ...event, id } : event;
}

const line = (event: Stored): string => JSON.stringify(event) + "\n";
const byEventTime = (a: HistoryEvent, b: HistoryEvent): number => Date.parse(a.at) - Date.parse(b.at);

function parseLines(file: string): Stored[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((text) => {
    try { const event = stored(JSON.parse(text)); return event ? [event] : []; }
    catch { return []; }
  });
}

/**
 * Events parked by writers that could not take the lock in time (#145).
 * A name is `<park time>-<pid>-<per-process sequence>-<event id>`, fixed
 * width where it matters, so the sorted list is park order: oldest first
 * across writers, and call order within one writer even inside one
 * millisecond.
 */
const PENDING = /^\d{13}-\d+-\d{9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let parkSequence = 0;

function pendingName(file: string, id: string): string {
  const sequence = String(parkSequence++ % 1_000_000_000).padStart(9, "0");
  return `${file}.pending-${String(Date.now()).padStart(13, "0")}-${process.pid}-${sequence}-${id}`;
}

function pendingFiles(file: string): string[] {
  const prefix = `${basename(file)}.pending-`;
  try {
    return readdirSync(dirname(file))
      .filter((name) => name.startsWith(prefix) && PENDING.test(name.slice(prefix.length)))
      .sort()
      .map((name) => join(dirname(file), name));
  } catch { return []; }
}

/**
 * The newest parked events in event order. At most HISTORY_MAX_EVENTS files
 * are opened: the journal can never hold more than that, so anything parked
 * before them is already outside its bound. The sort is stable, so events
 * with the same timestamp keep park order.
 */
function parkedEvents(files: string[]): Stored[] {
  return files.slice(-HISTORY_MAX_EVENTS).flatMap(parseLines).sort(byEventTime);
}

/**
 * Journal lines followed by the parked events the journal does not hold yet.
 * A parked event whose id is already in the journal was folded by a writer
 * that stopped before it could remove the pending file; it is not applied a
 * second time.
 */
function withParked(journal: Stored[], parked: Stored[]): Stored[] {
  const seen = new Set(journal.map((event) => event.id));
  const fresh = parked.filter((event) => {
    if (!event.id) return true;
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  return [...journal, ...fresh];
}

/** The journal's bound: the newest HISTORY_MAX_EVENTS lines within HISTORY_MAX_BYTES. */
function capped(events: Stored[]): Stored[] {
  const kept = events.slice(-HISTORY_MAX_EVENTS);
  let bytes = kept.reduce((sum, event) => sum + Buffer.byteLength(line(event)), 0);
  while (bytes > HISTORY_MAX_BYTES && kept.length) bytes -= Buffer.byteLength(line(kept.shift()!));
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

/**
 * What the journal will hold after the next locked write, less that writer's
 * own event: the journal plus the parked events it does not hold yet, under
 * the same 500-event / 64 KiB bound, oldest first by event time. A reader
 * therefore never misses an event only because its writer lost a lock race,
 * and never sees more than the documented bound however many are parked.
 *
 * Parked files are read before the journal. A fold replaces the journal
 * before it removes a pending file, so an event that leaves the parked set
 * between the two reads is in the journal read that follows, and one that is
 * in both is matched by id: each event is returned once.
 */
export function readHistory(file: string): HistoryEvent[] {
  const parked = parkedEvents(pendingFiles(file));
  return capped(withParked(parseLines(file), parked))
    .sort(byEventTime)
    .map(({ id, ...event }) => event);
}

/**
 * Serialize read/trim/replace under the same advisory lock as health state.
 * A writer that cannot take the lock within its budget never replaces the
 * journal (that could erase another writer's events or exceed the cap) and
 * never drops its event either (#145): it parks the event, under a fresh id,
 * in a pending file that the next lock holder folds in. Recording never
 * blocks a turn for longer than the lock budget.
 *
 * The fold is safe to repeat. The journal replace is its commit point: a
 * folded line carries the parked event's id, so a holder that stops between
 * the replace and the removal of the pending file leaves a file the next
 * holder recognises and removes without applying it again. A holder that
 * stops before the replace leaves the pending file untouched.
 *
 * Only a lock holder removes pending files, and only after its replace has
 * landed. While no writer can take the lock they accumulate on disk beyond
 * the journal bound; the lock's stale-holder recovery ends that, and the
 * first locked write folds the newest and removes them all. Lines keep
 * commit order on disk, each folded batch in event order.
 */
export function recordHistory(stateFile: string | undefined, event: HistoryEvent): void {
  if (!stateFile) return;
  let release: (() => void) | undefined;
  try {
    const checked = valid(event);
    if (!checked) return;
    const file = historyFile(stateFile);
    release = acquireShimLock(file);
    if (!release) {
      const id = randomUUID();
      publish(pendingName(file, id), line({ ...checked, id }));
      return;
    }
    const pending = pendingFiles(file);
    const events = capped([...withParked(parseLines(file), parkedEvents(pending)), checked]);
    publish(file, events.map(line).join(""));
    for (const parked of pending) try { unlinkSync(parked); } catch { /* the next fold recognises it by id */ }
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
