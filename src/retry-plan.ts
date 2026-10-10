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
 *   2. NO SECRET VALUES IN THE ROSTER. The roster rides in every pooled
 *      launch's environment (the shim's), so a sibling's token value placed
 *      there would put every account's credential in every launch. The roster therefore carries
 *      only what a same-user process could already find in the plugin config:
 *      a config-dir PATH, or a token-file PATH — and the shim removes it from
 *      the env before starting the claude child. (Paths are not isolation: a
 *      same-user process can read a sibling's files. The guarantee is that no
 *      credential VALUE is distributed through the roster.) The shim reads a sibling's
 *      token file only at the moment it retries onto that sibling, and the
 *      value goes into that one child's env and nowhere else. A secret-
 *      reference account (`oauthTokenRef`) has no path to hand over — its
 *      value exists only after the gateway's secret provider resolves it — so
 *      it keeps next-launch rotation. A sibling whose token file does not
 *      yield exactly one token is skipped, never launched on another login
 *      (the 1.7.3 fail-closed rule, applied to the retry).
 *   3. ONE RETRY. The second account's own limit is a real answer about the
 *      pool, not something to keep spending turns on.
 */
import {
  classifyAccountHealth,
  overdueProbeAccount,
  type HealthOptions,
  type PoolVerdict,
} from "./health.js";
import { parseSetupTokenFile } from "./account-env.js";
import { resumeSessionId } from "./session-handover.js";
import type { AccountHealthState } from "./shim-core.js";

/** One sibling the shim may re-spawn onto, as handed over by the plugin. */
export interface RetryAccount {
  id: string;
  /** That account's health-state file, so the retried run records itself correctly. */
  stateFile: string;
  /** Credential env for the account. Secret-free by construction (see #2 above). */
  env: Record<string, string>;
  /**
   * Absolute path of the account's setup-token file, for a token-file account.
   * Read by the shim at retry time only (see #2 above) — never the value.
   */
  tokenFile?: string;
}

/** A roster entry made launchable: its token, when it has one, read and applied. */
export type MaterializedRetry = { account: RetryAccount } | { error: string };

export const RETRY_ROSTER_ENV = "MULTI_CLAWD_RETRY_ACCOUNTS";

/**
 * Credential env vars that belong to the account being LEFT. Anything here is
 * cleared before the sibling's own env is applied: a stale CLAUDE_CONFIG_DIR
 * (or a token from a token-based account) would otherwise decide the retry's
 * identity and spend the wrong subscription under the sibling's name.
 */
const CREDENTIAL_ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The only env a roster entry may carry: a path, never a secret. */
const ROSTER_ENV_KEYS = ["CLAUDE_CONFIG_DIR"];

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
    const e = entry as { id?: unknown; stateFile?: unknown; env?: unknown; tokenFile?: unknown };
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.stateFile !== "string" || !e.stateFile) continue;
    const env: Record<string, string> = {};
    if (e.env && typeof e.env === "object") {
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        // Allow-list: a roster entry may only name a config dir. A token VALUE
        // (or any other variable) handed over anyway is dropped (see #2 above).
        if (typeof v === "string" && ROSTER_ENV_KEYS.includes(k)) env[k] = v;
      }
    }
    const tokenFile = typeof e.tokenFile === "string" && e.tokenFile ? e.tokenFile : undefined;
    out.push({ id: e.id, stateFile: e.stateFile, env, ...(tokenFile ? { tokenFile } : {}) });
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
    return { armed: false, reason: "no sibling account the shim can retry onto" };
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

/**
 * Read a token-file sibling's token, at retry time, into its env. Accounts
 * without a token file pass through unchanged. Failure is a skip for THIS
 * sibling: a declared token that does not resolve must not launch on whatever
 * login its config dir (or the default dir) happens to hold.
 */
export function materializeRetryAccount(
  account: RetryAccount,
  readFile: (path: string) => string,
): MaterializedRetry {
  if (!account.tokenFile) return { account };
  let raw: string;
  try {
    raw = readFile(account.tokenFile);
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { error: `token file unreadable${typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : ""}` };
  }
  const read = parseSetupTokenFile(raw, "token file");
  if ("error" in read) return { error: read.error };
  return {
    account: { ...account, env: { ...account.env, CLAUDE_CODE_OAUTH_TOKEN: read.token } },
  };
}

/**
 * `chooseRetryAccount`, then make the pick launchable; a sibling whose
 * credential cannot be materialized is dropped and the choice re-run over the
 * rest. Each skip is reported (account id and reason only — never content).
 */
export function chooseLaunchableRetryAccount(params: {
  roster: RetryAccount[];
  readState: (stateFile: string) => AccountHealthState | undefined;
  modelId?: string;
  nowMs: number;
  options?: HealthOptions;
  materialize: (account: RetryAccount) => MaterializedRetry;
  onSkip?: (accountId: string, reason: string) => void;
}): RetryAccount | undefined {
  let remaining = params.roster;
  while (remaining.length > 0) {
    const pick = chooseRetryAccount({ ...params, roster: remaining });
    if (!pick) return undefined;
    const ready = params.materialize(pick);
    if ("account" in ready) return ready.account;
    params.onSkip?.(pick.id, ready.error);
    remaining = remaining.filter((a) => a !== pick);
  }
  return undefined;
}
