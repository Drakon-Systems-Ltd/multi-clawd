/**
 * Which real Claude login backs each pool account.
 *
 * Everything else in this plugin talks about accounts by their local id
 * (`claw1`, `claw2`) — deliberately, because ids are safe to log. But an id is
 * a label, not evidence: it says nothing about WHICH subscription the turn
 * actually spends. Two failure modes hide in that gap and both look healthy:
 *
 *   1. Two pool members resolve to the SAME login (a config dir copied from
 *      the default one, a token minted from the same account). Rotation then
 *      "fails over" onto the quota it just exhausted, and every surface —
 *      credentials, telemetry, chain — still says READY.
 *   2. An account silently authenticates as a different login than the
 *      operator believes (a config dir re-logged-in as the wrong user), so
 *      utilization lands on the wrong subscription.
 *
 * The Claude CLI records the authenticated identity in `<config-dir>/.claude.json`
 * under `oauthAccount`, so both are answerable at rest, without spending a turn.
 *
 * Identity is PII, so nothing here decides how to display it: callers pick
 * `describeIdentity(..., { raw })`, and the default is masked because doctor
 * output gets pasted into issues and support threads.
 */

export interface IdentityAccountShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export interface IdentityIo {
  /** Read a file; throws when unreadable. Paths arrive already expanded. */
  readFile: (path: string) => string;
  /** Expand a possibly `~`-relative config dir to an absolute path. */
  expandHome: (path: string) => string;
  /** The config dir a child with no CLAUDE_CONFIG_DIR would use. */
  defaultConfigDir: string;
}

export interface AccountIdentity {
  accountId: string;
  status: "resolved" | "unknown";
  /** Stable per-login id — the field duplicate detection compares. */
  accountUuid?: string;
  email?: string;
  organizationName?: string;
  /** Human plan label ("Max 20x"), derived from the org rate-limit tier. */
  plan?: string;
  /** Where the identity was read from, for "which dir is this?" debugging. */
  source?: string;
  /** Why an identity could not be established. */
  reason?: string;
}

/**
 * The `.claude.json` an account's child process would authenticate against.
 *
 * A token-sourced account (oauthTokenFile / oauthTokenRef) has no such file:
 * its identity lives inside the token, and the only way to learn it is to
 * spend a turn. That is an honest `undefined`, not a failure.
 */
export function identityFilePath(
  account: IdentityAccountShape,
  io: IdentityIo,
): string | undefined {
  const dir =
    !account.native && account.configDir ? io.expandHome(account.configDir) : io.defaultConfigDir;
  if (!dir) return undefined;
  // A token overrides the config dir's own login for the child, so the file
  // would describe an identity that is NOT the one being used. Better to
  // report unknown than to report the wrong login confidently.
  if (account.oauthTokenFile || account.oauthTokenRef) return undefined;
  return `${dir.replace(/\/+$/, "")}/.claude.json`;
}

/**
 * Map the CLI's internal tier strings onto the plan names people actually use.
 * Unknown tiers pass through raw rather than being swallowed — a new tier
 * should show up as itself, not as "unknown".
 */
export function formatPlan(oauthAccount: Record<string, unknown>): string | undefined {
  const tier =
    typeof oauthAccount.organizationRateLimitTier === "string"
      ? oauthAccount.organizationRateLimitTier
      : undefined;
  const type =
    typeof oauthAccount.organizationType === "string" ? oauthAccount.organizationType : undefined;
  const source = tier ?? type;
  if (!source) return undefined;
  const multiplier = source.match(/max_(\d+)x/)?.[1];
  if (multiplier) return `Max ${multiplier}x`;
  if (/max/i.test(source)) return "Max";
  if (/enterprise/i.test(source)) return "Enterprise";
  if (/team/i.test(source)) return "Team";
  if (/pro/i.test(source)) return "Pro";
  if (/free/i.test(source)) return "Free";
  return source;
}

/** Parse one `.claude.json`; undefined when it carries no usable identity. */
export function parseIdentityFile(text: string): Omit<AccountIdentity, "accountId" | "status"> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauthAccount = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== "object") return undefined;
  const account = oauthAccount as Record<string, unknown>;
  const str = (key: string) => (typeof account[key] === "string" ? (account[key] as string) : undefined);
  const identity = {
    accountUuid: str("accountUuid"),
    email: str("emailAddress"),
    organizationName: str("organizationName"),
    plan: formatPlan(account),
  };
  // A record with neither a uuid nor an email identifies nothing.
  if (!identity.accountUuid && !identity.email) return undefined;
  return identity;
}

export function resolveAccountIdentity(
  account: IdentityAccountShape,
  io: IdentityIo,
): AccountIdentity {
  const path = identityFilePath(account, io);
  if (!path) {
    return {
      accountId: account.id,
      status: "unknown",
      reason:
        account.oauthTokenFile || account.oauthTokenRef
          ? "token-sourced login — the identity lives inside the token, not on disk"
          : "no config dir to read",
    };
  }
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    return {
      accountId: account.id,
      status: "unknown",
      reason: `no readable ${path} — this account has never completed a login here`,
      source: path,
    };
  }
  const identity = parseIdentityFile(text);
  if (!identity) {
    return {
      accountId: account.id,
      status: "unknown",
      reason: `${path} carries no oauthAccount record`,
      source: path,
    };
  }
  return { accountId: account.id, status: "resolved", source: path, ...identity };
}

/**
 * `michael@example.com` → `m…l@example.com`. Enough to tell two logins apart
 * at a glance; not enough to identify the operator in a pasted transcript.
 * Single-character local parts are not masked further — there is nothing left
 * to hide, and `…` would only imply detail that is not there.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "…";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}…${domain}`;
  return `${local[0]}…${local[local.length - 1]}${domain}`;
}

/** One-line identity for display. Masked unless the caller asks for raw. */
export function describeIdentity(
  identity: AccountIdentity,
  options: { raw?: boolean } = {},
): string {
  if (identity.status !== "resolved") return identity.reason ?? "identity unknown";
  const who = identity.email
    ? options.raw
      ? identity.email
      : maskEmail(identity.email)
    : options.raw
      ? (identity.accountUuid ?? "unknown login")
      : `login ${identity.accountUuid?.slice(0, 8) ?? "?"}…`;
  const parts = [who];
  if (identity.plan) parts.push(identity.plan);
  // The org name is usually the email again (personal orgs) or the company —
  // identifying either way, so it is raw-only.
  if (options.raw && identity.organizationName) parts.push(identity.organizationName);
  return parts.join(" · ");
}

export interface DuplicateLogin {
  /** The shared login (uuid when known, else the shared email). */
  key: string;
  accountIds: string[];
  email?: string;
}

/**
 * Pool members that are the same login wearing different ids. Compared on
 * `accountUuid` first — an account can change its email, but the uuid is the
 * thing the quota is attached to. Unresolved identities are skipped: absence
 * of evidence is not a duplicate.
 */
export function findDuplicateLogins(identities: AccountIdentity[]): DuplicateLogin[] {
  const groups = new Map<string, { ids: string[]; email?: string }>();
  for (const identity of identities) {
    if (identity.status !== "resolved") continue;
    const key = identity.accountUuid ?? (identity.email ? `email:${identity.email}` : undefined);
    if (!key) continue;
    const group = groups.get(key) ?? { ids: [], email: identity.email };
    group.ids.push(identity.accountId);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.ids.length > 1)
    .map(([key, group]) => ({ key, accountIds: group.ids, email: group.email }));
}
