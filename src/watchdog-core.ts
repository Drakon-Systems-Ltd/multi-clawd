/**
 * Turn-safe eviction-watchdog decision core (v0.3) — a lane-guard that
 * stops blind restarts eating live chat turns:
 *
 * - An eviction with a turn in flight DEFERS the restart; the pending
 *   eviction is persisted so later ticks re-evaluate (and survive log
 *   rotation).
 * - MAX_DEFER caps deferral: an eviction means Claude backends are already
 *   broken, so protecting a possibly-failing turn forever protects nothing.
 * - RESTART_COOLDOWN keeps back-to-back watchdog restarts apart, on top of
 *   the once-per-eviction lastHandled dedupe.
 * - Missing evidence never restarts anything.
 */

export interface PendingEviction {
  logTimestamp: string;
  firstDeferredAt: number;
  defers: number;
}

export interface WatchdogState {
  lastHandled?: string;
  lastRestartAt?: number;
  pendingEviction?: PendingEviction;
}

export interface WatchdogDecision {
  action: "none" | "defer" | "restart";
  reason: string;
  nextState: WatchdogState;
}

export function decideWatchdogAction(input: {
  /** ISO-prefixed timestamp of the newest eviction log line, if any. */
  evictionTimestamp?: string;
  state: WatchdogState;
  inFlight: boolean;
  nowMs: number;
  maxDeferMs: number;
  restartCooldownMs: number;
}): WatchdogDecision {
  const { state, nowMs } = input;

  // A persisted pending eviction is authoritative even if the log signature
  // has rotated away; otherwise only a signature newer than lastHandled counts.
  const fresh =
    input.evictionTimestamp !== undefined &&
    (state.lastHandled === undefined || input.evictionTimestamp > state.lastHandled);
  const pending = state.pendingEviction;
  if (!fresh && !pending) {
    return { action: "none", reason: "no unhandled eviction", nextState: state };
  }

  const logTimestamp = pending?.logTimestamp ?? input.evictionTimestamp!;
  const firstDeferredAt = pending?.firstDeferredAt;
  const deferCapExceeded =
    firstDeferredAt !== undefined && nowMs - firstDeferredAt >= input.maxDeferMs;

  if (input.inFlight && !deferCapExceeded) {
    return {
      action: "defer",
      reason: "turn in-flight — deferring restart",
      nextState: {
        ...state,
        pendingEviction: {
          logTimestamp,
          firstDeferredAt: firstDeferredAt ?? nowMs,
          defers: (pending?.defers ?? 0) + 1,
        },
      },
    };
  }

  const sinceRestart = nowMs - (state.lastRestartAt ?? 0);
  if (sinceRestart < input.restartCooldownMs) {
    return {
      action: "defer",
      reason: "restart cooldown active",
      nextState: {
        ...state,
        pendingEviction: {
          logTimestamp,
          firstDeferredAt: firstDeferredAt ?? nowMs,
          defers: (pending?.defers ?? 0) + 1,
        },
      },
    };
  }

  return {
    action: "restart",
    reason: deferCapExceeded
      ? `defer cap exceeded after ${pending?.defers ?? 0} deferral(s) — restarting despite in-flight turn`
      : pending
        ? `deferred eviction now safe to handle (${pending.defers} deferral(s))`
        : "eviction detected, no turn in flight",
    nextState: {
      lastHandled: logTimestamp,
      lastRestartAt: nowMs,
    },
  };
}
