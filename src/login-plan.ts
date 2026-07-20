/**
 * Pure planning for `multi-clawd login <account>` — which Claude CLI command
 * to launch, in which config-dir environment, and how to verify afterwards.
 *
 * Invariants:
 * - The human always performs the actual OAuth in the launched interactive
 *   flow; the CLI NEVER captures, stores, or prints a token value.
 * - A native account must target the DEFAULT config dir (CLAUDE_CONFIG_DIR
 *   explicitly cleared — on macOS the keychain is only consulted then).
 * - An isolated-dir account targets ITS dir, created (0700) if missing.
 * - A token account with no dir of its own runs setup-token in a throwaway
 *   scratch dir so the machine's default login is never disturbed.
 */

export interface LoginAccount {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: { provider?: string; [k: string]: unknown };
}

export interface LoginPlan {
  /** argv to launch interactively (stdio inherited). */
  command: string[];
  /** The isolated dir to run under (CLAUDE_CONFIG_DIR), if any. */
  configDir?: string;
  /** Create configDir (mode 0700) before launching. */
  ensureDir?: boolean;
  /** Explicitly strip CLAUDE_CONFIG_DIR so the DEFAULT dir/keychain is used. */
  clearConfigDir: boolean;
  /** Use a throwaway scratch config dir for the run. */
  scratchDir?: boolean;
  /** How to verify success: auth-status (parse logged-in email), token-file
   *  (check the file exists after the human saves it), manual (remind only). */
  verify: "auth-status" | "token-file" | "manual";
  /** Where the human must put the token afterwards (token accounts only). */
  afterNote?: string;
  warn?: string;
}

export function loginPlanForAccount(acc: LoginAccount): LoginPlan {
  if (acc.native) {
    return {
      command: ["claude", "auth", "login"],
      clearConfigDir: true,
      verify: "auth-status",
    };
  }
  if (acc.oauthTokenRef) {
    return {
      command: ["claude", "setup-token"],
      configDir: acc.configDir,
      ensureDir: acc.configDir !== undefined,
      clearConfigDir: false,
      scratchDir: acc.configDir === undefined,
      verify: "manual",
      afterNote:
        `store the printed setup-token in your ${acc.oauthTokenRef.provider ?? "secret"} ` +
        `provider at the item your secret reference points to — the gateway resolves it from there; ` +
        `this tool never touches the token itself`,
      warn:
        acc.configDir === undefined
          ? "this account has no config dir of its own — running in a temporary scratch dir so your default login is untouched"
          : undefined,
    };
  }
  if (acc.oauthTokenFile) {
    return {
      command: ["claude", "setup-token"],
      configDir: acc.configDir,
      ensureDir: acc.configDir !== undefined,
      clearConfigDir: false,
      scratchDir: acc.configDir === undefined,
      verify: "token-file",
      afterNote: `save the printed setup-token to ${acc.oauthTokenFile} and chmod 600 it`,
    };
  }
  // dir-login account: the isolated dir's own stored login IS the credential.
  return {
    command: ["claude", "auth", "login"],
    configDir: acc.configDir,
    ensureDir: true,
    clearConfigDir: false,
    verify: "auth-status",
  };
}
