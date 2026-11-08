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

function parseLines(file: string): HistoryEvent[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((line) => {
    try { const event = valid(JSON.parse(line)); return event ? [event] : []; }
    catch { return []; }
  });
}

/** Events parked by writers that could not take the lock in time (#145). */
function pendingFiles(file: string): string[] {
  const prefix = `${basename(file)}.pending-`;
  try {
    return readdirSync(dirname(file))
      .filter((name) => name.startsWith(prefix) && /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name.slice(prefix.length)))
      .sort()
      .map((name) => join(dirname(file), name));
  } catch { return []; }
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
 * The journal plus any parked events not yet folded, so a reader never misses
 * an event only because its writer lost a lock race. A read that overlaps a
 * fold can see a parked event twice for the moment between the holder's
 * replace and its unlink; the journal itself is never duplicated.
 */
export function readHistory(file: string): HistoryEvent[] {
  return [...parseLines(file), ...pendingFiles(file).flatMap(parseLines)];
}

/**
 * Serialize read/trim/replace under the same advisory lock as health state.
 * A writer that cannot take the lock within its budget never replaces the
 * journal (that could erase another writer's events or exceed the cap) and
 * never drops its event either (#145): it parks the event in a pending file
 * that the next lock holder folds in. Recording never blocks a turn for
 * longer than the lock budget.
 */
export function recordHistory(stateFile: string | undefined, event: HistoryEvent): void {
  if (!stateFile) return;
  let release: (() => void) | undefined;
  try {
    const checked = valid(event);
    if (!checked) return;
    const file = historyFile(stateFile);
    const line = JSON.stringify(checked) + "\n";
    release = acquireShimLock(file);
    if (!release) {
      publish(`${file}.pending-${process.pid}-${randomUUID()}`, line);
      return;
    }
    const parked = pendingFiles(file);
    const events = [...parseLines(file), ...parked.flatMap(parseLines), checked].slice(-HISTORY_MAX_EVENTS);
    let lines = events.map((e) => JSON.stringify(e) + "\n");
    let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    while (bytes > HISTORY_MAX_BYTES && lines.length) bytes -= Buffer.byteLength(lines.shift()!);
    publish(file, lines.join(""));
    // Only after the replace landed: a crash before this point leaves the
    // parked events for the next fold instead of losing them.
    for (const pending of parked) try { unlinkSync(pending); } catch { /* next fold sees it again */ }
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
