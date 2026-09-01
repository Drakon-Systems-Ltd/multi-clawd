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

export type HealthVerdict =
  | "ok"
  | "near_limit"
  | "exhausted"
  | "credential_failed"
  | "no_data";

export interface AccountHealth {
  verdict: HealthVerdict;
  /** Epoch ms when an exhausted account is expected back. */
  resumeAt?: number;
  reason?: string;
  /**
   * Set when paid spill-over is nearly spent but real quota is not, i.e. the
   * one case where the pool has deliberately NOT acted and the answer belongs
   * to the owner (#14). The caller surfaces this as an operator alert.
   */
  overageAdvisory?: string;
}

export interface HealthOptions {
  /** Rotate when any window's utilization reaches this fraction. Default 0.85. */
  utilizationThreshold?: number;
  /** Ignore state older than this. Default 6 hours. */
  staleAfterMs?: number;
  /**
   * Treat utilization on the overage window as a reason to rotate, restoring
   * pre-1.7.5 behaviour. Off by default: spending spill-over is a budget
   * decision, so the pool asks rather than assumes (#14).
   */
  rotateOnOverage?: boolean;
}

const DEFAULT_UTILIZATION_THRESHOLD = 0.85;
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How long a model-scoped rejected window (v0.3.6 reactive 429 capture) stays
 * binding when the error carried no reset time. Conservative: long enough to
 * stop hammering a limited model, short enough to re-probe within the hour.
 */
export const MODEL_REJECTED_TTL_MS = 60 * 60 * 1000;

/**
 * How long a runtime credential failure (session_expired / invalid login,
 * captured reactively by the shim — see parseAuthFailure) keeps an account out
 * of pool selection. The bound matters in both directions: long enough that a
 * single dead login cannot consume every clawd/* fallback rung of a run (the
 * #8 trace burned four rungs in seconds), short enough that a login fixed
 * OUT-OF-BAND (`claude auth login` run directly, a token rotated behind a
 * secret ref) is re-probed within the same cadence as the 15-minute login
 * probe instead of staying benched indefinitely. Explicit clears — a
 * successful launch through the shim, or `multi-clawd login <id>` — end the
 * exclusion immediately; this TTL is only the backstop.
 */
export const CREDENTIAL_FAILED_TTL_MS = 15 * 60 * 1000;

/**
 * How long a REJECTION is honoured on the strength of one observation, even
 * when it carries a future `resetsAt` (#11).
 *
 * Reset-bearing windows are trusted until their own reset for freshness — an
 * account idle 6 hours must not lose a weekly window with days left to run.
 * Applying that same trust to a *rejection* was the bug: a single observation
 * benched a whole account for as long as the provider cared to quote. Live case,
 * 9-10 Aug 2026 — claw1 held one `seven_day_overage_included: rejected` seen at
 * 07:32Z with a reset stamp 60 hours out; direct probes returned opus-5
 * successfully throughout, and the pool alarmed "every account is exhausted"
 * with both accounts serving.
 *
 * A quoted reset is the provider's plan, not a contract: limits lift early,
 * overage is granted, plans change. So a rejection ages by its own observation
 * like every other piece of negative evidence here — the same rule
 * CREDENTIAL_FAILED_TTL_MS applies to a dead login, and for the same reason: we
 * do not need to prove the block has lifted, we only need to stop asserting it
 * has not. The next real launch is the probe, and costs nothing when it works.
 *
 * One hour, matching MODEL_REJECTED_TTL_MS: a genuinely exhausted account
 * re-records on its next failed launch (mergeHealthStates keeps the newer
 * `seenAt`), so the ceiling on a real limit is one wasted launch per hour, and
 * the ceiling on a phantom one drops from ~60 hours to one.
 *
 * Scope: ACCOUNT-level windows only. Model-scoped rejections keep their
 * existing rule — the evidence for #11 is account-level (claw1 and claw2, both
 * `seven_day_overage_included`), a model-scoped bench degrades to the next rung
 * of the failover chain rather than costing the account, and shortening it here
 * would reverse fix A on speculation. Widen when a model-scoped phantom is
 * actually observed, not before.
 */
export const REJECTION_REVALIDATE_AFTER_MS = 60 * 60 * 1000;

/**
 * Whether a rejection may still be asserted from the observation we hold, or
 * whether it is old enough that the next launch should find out for itself.
 * Reset-LESS rejections are already bounded by their own TTL at the call sites;
 * this is the bound that reset-bearing ones never had.
 */
function rejectionStillAssertable(seenAt: number, nowMs: number): boolean {
  return nowMs - seenAt <= REJECTION_REVALIDATE_AFTER_MS;
}

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
 * Whether a window measures consumption against allowance PLUS purchased
 * spill-over (`seven_day_overage_included`) rather than the allowance itself.
 *
 * The two diverge widely — 0.96 against 0.75 on one live account — and they
 * answer different questions. "96% of the way through the money I am willing
 * to spend" is a budget fact; "75% of the way through my quota" is a capacity
 * fact. Only the second is a reason for the pool to move work off an account,
 * so utilization on an overage window does not rotate by itself (#14).
 */
export function isOverageWindow(window: string): boolean {
  return /overage/i.test(window);
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

/**
 * How long a reset-LESS rejection blocks, by the period of the window that
 * refused.
 *
 * The block is a guess at "how long until this limit lifts", and one flat hour
 * was the wrong guess for half the windows: right for `five_hour`, badly wrong
 * for the weekly ones, where the real reset can be days out. The account came
 * back at +1h, the pool returned home to a still-limited account, and the turn
 * failed again — so the pool read as not rotating at all (#10).
 *
 * Day-scoped windows therefore block for longer, but deliberately nowhere near
 * their real period: over-benching a recovered account costs live capacity, and
 * a rejection we hold no reset stamp for is exactly the case we are least sure
 * about. Six hours trades roughly six wasted launches a day down to one, while
 * staying an order of magnitude short of the 8-day reset horizon. A fresh
 * observation still displaces it at any time — the block ends on evidence, not
 * only on the clock.
 */
export const PERIOD_RESET_LESS_BLOCK_MS = 6 * 60 * 60 * 1000;

export function resetLessBlockMs(window: string): number {
  return isShortWindow(window) ? MODEL_REJECTED_TTL_MS : PERIOD_RESET_LESS_BLOCK_MS;
}

/**
 * Is this window the account's own allowance, rather than purchased spill-over?
 *
 * `five_hour` and `seven_day` measure the subscription allowance itself, and
 * that allowance is ACCOUNT-wide: when it runs out, the account serves nothing.
 * `seven_day_overage_included` measures a spend budget on top of it, which
 * behaves differently — see the note on `windowAppliesToModel`.
 */
function isAllowanceWindow(window: string): boolean {
  return isPeriodWindow(window) && !isOverageWindow(window);
}

/**
 * Does a window's recorded model (if it has one) apply to this request?
 *
 * A window with no model is legacy or unattributable and stays account-wide,
 * exactly as before 1.7.5. A window that names a model asserts nothing about
 * any other model — including a request that names none, where we cannot show
 * it applies and so must not bench the account (#12).
 *
 * #12's live evidence was an account carrying `seven_day_overage_included:
 * rejected` that kept serving a different model fine, and the scoping was
 * applied to every named period window on the strength of it. That overshot.
 * Measured on claw1, 2026-09-01 (#19): `seven_day: rejected` stamped
 * `claude-sonnet-5`, and `claude-opus-5` requests to the same account came
 * back "You've hit your weekly limit · resets 8pm (UTC)". The classifier
 * called that account `ok` for opus, the pool kept electing it as home, and
 * every non-interactive lane died on "All models failed" while the other
 * account sat idle.
 *
 * So the stamp is scoped by what the window MEASURES, not by whether it has a
 * model: on an allowance window the model records what tripped the limit, not
 * what the limit covers. Erring account-wide is also the safe direction — an
 * over-benched account costs capacity the pool can route around, while an
 * under-benched one costs the turn outright, and any fresh `allowed`
 * observation displaces the bench immediately.
 */
function windowAppliesToModel(
  window: string,
  w: { model?: string },
  requestedWindowKey?: string,
): boolean {
  if (isAllowanceWindow(window)) return true;
  if (w.model === undefined) return true;
  if (requestedWindowKey === undefined) return false;
  return modelWindowKey(w.model) === requestedWindowKey;
}

/**
 * The credential verdict for an account, or undefined when its login is not
 * known-broken (never observed, explicitly cleared, or aged past the TTL).
 *
 * Split out so the pool's "is EVERY member credential-broken?" check can ask
 * the same question the classifier asks, rather than re-deriving it from a
 * verdict that quota rules may have already overwritten.
 */
export function credentialFailureFor(
  state: AccountHealthState | undefined,
  nowMs: number,
): AccountHealth | undefined {
  const credential = state?.credential;
  if (!credential || credential.status !== "failed") return undefined;
  // Positive evidence only, and only while it is fresh: past the TTL the
  // failure stops binding so a fixed login is retried (and, if it is still
  // dead, the very next launch re-records it).
  if (nowMs - credential.seenAt > CREDENTIAL_FAILED_TTL_MS) return undefined;
  return {
    verdict: "credential_failed",
    resumeAt: credential.seenAt + CREDENTIAL_FAILED_TTL_MS,
    reason: `login rejected by the Claude CLI ${Math.round(
      (nowMs - credential.seenAt) / 60000,
    )}m ago${credential.reason ? `: ${credential.reason}` : ""} — re-authenticate this account`,
  };
}

export function classifyAccountHealth(
  state: AccountHealthState | undefined,
  options: HealthOptions,
  nowMs: number,
  requestedModel?: string,
): AccountHealth {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const threshold = options.utilizationThreshold ?? DEFAULT_UTILIZATION_THRESHOLD;

  if (!state) return { verdict: "no_data" };

  // Credential health outranks every quota rule (#8). An account whose OAuth
  // session the CLI has definitively rejected cannot serve ANY model at ANY
  // utilization, so this is checked before the windows are even read — the bug
  // was precisely that quota `allowed` kept re-electing a dead login. Bounded
  // by CREDENTIAL_FAILED_TTL_MS so a login fixed out-of-band re-probes instead
  // of staying benched forever; an explicit clear (successful launch, live
  // probe, re-auth) writes an "ok" record and ends it immediately.
  const credentialFailure = credentialFailureFor(state, nowMs);
  if (credentialFailure) return credentialFailure;

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
  // Highest utilization seen on a spill-over window we declined to rotate on,
  // and on the real-quota windows, so the advisory can quote both (#14).
  let overageUtilization: number | undefined;
  let quotaUtilization: number | undefined;
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
        // NOT bounded by REJECTION_REVALIDATE_AFTER_MS, deliberately — see the
        // constant's note. #11 is evidenced on account-level windows only, and
        // a model-scoped bench degrades to the next rung of the failover chain
        // rather than costing the whole account. Re-validating here would also
        // reverse fix A's earned behaviour (a model cap resetting in 2 days must
        // survive an idle account) on no evidence. The 8-day horizon cap above
        // remains the bound.
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
    //
    // A reset-less period REJECTION ages by its own block instead (#10), for
    // the same reason model windows do: the generic freshness gate runs first,
    // so a pool configured with a staleAfterMs shorter than the block would
    // discard the rejection while its own rule still says the account is
    // limited — silently reinstating the bug the block exists to fix.
    const ownBlockMs =
      w.status === "rejected" && resetMs === undefined && isPeriodWindow(window)
        ? resetLessBlockMs(window)
        : 0;
    const fresh = resetBearing || nowMs - w.seenAt <= Math.max(staleAfterMs, ownBlockMs);
    if (!fresh) continue;
    hasLiveEvidence = true;

    // Account-level windows gate every model — but only NAMED period windows
    // are account-level. `unknown` is where a limit event with no recognisable
    // type lands, and a real one of those was a Fable-only 429; exhausting the
    // account on it strands every other model behind a one-model limit. The
    // reset-less branch below has said so since 1.7.2 — carrying a reset stamp
    // does not make the same event mean something different, so the two
    // branches share the guard.
    // ... and only while the observation is recent enough to still be asserting
    // something about now (#11). Without this bound one rejection benched a
    // healthy account for the whole 60 hours its `resetsAt` claimed.
    if (
      w.status === "rejected" &&
      resetBearing &&
      isPeriodWindow(window) &&
      // Scoped to the model that earned it on a spill-over window (#12); an
      // allowance window is account-wide whatever model tripped it (#19).
      windowAppliesToModel(window, w, requestedWindowKey) &&
      rejectionStillAssertable(w.seenAt, nowMs)
    ) {
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
    if (
      w.status === "rejected" &&
      resetMs === undefined &&
      isPeriodWindow(window) &&
      windowAppliesToModel(window, w, requestedWindowKey) &&
      // The block ends when the BLOCK says so. It used to end whenever the
      // generic staleness gate happened to drop the window, so the bench ran
      // for `staleAfterMs` (6h by default) while `resumeAt` advertised one
      // hour — the duration was an accident of an unrelated knob and the time
      // we reported was not the time we honoured. Now the two agree, and each
      // window's period sets its own (#10).
      nowMs - w.seenAt <= resetLessBlockMs(window)
    ) {
      return {
        verdict: "exhausted",
        resumeAt: w.seenAt + resetLessBlockMs(window),
        reason: `${window} rejected ${Math.round((nowMs - w.seenAt) / 60000)}m ago (no reset time; ${Math.round(resetLessBlockMs(window) / 3600000)}h block)`,
      };
    }
    if (
      typeof w.utilization === "number" &&
      w.utilization >= threshold &&
      // A passed reset voids the observation: that utilization belonged to the
      // previous cycle. Reset-bearing windows are always current; reset-less
      // (resetMs === undefined) windows count on freshness alone.
      (resetBearing || resetMs === undefined)
    ) {
      // The one branch that had no window filter while both its siblings did,
      // so spill-over consumption crossed the same threshold as real quota and
      // drove routing (#14). Record it instead of acting on it; the owner is
      // asked once the loop knows whether real quota agreed.
      if (isOverageWindow(window) && !options.rotateOnOverage) {
        overageUtilization = Math.max(overageUtilization ?? 0, w.utilization);
      } else if (worst.verdict === "ok") {
        worst = {
          verdict: "near_limit",
          reason: `${window} utilization ${w.utilization} >= ${threshold}`,
        };
      }
    }
    if (!isOverageWindow(window) && typeof w.utilization === "number") {
      quotaUtilization = Math.max(quotaUtilization ?? 0, w.utilization);
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
  // Ask only when the answer would actually change something: spill-over is
  // nearly spent AND real quota is not, so the pool is staying put on a
  // judgement the owner may want made differently. If real quota is also over
  // threshold the pool has already rotated and there is nothing to ask.
  if (worst.verdict === "ok" && overageUtilization !== undefined) {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    worst = {
      ...worst,
      overageAdvisory:
        `paid overage is ${pct(overageUtilization)} spent while real quota is at ` +
        `${quotaUtilization !== undefined ? pct(quotaUtilization) : "an unreported level"} — ` +
        `not rotating on spill-over alone. Set pool.rotateOnOverage: true to rotate on it, ` +
        `or leave it to keep using the overage you have paid for.`,
    };
  }
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
 * healthy/no-data first, then near-limit, never exhausted and never
 * credential-broken. Undefined when nothing is usable — the caller must not
 * override anything then.
 *
 * `credential_failed` is unusable in the strongest sense: an exhausted account
 * would at least authenticate, so it stays behind near-limit as a last resort,
 * whereas a rejected login cannot serve a single token. It is therefore in
 * neither pass here.
 */
export function choosePoolAccount(
  pool: Array<{ id: string; verdict: HealthVerdict }>,
): string | undefined {
  const usable = pool.find((a) => a.verdict === "ok" || a.verdict === "no_data");
  if (usable) return usable.id;
  return pool.find((a) => a.verdict === "near_limit")?.id;
}

/**
 * Whether EVERY member's login is known-broken. The one state where a pooled
 * launch has nothing to fall back to and must surface a hard auth error naming
 * re-authentication (#8) instead of relaunching a dead account down every rung.
 * Empty pools are never "all broken".
 */
export function allCredentialFailed(
  pool: Array<{ id: string; verdict: HealthVerdict }>,
): boolean {
  return pool.length > 0 && pool.every((a) => a.verdict === "credential_failed");
}

/**
 * Last-resort account when nothing is usable: the first member that can at
 * least AUTHENTICATE, so an unusable-pool launch fails with the real quota
 * error (which the chain and the degrade ladder both understand) rather than
 * with an auth error from a dead login that a healthier-credentialled member
 * would not have produced. Falls back to the home account when every member is
 * credential-broken — the caller raises the hard auth error in that case.
 */
export function fallbackPoolAccount(
  pool: Array<{ id: string; verdict: HealthVerdict }>,
): string {
  return (pool.find((a) => a.verdict !== "credential_failed") ?? pool[0]).id;
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
  return choosePoolAccount(pool) ?? fallbackPoolAccount(pool);
}
