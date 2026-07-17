/**
 * Login-health classification (v0.3): registration success must stop masking
 * dead logins. This checks that each account's credential *source* actually
 * holds something plausible — it does not spend quota on live probes.
 *
 * Observed failure this guards against (aiquant, 2026-07-15): native
 * credentials went blank while the backend still registered fine, so every
 * turn failed "Not logged in" with no operator-visible warning.
 */

export interface CredentialAccountShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export interface CredentialIo {
  /** Read a file (path already account-appropriate); throws when unreadable. */
  readFile: (path: string) => string;
  /** macOS: whether the "Claude Code-credentials" keychain item exists. */
  keychainHasClaudeCredentials: () => boolean;
  platform: NodeJS.Platform;
}

export interface CredentialCheck {
  status: "ok" | "broken" | "unknown";
  reason?: string;
}

/**
 * Ref-resolution outcome as classified by token-resolution's resolveDetailed.
 * (Mirrored here rather than imported to keep this module dependency-free.)
 */
export interface RefProbeResult {
  value?: string;
  failure?: "provider_error" | "empty_result";
}

export interface RefProbeStatus {
  status: "ok" | "degraded" | "broken";
  reason?: string;
}

export interface RefProbeTracker {
  observe(result: RefProbeResult, nowMs: number): RefProbeStatus;
}

/**
 * Pure per-account state machine for the async oauthTokenRef probe: it
 * separates a transient provider outage (timeout/network → degrade, retry)
 * from a real credential problem (resolver ran, got nothing → broken now).
 *
 * - empty_result → broken immediately (a credential problem, not a blip).
 * - provider_error → DEGRADED and retried; only declared broken after
 *   `deadAfterConsecutive` consecutive provider errors AND at least
 *   `deadAfterMs` elapsed since the first failure of the streak (both, so a
 *   burst of fast failures cannot trip a false "login dead" alert).
 * - a resolved value resets the streak and clears the degraded flag.
 */
export function createRefProbeTracker(
  options: { deadAfterConsecutive?: number; deadAfterMs?: number } = {},
): RefProbeTracker {
  const deadAfterConsecutive = options.deadAfterConsecutive ?? 3;
  const deadAfterMs = options.deadAfterMs ?? 10 * 60 * 1000;
  let consecutive = 0;
  let firstFailureAt: number | undefined;

  return {
    observe(result, nowMs) {
      if (result.value !== undefined) {
        consecutive = 0;
        firstFailureAt = undefined;
        return { status: "ok" };
      }
      if (result.failure === "empty_result") {
        consecutive = 0;
        firstFailureAt = undefined;
        return {
          status: "broken",
          reason: "oauthTokenRef resolved to nothing (credential problem)",
        };
      }
      // provider_error (or an unknown/absent failure treated as transient)
      if (consecutive === 0) firstFailureAt = nowMs;
      consecutive += 1;
      const elapsed = nowMs - (firstFailureAt ?? nowMs);
      if (consecutive >= deadAfterConsecutive && elapsed >= deadAfterMs) {
        return {
          status: "broken",
          reason: `resolver failing ${deadAfterConsecutive}+ consecutive probes over ${Math.round(
            deadAfterMs / 60000,
          )}m`,
        };
      }
      return {
        status: "degraded",
        reason: `resolver error (network?) — streak ${consecutive}/${deadAfterConsecutive}`,
      };
    },
  };
}

function looksLikeSetupToken(value: string): boolean {
  return /^sk-ant-[a-z0-9]+-/.test(value.trim());
}

function checkCredentialsJson(io: CredentialIo, dir: string): CredentialCheck {
  let raw: string;
  try {
    raw = io.readFile(`${dir}/.credentials.json`);
  } catch {
    return { status: "broken", reason: `${dir}/.credentials.json unreadable` };
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.trim().length > 0) return { status: "ok" };
    return { status: "broken", reason: `${dir}/.credentials.json access token is blank` };
  } catch {
    return { status: "broken", reason: `${dir}/.credentials.json is not valid JSON` };
  }
}

export function checkAccountCredential(
  account: CredentialAccountShape,
  io: CredentialIo,
): CredentialCheck {
  if (account.oauthTokenFile) {
    let raw: string;
    try {
      raw = io.readFile(account.oauthTokenFile);
    } catch {
      return { status: "broken", reason: `${account.oauthTokenFile} unreadable` };
    }
    if (looksLikeSetupToken(raw)) return { status: "ok" };
    return {
      status: "broken",
      reason: `${account.oauthTokenFile} does not contain a setup-token`,
    };
  }
  if (account.oauthTokenRef) {
    // Refs are validated by the async resolver path; sync check can't see them.
    return { status: "unknown" };
  }
  if (account.native) {
    if (io.platform === "darwin") {
      return io.keychainHasClaudeCredentials()
        ? { status: "ok" }
        : { status: "broken", reason: "keychain has no Claude Code credentials" };
    }
    return checkCredentialsJson(io, "~/.claude");
  }
  if (account.configDir) {
    return checkCredentialsJson(io, account.configDir);
  }
  return { status: "unknown" };
}
