/**
 * Sticky pool selection (v0.3): once a launch has rotated away from the home
 * account, stay on the rotated-to account for a minimum dwell so back-to-back
 * turns don't flap across the utilization threshold — and so mid-conversation
 * account switches (which cost the Claude CLI its native session) happen at
 * most once per rotation event, not per turn.
 *
 * The one hard rule: HEALTH BEATS STICKINESS. Dwell only ever delays the
 * benign direction (returning home when home has recovered). It never keeps
 * a launch on an account that is near-limit or exhausted while a healthier
 * account exists.
 */
import { choosePoolAccount, type HealthVerdict } from "./health.js";

export interface StickyEntry {
  account: string;
  since: number;
}

export interface StickyDecision {
  account: string;
  /** Sticky entry to persist after this launch; undefined = clear it. */
  sticky?: StickyEntry;
}

export const DEFAULT_MIN_DWELL_MS = 10 * 60 * 1000;

export function decideStickySelection(params: {
  verdicts: Array<{ id: string; verdict: HealthVerdict }>;
  sticky?: StickyEntry;
  nowMs: number;
  minDwellMs?: number;
}): StickyDecision {
  const { verdicts, sticky, nowMs } = params;
  const minDwellMs = params.minDwellMs ?? DEFAULT_MIN_DWELL_MS;
  const home = verdicts[0];
  const healthChoice = choosePoolAccount(verdicts);

  // Whole pool exhausted: home account so the failure is real; nothing to stick to.
  if (!healthChoice) return { account: home.id };

  const stickyVerdict = sticky
    ? verdicts.find((v) => v.id === sticky.account)?.verdict
    : undefined;
  const stickyUsable = stickyVerdict === "ok" || stickyVerdict === "no_data";

  if (sticky && sticky.account !== home.id && stickyUsable) {
    // Home recovered? Only return after the dwell has elapsed.
    const homeUsable = home.verdict === "ok" || home.verdict === "no_data";
    if (homeUsable && nowMs - sticky.since >= minDwellMs) {
      return { account: home.id };
    }
    return { account: sticky.account, sticky };
  }

  // No usable sticky: follow health. Stick only when running away from home.
  if (healthChoice === home.id) return { account: home.id };
  return { account: healthChoice, sticky: { account: healthChoice, since: nowMs } };
}
