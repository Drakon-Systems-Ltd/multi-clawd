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
