/**
 * In-turn retry after a reactive model limit (#19).
 *
 * The pool picks an account BEFORE spawn, from telemetry already on disk. A
 * limit discovered DURING the launch therefore cannot reach that decision: the
 * shim records it, the turn dies, and the host's fallback chain serves the
 * user from whatever sits at the next rung — routinely a different provider —
 * while a fully-provisioned sibling account sits idle. Rotation lands on the
 * NEXT launch, one turn too late. That is precisely the case the pool exists
 * for, so it is the one case it should not lose.
 *
 * This module holds the pure half of the fix: what the plugin must hand the
 * shim, and whether a given launch may be retried at all. The shim owns the
 * respawn; index.ts owns building the roster.
 *
 * Three deliberate limits, each for a reason that is not a shortcut:
 *
 *   1. A RESUMED LAUNCH ONLY WHEN ITS CONVERSATION CAN FOLLOW IT. A `--resume`
 *      launch names a Claude CLI session that lives in one account's config
 *      dir, and its stdin carries only the new message: re-spawned elsewhere
 *      with nothing else done, it fails to resume or silently drops the
 *      conversation — worse than the bug. The shim can now hand the transcript
 *      over (session-handover.ts), as it stood before the refused attempt
 *      wrote to it, so a resumed launch is armed when that snapshot exists and
 *      is refused exactly as before when it does not (#24).
 *   2. SECRET-FREE SIBLINGS ONLY. Retrying onto a token-bearing account would
 *      mean shipping that account's OAuth token into every child's environment,
 *      so one compromised child sees the whole pool instead of its own login.
 *      A `native` or `configDir` account needs no secret to switch to — just a
 *      path — so those retry and token accounts keep today's next-launch
 *      rotation.
 *   3. ONE RETRY. The second account's own limit is a real answer about the
 *      pool, not something to keep spending turns on.
 */
import {
  classifyAccountHealth,
  overdueProbeAccount,
  type HealthOptions,
  type PoolVerdict,
} from "./health.js";
import { resumeSessionId } from "./session-handover.js";
import type { AccountHealthState } from "./shim-core.js";

/** One sibling the shim may re-spawn onto, as handed over by the plugin. */
export interface RetryAccount {
  id: string;
  /** That account's health-state file, so the retried run records itself correctly. */
  stateFile: string;
  /** Credential env for the account. Secret-free by construction (see #2 above). */
  env: Record<string, string>;
}

export const RETRY_ROSTER_ENV = "MULTI_CLAWD_RETRY_ACCOUNTS";

/**
 * Credential env vars that belong to the account being LEFT. Anything here is
 * cleared before the sibling's own env is applied: a stale CLAUDE_CONFIG_DIR
 * (or a token from a token-based account) would otherwise decide the retry's
 * identity and spend the wrong subscription under the sibling's name.
 */
const CREDENTIAL_ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Tolerant parse of the roster env var — a malformed roster disables retry, never breaks a turn. */
export function parseRetryRoster(raw: string | undefined): RetryAccount[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RetryAccount[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { id?: unknown; stateFile?: unknown; env?: unknown };
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.stateFile !== "string" || !e.stateFile) continue;
    const env: Record<string, string> = {};
    if (e.env && typeof e.env === "object") {
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    out.push({ id: e.id, stateFile: e.stateFile, env });
  }
  return out;
}

export interface RetryArming {
  armed: boolean;
  /** Why not, for the stderr line — a silent no-op is indistinguishable from the bug. */
  reason?: string;
}

/**
 * May THIS launch be retried in-turn? Decided from argv alone, before a byte
 * of output exists, so the shim knows up front whether it must hold the
 * stream's preamble back.
 */
/** Whether argv resumes a session, in any spelling — including an id we would refuse to use. */
export function isResumeLaunch(argv: readonly string[]): boolean {
  return (
    resumeSessionId(argv) !== undefined ||
    argv.some((a) => a === "--resume" || a === "-r" || a.startsWith("--resume="))
  );
}

export function retryArming(
  argv: string[],
  roster: RetryAccount[],
  opts: {
    /**
     * The resumed transcript was snapshotted and can be handed to a sibling.
     * Absent means no: a caller that has not checked gets the refusal.
     */
    resumeReady?: boolean;
  } = {},
): RetryArming {
  if (roster.length === 0) {
    return { armed: false, reason: "no secret-free sibling account to retry onto" };
  }
  if (isResumeLaunch(argv) && !opts.resumeReady) {
    return {
      armed: false,
      reason:
        "resumed session — its transcript is not in this account's config dir in a state " +
        "that can be handed to a sibling",
    };
  }
  // Line-wise classification is only sound on the JSONL stream; in any other
  // output mode the shim cannot tell a limit error from prose and must stay a
  // pure passthrough.
  if (!argv.some((a) => a === "stream-json" || a === "--output-format=stream-json")) {
    return { armed: false, reason: "not a stream-json launch" };
  }
  return { armed: true };
}

/**
 * The sibling to retry onto: roster order (the pool's own preference order),
 * first one whose CURRENT state does not already bar it for this model. The
 * failing account is not in the roster, so it cannot be chosen.
 *
 * With no healthy sibling, a sibling whose rejection is overdue a re-probe is
 * taken instead (#26, see `overdueProbeAccount`). The turn is otherwise lost to
 * the host's chain on the strength of evidence we have already stopped
 * trusting elsewhere; if the sibling really is still limited the user gets its
 * refusal instead of the first account's, which is the same outcome one
 * launch later. Still one retry, still never the refusing account.
 */
export function chooseRetryAccount(params: {
  roster: RetryAccount[];
  readState: (stateFile: string) => AccountHealthState | undefined;
  modelId?: string;
  nowMs: number;
  options?: HealthOptions;
}): RetryAccount | undefined {
  const verdicts: PoolVerdict[] = [];
  for (const account of params.roster) {
    const state = params.readState(account.stateFile);
    const health = classifyAccountHealth(
      state,
      params.options ?? {},
      params.nowMs,
      params.modelId,
    );
    // `no_data` is eligible on purpose: an account that has never run is the
    // normal state of a standby, and refusing it would leave the pool with
    // nothing to fail over to on the very first limit it meets.
    if (health.verdict === "ok" || health.verdict === "no_data") return account;
    verdicts.push({ id: account.id, verdict: health.verdict, observedAt: health.observedAt });
  }
  const probe = overdueProbeAccount(verdicts, params.nowMs);
  return probe ? params.roster.find((a) => a.id === probe) : undefined;
}

/**
 * Environment for the retry child. Starts from this process's env so every
 * unrelated variable (PATH, model override, gateway plumbing) survives, then
 * swaps identity: credentials cleared, the sibling's applied, telemetry
 * pointed at the sibling's own state file, and the roster emptied so the
 * retried run cannot retry again.
 */
export function buildRetryEnv(
  base: NodeJS.ProcessEnv,
  account: RetryAccount,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of CREDENTIAL_ENV_KEYS) delete env[key];
  for (const [k, v] of Object.entries(account.env)) env[k] = v;
  env.MULTI_CLAWD_ACCOUNT_ID = account.id;
  env.MULTI_CLAWD_STATE_FILE = account.stateFile;
  env[RETRY_ROSTER_ENV] = "";
  return env;
}
