/**
 * Spread strategy (#92): place each NEW session on the healthy account that
 * has served the fewest launches recently, so parallel lanes do not all queue
 * behind one account's concurrency ceiling while healthy siblings sit idle.
 *
 * The evidence is the served-launch journal the shim already writes for
 * `explain --history` (#70): one `served` event per spawned child, recorded
 * at spawn time, so launches a few seconds apart see each other. Only a
 * bounded recent window counts (default one hour): the journal itself is
 * size-capped, and a week-old burst must not decide today's placement.
 *
 * Pure: readers hand in the events; nothing here touches disk, so the launch
 * path, the direct route, `explain`, `usage` and `doctor` all rank from the
 * same function and can be tested with fixture events.
 */
import type { HistoryEvent } from "./history.js";
import type { PoolVerdict } from "./health.js";

export const DEFAULT_SPREAD_WINDOW_MS = 60 * 60 * 1000;
/** A window shorter than this would see only the launch in flight. */
export const MIN_SPREAD_WINDOW_MS = 60 * 1000;
/** Longer than the journal can hold at any realistic launch rate. */
export const MAX_SPREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The configured window, clamped; anything unusable means the default. */
export function spreadWindowMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SPREAD_WINDOW_MS;
  return Math.min(MAX_SPREAD_WINDOW_MS, Math.max(MIN_SPREAD_WINDOW_MS, value));
}

export interface SpreadStats {
  /** `served` launches recorded for the account inside the window. */
  servedInWindow: number;
  /** Epoch ms of the newest `served` launch inside the window, if any. */
  lastServedAt?: number;
}

/**
 * Served launches per account inside `[nowMs - windowMs, nowMs]`. Events
 * stamped in the future (a sibling with a faster clock) are ignored rather
 * than counted against an account forever. Retries and rotations are not
 * launches: the retry's own `served` event already counts the hop.
 */
export function spreadStatsFromHistory(
  events: readonly HistoryEvent[],
  nowMs: number,
  windowMs: number = DEFAULT_SPREAD_WINDOW_MS,
): Map<string, SpreadStats> {
  const cutoff = nowMs - windowMs;
  const stats = new Map<string, SpreadStats>();
  for (const event of events) {
    if (event.kind !== "served") continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < cutoff || at > nowMs) continue;
    const current = stats.get(event.accountId) ?? { servedInWindow: 0 };
    current.servedInWindow += 1;
    if (current.lastServedAt === undefined || at > current.lastServedAt) current.lastServedAt = at;
    stats.set(event.accountId, current);
  }
  return stats;
}

/** The stats for one account; an account with no events was never served in the window. */
export function spreadStatsFor(stats: ReadonlyMap<string, SpreadStats>, accountId: string): SpreadStats {
  const s = stats.get(accountId);
  return { servedInWindow: s?.servedInWindow ?? 0, ...(s?.lastServedAt !== undefined ? { lastServedAt: s.lastServedAt } : {}) };
}

/** Verdicts with the spread evidence attached; members without events count as never served. */
export function withSpreadStats<T extends { id: string }>(
  verdicts: readonly T[],
  stats: ReadonlyMap<string, SpreadStats>,
): Array<T & SpreadStats> {
  return verdicts.map((v) => ({ ...v, ...spreadStatsFor(stats, v.id) }));
}

/**
 * Strict "a should be placed before b": fewer served launches first, then
 * the one served least recently (never served beats any time), and a full
 * tie keeps pool order by returning false.
 */
export function spreadBefore(
  a: Pick<PoolVerdict, "servedInWindow" | "lastServedAt">,
  b: Pick<PoolVerdict, "servedInWindow" | "lastServedAt">,
): boolean {
  const served = (a.servedInWindow ?? 0) - (b.servedInWindow ?? 0);
  if (served !== 0) return served < 0;
  return (a.lastServedAt ?? -Infinity) < (b.lastServedAt ?? -Infinity);
}

/** The plain-English reason `explain` gives for a spread placement. */
export function describeSpreadPick(
  picked: Pick<PoolVerdict, "servedInWindow" | "lastServedAt">,
  windowMs: number,
): string {
  const window = describeWindow(windowMs);
  const n = picked.servedInWindow ?? 0;
  if (n === 0) return `not served in the last ${window}`;
  return `fewest served launches in the last ${window} (${n})`;
}

export function describeWindow(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}
