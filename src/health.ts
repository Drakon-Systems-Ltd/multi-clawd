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

export function classifyAccountHealth(
  state: AccountHealthState | undefined,
  options: HealthOptions,
  nowMs: number,
): AccountHealth {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const threshold = options.utilizationThreshold ?? DEFAULT_UTILIZATION_THRESHOLD;

  if (!state?.updatedAt || nowMs - state.updatedAt > staleAfterMs) {
    return { verdict: "no_data" };
  }

  let worst: AccountHealth = { verdict: "ok" };
  for (const [window, w] of Object.entries(state.windows)) {
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
      w.utilization >= threshold
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
