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
import { modelWindowKey, type AccountHealthState } from "./shim-core.js";

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

/**
 * Trust ceiling for a reset-bearing window (one carrying a future `resetsAt`).
 * We honour such a window until its own reset regardless of how old its
 * observation is — but no further than this. 8 days = the weekly cap plus a
 * day of slack. A window dropped BY this cap (rather than by its own reset
 * passing) is the alarm case: its `resetsAt` is implausibly far out, which
 * means clock skew or a `resetsAt` parse bug, and we log it distinctly.
 */
export const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

export function classifyAccountHealth(
  state: AccountHealthState | undefined,
  options: HealthOptions,
  nowMs: number,
  requestedModel?: string,
): AccountHealth {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const threshold = options.utilizationThreshold ?? DEFAULT_UTILIZATION_THRESHOLD;

  if (!state) return { verdict: "no_data" };

  // Canonicalised so a window written under `clawd/claude-fable-5` still gates
  // a read requested as `anthropic/claude-fable-5` or bare `claude-fable-5`.
  const requestedWindowKey =
    requestedModel !== undefined ? modelWindowKey(requestedModel) : undefined;

  let worst: AccountHealth = { verdict: "ok" };
  // Whether ANY window still carries live evidence. The whole-account `no_data`
  // gate now derives from this, NOT from a blanket updatedAt staleness: an
  // account idle >6h must stay binding while it holds a live reset-bearing
  // window (weekly / model cap that has not yet reset).
  let hasLiveEvidence = false;
  for (const [window, w] of Object.entries(state.windows)) {
    const resetMs = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined;
    // Reset-bearing = carries a still-future reset. Trusted until that reset
    // regardless of how old the observation is (resets are day-scale, so a 6h
    // idle must not discard a weekly window that has days left to run).
    const resetBearing = resetMs !== undefined && resetMs > nowMs;

    // Bound that trust: a reset-bearing window older than the 8-day horizon is
    // dropped anyway. Reaching the cap (rather than the reset passing) means an
    // implausibly distant resetsAt — clock skew or a parse bug — so alarm on it.
    if (resetBearing && nowMs - w.seenAt > MAX_RESET_HORIZON_MS) {
      console.warn(
        `[multi-clawd] health: window ${window} on ${state.accountId} exceeded 8d ` +
          `reset-horizon cap (resetsAt=${new Date(resetMs).toISOString()}) — ` +
          `possible clock skew / resetsAt parse bug`,
      );
      continue;
    }

    // Model-scoped windows (v0.3.6, written from reactive 429 limit errors)
    // gate only requests for that model — exhausted-for-fable must not stop
    // this account serving opus. They age by their OWN rules (resetsAt, or the
    // MODEL_REJECTED_TTL_MS when reset-less) — NOT the account-level
    // staleAfterMs. Handled before the generic freshness gate so a pool config
    // with staleAfterMs < MODEL_REJECTED_TTL_MS cannot discard a model window
    // that its own TTL still says is binding.
    if (window.startsWith(MODEL_WINDOW_PREFIX)) {
      const modelFresh = resetBearing || nowMs - w.seenAt <= MODEL_REJECTED_TTL_MS;
      if (!modelFresh) continue;
      hasLiveEvidence = true;
      // Canonicalise the STORED key too, not just the requested one: the
      // account-selection path (index.ts readHealthState → classify) reads raw
      // disk state without going through mergeHealthStates, so a legacy
      // stock-v0.3.6 prefixed key (`model:clawd/claude-fable-5`) must still
      // match here or it silently stops gating on that path post-upgrade.
      const canonicalWindow = modelWindowKey(window.slice(MODEL_WINDOW_PREFIX.length));
      if (!requestedWindowKey || canonicalWindow !== requestedWindowKey) continue;
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
      return {
        verdict: "exhausted",
        resumeAt: w.seenAt + MODEL_REJECTED_TTL_MS,
        reason: `${requestedModel} limit hit ${Math.round((nowMs - w.seenAt) / 60000)}m ago (no reset time; TTL block)`,
      };
    }

    // Reset-less account windows keep the existing TTL/decay: aged out by
    // staleAfterMs to no positive evidence. Reset-bearing windows never age
    // out here.
    const fresh = resetBearing || nowMs - w.seenAt <= staleAfterMs;
    if (!fresh) continue;
    hasLiveEvidence = true;

    // Account-level windows gate every model.
    if (w.status === "rejected" && resetBearing) {
      return {
        verdict: "exhausted",
        resumeAt: resetMs,
        reason: `${window} rejected until ${new Date(resetMs!).toISOString()}`,
      };
    }
    if (
      worst.verdict === "ok" &&
      typeof w.utilization === "number" &&
      w.utilization >= threshold &&
      // A passed reset voids the observation: that utilization belonged to the
      // previous cycle. Reset-bearing windows are always current; reset-less
      // (resetMs === undefined) windows count on freshness alone.
      (resetBearing || resetMs === undefined)
    ) {
      worst = {
        verdict: "near_limit",
        reason: `${window} utilization ${w.utilization} >= ${threshold}`,
      };
    }
  }
  // No live reset-bearing window and every reset-less window is stale: nothing
  // to act on. Treated as healthy — we only ever rotate on positive evidence.
  if (worst.verdict === "ok" && !hasLiveEvidence) return { verdict: "no_data" };
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
