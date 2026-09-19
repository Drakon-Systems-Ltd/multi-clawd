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
 *   1. FRESH LAUNCHES ONLY. A `--resume` launch names a Claude CLI session
 *      that lives in the PREVIOUS account's config dir (index.ts says so where
 *      it sets reseedFromRawTranscriptWhenUncompacted), and its stdin carries
 *      only the new message. Re-spawning it elsewhere either fails to resume
 *      or silently drops the conversation — worse than the bug. The gateway's
 *      own fresh-session recovery already covers that path.
 *   2. SECRET-FREE SIBLINGS ONLY. Retrying onto a token-bearing account would
 *      mean shipping that account's OAuth token into every child's environment,
 *      so one compromised child sees the whole pool instead of its own login.
 *      A `native` or `configDir` account needs no secret to switch to — just a
 *      path — so those retry and token accounts keep today's next-launch
 *      rotation.
 *   3. ONE RETRY. The second account's own limit is a real answer about the
 *      pool, not something to keep spending turns on.
 */
import { classifyAccountHealth, type HealthOptions } from "./health.js";
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
export function retryArming(argv: string[], roster: RetryAccount[]): RetryArming {
  if (roster.length === 0) {
    return { armed: false, reason: "no secret-free sibling account to retry onto" };
  }
  if (argv.includes("--resume")) {
    return {
      armed: false,
      reason: "resumed session — its Claude session lives in this account's config dir",
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
 */
export function chooseRetryAccount(params: {
  roster: RetryAccount[];
  readState: (stateFile: string) => AccountHealthState | undefined;
  modelId?: string;
  nowMs: number;
  options?: HealthOptions;
}): RetryAccount | undefined {
  for (const account of params.roster) {
    const state = params.readState(account.stateFile);
    const verdict = classifyAccountHealth(
      state,
      params.options ?? {},
      params.nowMs,
      params.modelId,
    ).verdict;
    // `no_data` is eligible on purpose: an account that has never run is the
    // normal state of a standby, and refusing it would leave the pool with
    // nothing to fail over to on the very first limit it meets.
    if (verdict === "ok" || verdict === "no_data") return account;
  }
  return undefined;
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
