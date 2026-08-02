/**
 * Account-health classification and pool choice for near-limit rotation.
 *
 * Rules (deliberately conservative — rotation must never make things worse):
 * - Missing or stale data is `no_data` and treated as healthy: we only ever
 *   rotate on positive evidence, never on absence of it.
 * - `rejected` with a future reset is `exhausted`; a passed reset un-binds it.
 * - utilization ≥ threshold is `near_limit` — the "nearly maxed out" trigger.
 * - `allowed_warning` alone does NOT rotate on a LONG window: weekly windows
 *   warn at low utilization (observed at 0.3), so there the status only
 *   matters when the utilization number agrees.
 * - On a SHORT (hour-scoped) window a warning DOES rotate when it arrives with
 *   no utilization number — see `isShortWindow`. Anthropic ships the 5-hour
 *   window as a bare status, so waiting for a percentage there means waiting
 *   for a percentage that never comes.
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
 * Hour-scoped windows (`five_hour`) versus day-scoped ones (`seven_day`,
 * `seven_day_overage_included`). Matched on the key's own unit segment because
 * the counts are spelled as words, not digits.
 *
 * The distinction earns its keep in one place only: whether a bare
 * `allowed_warning` is worth rotating on. Observed telemetry (both accounts,
 * every observation held since 21 Jul 2026) shows the 5-hour window arriving
 * with a status and a reset time and NEVER a utilization number, while the
 * weekly windows carry a percentage — so a rule that waits for a number can
 * never fire on the session limit. A warning on an hour-scoped window is also
 * a genuine cliff (it resets in hours, not days), whereas the weekly window
 * warns from ~0.3 and would flap.
 */
const SHORT_WINDOW_PATTERN = /(^|_)hours?(_|$)/;

export function isShortWindow(window: string): boolean {
  return SHORT_WINDOW_PATTERN.test(window);
}

/**
 * Whether a window key names a real provider period (`five_hour`,
 * `seven_day`, `seven_day_overage_included`) as opposed to `unknown` — the
 * catch-all the shim writes when a limit event arrives with no recognisable
 * rateLimitType.
 *
 * The distinction matters for reset-less rejections. A live case: a
 * Fable-only 429 landed as `unknown:rejected` with no reset stamp. Treating
 * that as an account-level exhaustion would strand the whole account for a
 * limit that only applied to one model. A named period window carries no such
 * ambiguity — it says which account-level window refused.
 */
const PERIOD_WINDOW_PATTERN = /(^|_)(minutes?|hours?|days?|weeks?|months?)(_|$)/;

export function isPeriodWindow(window: string): boolean {
  return PERIOD_WINDOW_PATTERN.test(window);
}

/**
 * Tolerant warning test. `status` is CLI-internal and undocumented, so match
 * the family (`allowed_warning`, and any future `*_warning`) rather than one
 * exact string — same philosophy as the shim's parsing.
 */
export function isWarningStatus(status: string): boolean {
  return /warning/i.test(status);
}

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
    // A rejection carrying NO reset time used to be ignored entirely — the one
    // record that says "this account just refused a turn" fell through every
    // branch because the field we keyed on was absent. Bind it for the same TTL
    // the model-scoped path uses: long enough to stop hammering a limited
    // account, short enough to re-probe within the hour. Freshness is already
    // established above, so this cannot resurrect an ancient rejection.
    //
    // Named period windows only. `unknown:rejected` stays non-binding: it is
    // where a limit event with no recognisable type lands, and a real one of
    // those was a Fable-only 429 — exhausting the account on it would strand
    // every other model behind a one-model limit.
    if (w.status === "rejected" && resetMs === undefined && isPeriodWindow(window)) {
      return {
        verdict: "exhausted",
        resumeAt: w.seenAt + MODEL_REJECTED_TTL_MS,
        reason: `${window} rejected ${Math.round((nowMs - w.seenAt) / 60000)}m ago (no reset time; TTL block)`,
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
    // Numberless warning on a short window: the only signal the 5-hour session
    // limit ever gives before it bites. Deliberately narrow —
    // - short windows only: the weekly warns from ~0.3 and would flap;
    // - no utilization: when a number IS reported, trust the number, so a
    //   warning at 50% does not rotate just because it is a warning;
    // - same passed-reset void as the utilization branch above: a warning from
    //   a window that has since reset describes the previous cycle.
    if (
      worst.verdict === "ok" &&
      typeof w.utilization !== "number" &&
      isShortWindow(window) &&
      isWarningStatus(w.status) &&
      (resetBearing || resetMs === undefined)
    ) {
      worst = {
        verdict: "near_limit",
        reason: `${window} reported ${w.status} with no utilization — short window, treated as near-limit`,
      };
    }
  }
  // No live reset-bearing window and every reset-less window is stale: nothing
  // to act on. Treated as healthy — we only ever rotate on positive evidence.
  if (worst.verdict === "ok" && !hasLiveEvidence) return { verdict: "no_data" };
  return worst;
}

export interface WindowUsage {
  /** Raw window key as recorded by the shim (e.g. `seven_day`). */
  window: string;
  /** 0..1 fraction of the window consumed. */
  utilization: number;
  /** Epoch ms when the window resets, when the provider sent one. */
  resetsAt?: number;
}

/**
 * Live utilization per window, for display (`explain` / `doctor`). Applies the
 * SAME liveness rules as classifyAccountHealth so the numbers shown are the
 * numbers rotation acts on: a passed reset voids the observation (that
 * utilization belonged to the previous cycle), reset-less windows age out by
 * staleAfterMs, and windows beyond the 8-day reset horizon are dropped.
 * Model-scoped and utilization-less windows are omitted — this is a usage
 * readout, not a health verdict (rejections already surface via the verdict).
 */
export function summarizeWindowUsage(
  state: AccountHealthState | undefined,
  options: HealthOptions,
  nowMs: number,
): WindowUsage[] {
  if (!state) return [];
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const usage: WindowUsage[] = [];
  for (const [window, w] of Object.entries(state.windows)) {
    if (window.startsWith(MODEL_WINDOW_PREFIX)) continue;
    if (typeof w.utilization !== "number") continue;
    const resetMs = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined;
    const resetBearing = resetMs !== undefined && resetMs > nowMs;
    if (resetBearing && nowMs - w.seenAt > MAX_RESET_HORIZON_MS) continue;
    // A passed reset voids the utilization; reset-less counts on freshness alone.
    if (resetMs !== undefined && !resetBearing) continue;
    if (!resetBearing && nowMs - w.seenAt > staleAfterMs) continue;
    usage.push({ window, utilization: w.utilization, resetsAt: resetMs });
  }
  // Longest window first: the weekly number is the one that matters most.
  return usage.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0));
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
