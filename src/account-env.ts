/**
 * Pure account-env construction + token-source validation (v0.3), kept free
 * of SDK imports so the child-env injection contract is unit-testable
 * (Case's gate-2 requirement).
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
