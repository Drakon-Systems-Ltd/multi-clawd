/**
 * Pure account-env construction + token-source validation (v0.3), kept free
 * of SDK imports so the child-env injection contract is unit-testable.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AccountEnvShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Child-process env for one account. Token-file/ref accounts authenticate via
 * env; config-dir accounts rely on the file-based login in that
 * CLAUDE_CONFIG_DIR; native accounts set NEITHER — the child falls back to
 * the default config dir, which is the only mode where the OS keychain login
 * is consulted (macOS).
 */
export function buildAccountChildEnv(
  account: AccountEnvShape,
  token: string | undefined,
  stateFile: string,
): Record<string, string> {
  const env: Record<string, string> = {
    MULTI_CLAWD_ACCOUNT_ID: account.id,
    MULTI_CLAWD_STATE_FILE: stateFile,
  };
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (!account.native && account.configDir) {
    env.CLAUDE_CONFIG_DIR = expandHomePath(account.configDir);
  }
  return env;
}

/**
 * Warn when a plaintext token file is readable beyond its owner.
 *
 * The setup guidance has always said `chmod 600`, but nothing verified it, so
 * a token file left group- or world-readable was consumed in silence. This is
 * advisory ONLY — it must never block a launch: the user's credential is
 * usable, and refusing to run would turn a hygiene problem into an outage on
 * a machine where the file may be perfectly fine (single-user box, restrictive
 * parent directory). Returns the warning text, or undefined when mode is tight.
 *
 * `mode` is the raw `statSync().mode`; only the low 9 permission bits matter.
 */
export function tokenFileModeWarning(path: string, mode: number): string | undefined {
  const perms = mode & 0o777;
  // Anything readable/writable by group or other.
  if ((perms & 0o077) === 0) return undefined;
  return (
    `token file ${path} is mode ${perms.toString(8).padStart(3, "0")} — readable beyond your ` +
    `user account. Anyone with a login on this machine can take the Claude credential. ` +
    `Fix: chmod 600 ${path}`
  );
}

/**
 * Token sources are mutually exclusive per account (native | configDir-login |
 * oauthTokenFile | oauthTokenRef). Returns human-readable warnings; the
 * caller logs them and applies deterministic precedence (file > ref) so a
 * misconfigured account still behaves predictably.
 */
export function validateAccountTokenSources(account: AccountEnvShape): string[] {
  const sources: string[] = [];
  if (account.native) sources.push("native");
  if (account.oauthTokenFile) sources.push("oauthTokenFile");
  if (account.oauthTokenRef) sources.push("oauthTokenRef");
  if (sources.length <= 1) return [];
  return [
    `account "${account.id}" declares ${sources.join(" + ")} — token sources are mutually exclusive; precedence applied is ${sources.includes("native") ? "native" : "oauthTokenFile"} first. Remove the extras.`,
  ];
}
