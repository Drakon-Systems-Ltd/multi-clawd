import { createHash } from "node:crypto";

export const HERMES_MANAGED_ID_PREFIX = "multi-clawd-";
export const HERMES_MANAGED_SOURCE = "manual:multi-clawd";
export const HERMES_SUPPORTED_STRATEGIES = [
  "fill_first",
  "round_robin",
  "random",
  "least_used",
] as const;
export const HERMES_DEFAULT_STRATEGY = "fill_first";
export const HERMES_MAX_SETUP_TOKEN_BYTES = 8 * 1024;

export type HermesStrategy = (typeof HERMES_SUPPORTED_STRATEGIES)[number];
export type HermesCredentialSourceKind = "oauthTokenFile";

export class HermesAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HermesAdapterError";
  }
}

export interface HermesAccount {
  id: string;
  label?: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export interface HermesUnsupportedAccount {
  id: string;
  code: string;
  reason: string;
}

export interface HermesAccountSet {
  accounts: HermesAccount[];
  unsupported: HermesUnsupportedAccount[];
}

export interface HermesCredentialSource {
  kind: HermesCredentialSourceKind;
  path: string;
}

export interface HermesManagedCredential {
  accountId: string;
  id: string;
  label: string;
  source: typeof HERMES_MANAGED_SOURCE;
  authType: "oauth";
  accessToken: string;
  priority: number;
}

export interface HermesBridgeRequestInput {
  operation: "probe" | "doctor" | "apply";
  targetHome: string;
  strategy?: HermesStrategy;
  dryRun?: boolean;
  credentials?: readonly HermesManagedCredential[];
}

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACCOUNT_RE = PROFILE_RE;
const RESERVED_PROFILES = new Set(["hermes", "test", "tmp", "root", "sudo"]);
// Mirrors scripts/hermes_bridge.py's SETUP_TOKEN_RE: ASCII-only, shaped like
// the current `sk-ant-oat01-...` setup-token family. The version digits are
// intentionally unconstrained beyond "two or more" so a future
// `sk-ant-oat02-...` does not need both sides of the bridge updated in lockstep.
const SETUP_TOKEN_RE = /^sk-ant-oat\d{2,}-[!-~]+$/;
const API_KEY_PREFIX = "sk-ant-api";

/**
 * Only stable `claude setup-token` values are importable. A native or
 * config-dir Claude login stores a rotating OAuth grant whose refresh token is
 * single-use: duplicating it into a second store guarantees that one of the two
 * copies is invalidated on the next refresh.
 *
 * Hermes' own `claude_code` credential source only reads the machine's
 * *native* `~/.claude/.credentials.json` — as of Hermes Agent 0.20.6 there is
 * no way to point it at an arbitrary `configDir`. So a native account needs
 * nothing copied (Hermes already reads the same file multi-clawd's own
 * `"native": true` account uses); a `configDir` account has no Hermes-native
 * equivalent at all and can only reach Hermes via its own `oauthTokenFile`
 * setup token, or by staying OpenClaw-only.
 */
const NATIVE_SETUP_TOKEN_GUIDANCE =
  "add an oauthTokenFile holding a `claude setup-token` value, or let Hermes read the native " +
  "login itself — its own claude_code credential source reads ~/.claude/.credentials.json directly";
const CONFIGDIR_SETUP_TOKEN_GUIDANCE =
  "Hermes' claude_code credential source only reads the native ~/.claude/.credentials.json, never " +
  "an arbitrary configDir, so this account cannot be pointed at Hermes directly — add its own " +
  "oauthTokenFile holding a `claude setup-token` value, or leave it OpenClaw-only";

function fail(code: string, message: string): never {
  throw new HermesAdapterError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNonEmptyString(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) fail(code, "account configuration is malformed");
  return value.trim();
}

export function validateHermesStrategy(value: unknown): HermesStrategy {
  if (typeof value !== "string") {
    fail("invalid_strategy", `strategy must be one of: ${HERMES_SUPPORTED_STRATEGIES.join(", ")}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!(HERMES_SUPPORTED_STRATEGIES as readonly string[]).includes(normalized)) {
    fail("invalid_strategy", `strategy must be one of: ${HERMES_SUPPORTED_STRATEGIES.join(", ")}`);
  }
  return normalized as HermesStrategy;
}

export function validateHermesProfileName(value: unknown): string {
  if (typeof value !== "string") fail("invalid_profile", "profile name is invalid");
  const normalized = value.trim().toLowerCase();
  if (!PROFILE_RE.test(normalized) || (normalized !== "default" && RESERVED_PROFILES.has(normalized))) {
    fail("invalid_profile", "profile name must be a safe Hermes profile identifier");
  }
  return normalized;
}

/**
 * Parse one configured account. Only a structurally broken entry throws — an
 * account that simply cannot be imported into Hermes is reported by
 * {@link describeHermesAccountSupport} so one unusable account never hides the
 * rest of the configured accounts.
 */
export function validateHermesAccount(value: unknown): HermesAccount {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id.trim()) {
    fail("malformed_account", "account configuration is malformed");
  }
  const oauthTokenRef = asRecord(row.oauthTokenRef);
  if (row.oauthTokenRef !== undefined && !oauthTokenRef) {
    fail("malformed_account", "account configuration is malformed");
  }
  return {
    id: row.id.trim().toLowerCase(),
    label: optionalNonEmptyString(row.label, "malformed_account"),
    native: row.native === true || undefined,
    configDir: optionalNonEmptyString(row.configDir, "malformed_account"),
    oauthTokenFile: optionalNonEmptyString(row.oauthTokenFile, "malformed_account"),
    oauthTokenRef,
  };
}

export function describeHermesAccountSupport(
  account: HermesAccount,
): { supported: true } | { supported: false; code: string; reason: string } {
  if (!ACCOUNT_RE.test(account.id)) {
    return {
      supported: false,
      code: "unsupported_account_id",
      reason:
        "account id must be lowercase letters, digits, '_' or '-' (max 64 chars) to become a Hermes credential id",
    };
  }
  if (account.oauthTokenFile) return { supported: true };
  if (account.native) {
    return {
      supported: false,
      code: "native_not_supported",
      reason:
        "a native Claude login is a rotating single-use grant, unsafe to duplicate — " +
        NATIVE_SETUP_TOKEN_GUIDANCE,
    };
  }
  if (account.oauthTokenRef) {
    return {
      supported: false,
      code: "secret_ref_not_supported",
      reason:
        "oauthTokenRef is never resolved here — a secret reference must not be turned into a " +
        `copied plaintext secret; ${NATIVE_SETUP_TOKEN_GUIDANCE}`,
    };
  }
  if (account.configDir) {
    return {
      supported: false,
      code: "setup_token_file_required",
      reason:
        "a configDir login is a rotating single-use grant, unsafe to duplicate, and " +
        CONFIGDIR_SETUP_TOKEN_GUIDANCE,
    };
  }
  return {
    supported: false,
    code: "setup_token_file_required",
    reason: `no importable Hermes credential source — ${NATIVE_SETUP_TOKEN_GUIDANCE}`,
  };
}

/**
 * Split the configured accounts into the importable set and an explicitly
 * reported unsupported set. Every account is inspected so a single bad entry
 * cannot mask the others.
 */
export function collectHermesAccounts(values: unknown): HermesAccountSet {
  if (!Array.isArray(values) || values.length === 0) {
    fail("no_accounts", "no multi-clawd accounts are configured");
  }
  const accounts: HermesAccount[] = [];
  const unsupported: HermesUnsupportedAccount[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const account = validateHermesAccount(value);
    if (seen.has(account.id)) {
      unsupported.push({
        id: account.id,
        code: "duplicate_account",
        reason: "duplicate account id — remove the repeated entry from the OpenClaw config",
      });
      continue;
    }
    seen.add(account.id);
    const support = describeHermesAccountSupport(account);
    if (support.supported) accounts.push(account);
    else unsupported.push({ id: account.id, code: support.code, reason: support.reason });
  }
  return { accounts, unsupported };
}

/**
 * Hermes drains the lowest priority first, so multi-clawd's own preference
 * order (`pool.accounts`, home account first) has to reach the pool. Accounts
 * absent from `pool.accounts` follow in `accounts[]` order.
 */
export function hermesAccountPriorities(
  pluginConfig: unknown,
  accounts: readonly HermesAccount[],
): Map<string, number> {
  const known = new Set(accounts.map((account) => account.id));
  const ordered: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const id = raw.trim().toLowerCase();
    if (!known.has(id) || ordered.includes(id)) return;
    ordered.push(id);
  };
  const config = asRecord(pluginConfig);
  const pools = Array.isArray(config?.pool) ? config.pool : [config?.pool];
  for (const entry of pools) {
    const preference = asRecord(entry)?.accounts;
    if (Array.isArray(preference)) for (const id of preference) push(id);
  }
  for (const account of accounts) push(account.id);
  return new Map(ordered.map((id, index) => [id, index]));
}

export function chooseHermesCredentialSource(
  accountValue: unknown,
  candidates: { oauthTokenFilePath?: string; existingPaths: readonly string[] },
): HermesCredentialSource {
  const account = validateHermesAccount(accountValue);
  const support = describeHermesAccountSupport(account);
  if (!support.supported) fail(support.code, support.reason);
  if (!candidates.oauthTokenFilePath) {
    fail(
      "setup_token_file_required",
      `no importable Hermes credential source — ${NATIVE_SETUP_TOKEN_GUIDANCE}`,
    );
  }
  if (!candidates.existingPaths.includes(candidates.oauthTokenFilePath)) {
    fail("setup_token_file_missing", "the configured oauthTokenFile does not exist");
  }
  return { kind: "oauthTokenFile", path: candidates.oauthTokenFilePath };
}

/**
 * A setup-token file holds exactly one token and nothing else. Anything with
 * whitespace, control characters, several lines, or JSON structure is either a
 * rotating `.credentials.json` grant or a corrupt file — both are refused
 * before a single byte reaches Hermes. The token itself must be ASCII and
 * shaped like the current `sk-ant-oat01-...` setup-token family — an
 * Anthropic API key (`sk-ant-api...`) or anything non-ASCII is refused with
 * its own reason. Diagnostics never echo the contents.
 */
export function parseClaudeSetupToken(text: unknown): string {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > HERMES_MAX_SETUP_TOKEN_BYTES) {
    fail("malformed_setup_token", "the setup-token file is unreadable or too large");
  }
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 1) {
    fail("malformed_setup_token", "the setup-token file must hold exactly one line");
  }
  let token = lines[0];
  if (token.endsWith("\r")) token = token.slice(0, -1);
  if (!token) fail("malformed_setup_token", "the setup-token file is empty");
  if (token.startsWith("{") || token.startsWith("[")) {
    fail(
      "rotating_grant_not_supported",
      "that file holds a JSON Claude credentials grant, not a setup token — rotating grants are " +
        "single-use and unsafe to duplicate. If this is your native ~/.claude login, it needs no " +
        "copy at all — Hermes' own claude_code credential source already reads that file directly. " +
        "A configDir login has no such fallback (claude_code cannot be pointed at a configDir) and " +
        "needs its own oauthTokenFile setup token instead",
    );
  }
  if (token.startsWith(API_KEY_PREFIX)) {
    fail(
      "malformed_setup_token",
      "that looks like a Claude API key, not a setup token — setup tokens start with sk-ant-oat",
    );
  }
  if (!SETUP_TOKEN_RE.test(token)) {
    fail("malformed_setup_token", "the setup token does not match the expected sk-ant-oat… shape");
  }
  return token;
}

export function stableHermesCredentialId(accountId: unknown): string {
  const account = validateHermesAccount({ id: accountId });
  if (!ACCOUNT_RE.test(account.id)) {
    fail("unsupported_account_id", "account id cannot be turned into a Hermes credential id");
  }
  const digest = createHash("sha256").update(`multi-clawd/hermes/${account.id}`, "utf8").digest("hex");
  return `${HERMES_MANAGED_ID_PREFIX}${digest.slice(0, 16)}`;
}

export function buildHermesManagedCredential(
  accountValue: unknown,
  setupToken: string,
  priority: number,
): HermesManagedCredential {
  const account = validateHermesAccount(accountValue);
  if (typeof setupToken !== "string" || !setupToken) {
    fail("malformed_setup_token", "the setup token is missing");
  }
  if (!Number.isSafeInteger(priority) || priority < 0) {
    fail("invalid_priority", "credential priority must be a non-negative integer");
  }
  return {
    accountId: account.id,
    id: stableHermesCredentialId(account.id),
    label: `multi-clawd:${account.id}`,
    source: HERMES_MANAGED_SOURCE,
    authType: "oauth",
    accessToken: setupToken,
    priority,
  };
}

export function buildHermesBridgeRequest(
  input: HermesBridgeRequestInput,
): Record<string, unknown> {
  if (!["probe", "doctor", "apply"].includes(input.operation)) {
    fail("unsupported_operation", "operation must be probe, doctor, or apply");
  }
  if (typeof input.targetHome !== "string" || !input.targetHome) {
    fail("invalid_target_home", "the target Hermes home is invalid");
  }
  const request: Record<string, unknown> = {
    operation: input.operation,
    targetHome: input.targetHome,
  };
  if (input.operation !== "apply") return request;
  request.dryRun = input.dryRun === true;
  request.credentials = (input.credentials ?? []).map((credential) => ({ ...credential }));
  // An omitted strategy must leave Hermes' configured value alone.
  if (input.strategy !== undefined) request.strategy = validateHermesStrategy(input.strategy);
  return request;
}
