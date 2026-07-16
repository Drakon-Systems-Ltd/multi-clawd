/**
 * Pure logic for the claude stream shim: chunk-safe line scanning, tolerant
 * parsing of the CLI's undocumented `rate_limit_event` records, and the
 * per-account health-state shape written for the steering hook to read.
 *
 * Tolerance is the design constraint: this format is CLI-internal (observed
 * fields differ between accounts/versions already), so unknown statuses,
 * window types, and missing fields must pass through without breaking.
 */

export interface RateLimitEvent {
  status: string;
  rateLimitType?: string;
  resetsAt?: number;
  utilization?: number;
  isUsingOverage?: boolean;
}

export interface WindowHealth {
  status: string;
  resetsAt?: number;
  utilization?: number;
  isUsingOverage?: boolean;
  seenAt: number;
}

export interface AccountHealthState {
  accountId: string;
  updatedAt?: number;
  windows: Record<string, WindowHealth>;
}

export interface LineScanner {
  push(chunk: string): void;
  flush(): void;
}

/** Split a stream into lines, surviving lines that span chunk boundaries. */
export function createLineScanner(onLine: (line: string) => void): LineScanner {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

/** Parse one stream line; undefined unless it is a usable rate_limit_event. */
export function parseRateLimitEvent(line: string): RateLimitEvent | undefined {
  if (!line.includes('"rate_limit_event"')) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const r = record as { type?: unknown; rate_limit_info?: unknown };
  if (r.type !== "rate_limit_event") return undefined;
  const info = r.rate_limit_info;
  if (typeof info !== "object" || info === null) return undefined;
  const i = info as Record<string, unknown>;
  if (typeof i.status !== "string" || i.status.length === 0) return undefined;
  return {
    status: i.status,
    rateLimitType: typeof i.rateLimitType === "string" ? i.rateLimitType : undefined,
    resetsAt: typeof i.resetsAt === "number" ? i.resetsAt : undefined,
    utilization: typeof i.utilization === "number" ? i.utilization : undefined,
    isUsingOverage: typeof i.isUsingOverage === "boolean" ? i.isUsingOverage : undefined,
  };
}

/**
 * Tolerantly parse a persisted state file's contents. Undefined when the
 * JSON is unusable; individually malformed windows are dropped, not fatal.
 */
export function parseStoredState(raw: string): AccountHealthState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const p = parsed as { accountId?: unknown; updatedAt?: unknown; windows?: unknown };
  if (typeof p.windows !== "object" || p.windows === null) return undefined;
  const windows: Record<string, WindowHealth> = {};
  for (const [key, value] of Object.entries(p.windows as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const w = value as Record<string, unknown>;
    if (typeof w.status !== "string" || typeof w.seenAt !== "number") continue;
    windows[key] = {
      status: w.status,
      resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : undefined,
      utilization: typeof w.utilization === "number" ? w.utilization : undefined,
      isUsingOverage: typeof w.isUsingOverage === "boolean" ? w.isUsingOverage : undefined,
      seenAt: w.seenAt,
    };
  }
  return {
    accountId: typeof p.accountId === "string" ? p.accountId : "unknown",
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : undefined,
    windows,
  };
}

/**
 * Merge a previously persisted state (`disk`) with this invocation's state
 * (`live`): per window, the newer `seenAt` wins, so a five_hour-only turn can
 * no longer erase the last seven_day observation. `accountId` follows the
 * live process; staleness/expiry is deliberately NOT applied here — the
 * reader (health classification) ages each window by its own `seenAt`.
 */
export function mergeHealthStates(
  disk: AccountHealthState,
  live: AccountHealthState,
): AccountHealthState {
  const windows: Record<string, WindowHealth> = { ...disk.windows };
  for (const [key, w] of Object.entries(live.windows)) {
    const existing = windows[key];
    if (!existing || w.seenAt >= existing.seenAt) windows[key] = w;
  }
  const updatedAt = Math.max(disk.updatedAt ?? 0, live.updatedAt ?? 0);
  return {
    accountId: live.accountId,
    updatedAt: updatedAt > 0 ? updatedAt : undefined,
    windows,
  };
}

/** Fold one event into the account's health state (windows keyed by type). */
export function updateHealthState(
  state: AccountHealthState,
  event: RateLimitEvent,
  now: number,
): AccountHealthState {
  const key = event.rateLimitType ?? "unknown";
  return {
    ...state,
    updatedAt: now,
    windows: {
      ...state.windows,
      [key]: {
        status: event.status,
        resetsAt: event.resetsAt,
        utilization: event.utilization,
        isUsingOverage: event.isUsingOverage,
        seenAt: now,
      },
    },
  };
}
