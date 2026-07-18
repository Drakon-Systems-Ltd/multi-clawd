/**
 * Account-health classification and pool choice for near-limit rotation.
 *
 * Rules (deliberately conservative — rotation must never make things worse):
 * - Missing or stale data is `no_data` and treated as healthy: we only ever
 *   rotate on positive evidence, never on absence of it.
 * - `rejected` with a future reset is `exhausted`; a passed reset un-binds it.
 * - utilization ≥ threshold is `near_limit` — the "nearly maxed out" trigger.
 * - `allowed_warning` alone does NOT rotate: weekly windows warn at low
 *   utilization (observed at 0.3), so status warnings only matter when the
 *   utilization number agrees.
 * - A fully exhausted pool returns no choice: the hook then stays silent and
 *   OpenClaw's reactive chain drops to the next provider (OpenAI → xAI).
 */
import type { AccountHealthState } from "./shim-core.js";

export type HealthVerdict = "ok" | "near_limit" | "exhausted" | "no_data";

export interface AccountHealth {
  verdict: HealthVerdict;
  /** Epoch ms when an exhausted account is expected back. */
  resumeAt?: number;
  reason?: string;
}

export interface HealthOptions {
  /** Rotate when any window's utilization reaches this fraction. Default 0.85. */
  utilizationThreshold?: number;
  /** Ignore state older than this. Default 6 hours. */
  staleAfterMs?: number;
}

const DEFAULT_UTILIZATION_THRESHOLD = 0.85;
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How long a model-scoped rejected window (v0.3.6 reactive 429 capture) stays
 * binding when the error carried no reset time. Conservative: long enough to
 * stop hammering a limited model, short enough to re-probe within the hour.
 */
export const MODEL_REJECTED_TTL_MS = 60 * 60 * 1000;

const MODEL_WINDOW_PREFIX = "model:";

export function classifyAccountHealth(
  state: AccountHealthState | undefined,
  options: HealthOptions,
  nowMs: number,
  requestedModel?: string,
): AccountHealth {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const threshold = options.utilizationThreshold ?? DEFAULT_UTILIZATION_THRESHOLD;

  if (!state?.updatedAt || nowMs - state.updatedAt > staleAfterMs) {
    return { verdict: "no_data" };
  }

  let worst: AccountHealth = { verdict: "ok" };
  for (const [window, w] of Object.entries(state.windows)) {
    // Model-scoped windows (v0.3.6, written from reactive 429 limit errors)
    // gate only requests for that model — exhausted-for-fable must not stop
    // this account serving opus. Without a reset time they bind for a TTL.
    if (window.startsWith(MODEL_WINDOW_PREFIX)) {
      if (!requestedModel || window !== MODEL_WINDOW_PREFIX + requestedModel) continue;
      const resetMs = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined;
      if (w.status !== "rejected") continue;
      if (resetMs !== undefined) {
        if (resetMs > nowMs) {
          return {
            verdict: "exhausted",
            resumeAt: resetMs,
            reason: `${requestedModel} limit rejected until ${new Date(resetMs).toISOString()}`,
          };
        }
        continue; // reset passed — not binding
      }
      if (nowMs - w.seenAt <= MODEL_REJECTED_TTL_MS) {
        return {
          verdict: "exhausted",
          resumeAt: w.seenAt + MODEL_REJECTED_TTL_MS,
          reason: `${requestedModel} limit hit ${Math.round((nowMs - w.seenAt) / 60000)}m ago (no reset time; TTL block)`,
        };
      }
      continue;
    }
    // Windows age individually: now that persisted windows survive across
    // invocations, a fresh five_hour write must not lend credibility to a
    // seven_day entry that is itself stale. Skipped = no positive evidence.
    if (nowMs - w.seenAt > staleAfterMs) continue;
    const resetMs = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined;
    if (w.status === "rejected" && resetMs !== undefined && resetMs > nowMs) {
      return {
        verdict: "exhausted",
        resumeAt: resetMs,
        reason: `${window} rejected until ${new Date(resetMs).toISOString()}`,
      };
    }
    if (
      worst.verdict === "ok" &&
      typeof w.utilization === "number" &&
      w.utilization >= threshold &&
      // A passed reset voids the observation: that utilization belonged to
      // the previous cycle, so it must not keep an account near_limit.
      (resetMs === undefined || resetMs > nowMs)
    ) {
      worst = {
        verdict: "near_limit",
        reason: `${window} utilization ${w.utilization} >= ${threshold}`,
      };
    }
  }
  return worst;
}

/**
 * Pick the account that should serve the next turn, in pool order:
 * healthy/no-data first, then near-limit, never exhausted. Undefined when
 * every account is exhausted — the caller must not override anything then.
 */
export function choosePoolAccount(
  pool: Array<{ id: string; verdict: HealthVerdict }>,
): string | undefined {
  const usable = pool.find((a) => a.verdict === "ok" || a.verdict === "no_data");
  if (usable) return usable.id;
  return pool.find((a) => a.verdict === "near_limit")?.id;
}

/**
 * The account a pooled-backend launch should run on. Unlike choosePoolAccount
 * this always answers: when the whole pool is exhausted the home account is
 * returned anyway, so the launch fails for real and OpenClaw's reactive chain
 * drops to the next provider.
 */
export function pickPoolAccountForLaunch(
  pool: Array<{ id: string; verdict: HealthVerdict }>,
): string {
  return choosePoolAccount(pool) ?? pool[0].id;
}
