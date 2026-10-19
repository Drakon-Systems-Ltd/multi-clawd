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
 * A credential failure whose message multi-clawd wrote itself and knows to be
 * free of secret material — the only kind whose text may reach an alert.
 */
export class AccountCredentialError extends Error {
  override name = "AccountCredentialError";
}

/**
 * Operator-safe text for why an account's credential did not resolve. Only
 * messages multi-clawd composed are passed through; a filesystem error is
 * reduced to its code, and anything else (a secret provider's exception may
 * quote what it was handling) to its class name.
 */
export function credentialFailureText(err: unknown): string {
  if (err instanceof AccountCredentialError) return err.message.replace(/^\[multi-clawd\] /, "");
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `credential file unreadable (${code})`;
  const cls = err instanceof Error ? err.constructor.name : typeof err;
  return `credential resolution failed (${cls})`;
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
  const usableToken = token?.trim() ? token : undefined;
  if (usableToken) env.CLAUDE_CODE_OAUTH_TOKEN = usableToken;
  if (!account.native && account.configDir) {
    env.CLAUDE_CONFIG_DIR = expandHomePath(account.configDir);
  }
  // Fail closed. An account that declares a token source is authenticated by
  // that token and nothing else; when resolution yields nothing usable —
  // provider briefly down, empty secret, half-written or malformed file — the
  // launch is refused. Without a configDir the child would quietly use the
  // box's DEFAULT login: a different account's quota, spent under this
  // account's name in telemetry. With a configDir it would use whatever login
  // happens to sit in that dir, which is not the credential the operator
  // declared (a token account's dir is often a never-logged-in harness dir, or
  // holds an older login of another account), so it is no fallback either.
  // Refusing surfaces a resolver problem as a resolver problem; the pool then
  // launches on a sibling and alerts. Native accounts are exempt by
  // definition (their credential IS the default login).
  const declaresToken = Boolean(account.oauthTokenFile) || Boolean(account.oauthTokenRef);
  if (!account.native && declaresToken && !usableToken) {
    throw new AccountCredentialError(
      `[multi-clawd] account "${account.id}" declares a token source but none resolved — ` +
        `refusing to launch it on any other login`,
    );
  }
  return env;
}

/**
 * Outcome of reading an `oauthTokenFile`. Failure reasons never contain any
 * of the file's content: the file may hold a valid token next to the junk.
 */
export type SetupTokenFileRead = { token: string } | { error: string };

/**
 * One whole line shaped like a Claude subscription OAuth token: the
 * `sk-ant-oat<NN>-` family and a base64url body. No length is assumed; the
 * body charset is what keeps `tok,tok` or `tok;junk` from passing as one.
 */
const TOKEN_LINE_RE = /^sk-ant-oat[0-9]{2,}-[A-Za-z0-9_-]+$/;
/** Anywhere in a line — used only to COUNT token-looking runs, never to extract one. */
const TOKEN_ANYWHERE_RE = /sk-ant-oat[0-9]+-/g;

/**
 * Parse the text of a token file. The file must hold exactly one token and
 * nothing else (surrounding blank lines and a trailing newline are fine).
 * Syntactic only: it cannot tell a valid token from a truncated or
 * concatenated one with the same alphabet — the provider decides that.
 *
 * `claude setup-token > file` is the obvious way to fill one and it captures
 * the command's whole screen — sign-in prompts, instructions, the token — so
 * a file holding a valid token plus prose is a common, honest mistake. It is
 * REFUSED rather than mined for the token: that screen is rendered for a
 * terminal and may wrap a long token across lines, so "the one sk-ant-… run in
 * the file" can be a truncated prefix that looks valid and fails at the
 * provider — or, with two runs, the wrong one. Asking the operator to keep the
 * single token line costs a minute once; a guessed credential costs an
 * outage that is hard to diagnose.
 */
export function parseSetupTokenFile(raw: string, label = "token file"): SetupTokenFileRead {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { error: `${label} is empty` };
  if (lines.length === 1 && TOKEN_LINE_RE.test(lines[0])) return { token: lines[0] };
  const runs = lines.reduce((n, l) => n + (l.match(TOKEN_ANYWHERE_RE)?.length ?? 0), 0);
  if (runs === 0) {
    return {
      error:
        `${label} does not contain a setup-token (expected one line: sk-ant-oat01- then letters, ` +
        `digits, - or _)` +
        (lines.length > 1 ? `; it has ${lines.length} lines of other text` : ""),
    };
  }
  return {
    error:
      `${label} has text besides the token (${lines.length} non-empty line(s), ${runs} token-like) — ` +
      `it must hold ONLY the token. This is what \`claude setup-token > file\` produces: it captures the on-screen ` +
      `instructions too. Edit the file down to the single sk-ant-oat01-… line (check it is not ` +
      `wrapped across two lines), keep it chmod 600, and nothing else is needed.`,
  };
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

/**
 * The Claude config dir an account's child actually runs in — where its
 * sessions live. Native accounts and token accounts without a configDir both
 * run in the CLI's default dir (the pool clears any inherited
 * CLAUDE_CONFIG_DIR), so they share it.
 */
export function accountConfigDir(account: AccountEnvShape): string {
  if (!account.native && account.configDir) return expandHomePath(account.configDir);
  return resolve(homedir(), ".claude");
}
