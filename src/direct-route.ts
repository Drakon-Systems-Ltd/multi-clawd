/**
 * The direct Anthropic route (v1.9): pool accounts serving `anthropic/*` too.
 *
 * OpenClaw reaches Claude two ways. The CLI backends this plugin registers
 * drive a Claude Code subprocess per account; the gateway's own `anthropic`
 * provider calls the Messages API directly, authenticated by an `anthropic:*`
 * auth profile. A subscription setup-token (`claude setup-token`) is valid on
 * both, and both spend the SAME account windows — the five-hour and weekly
 * limits the CLI reports in its `rate_limit_event`. So one health file per
 * account can steer both transports.
 *
 * This module is the pure half: which credential an account offers the direct
 * route, what its OpenClaw profile is called, and what order the `anthropic`
 * profiles should be tried in given pool health. IO (the OpenClaw CLI calls
 * that store a profile or set an order) lives in the callers.
 *
 * Nothing here applies to an account without a `direct` key: that is the
 * compatibility contract. A pool whose accounts never opt in behaves exactly
 * as it did before this module existed.
 */
import { isSecretRefShape, type SecretRefShape } from "./token-resolution.js";
import type { HealthVerdict } from "./health.js";
import { decideStickySelection, type StickyEntry } from "./sticky.js";

export const DIRECT_PROVIDER = "anthropic";
export const DIRECT_PROFILE_PREFIX = `${DIRECT_PROVIDER}:`;

/** Per-account opt-in, as written in the plugin config. */
export type DirectConfig =
  | boolean
  | {
      /** Setup-token for the direct route via a gateway secret reference. */
      tokenRef?: Record<string, unknown>;
      /** Setup-token for the direct route in a 0600 file. */
      tokenFile?: string;
      /** OpenClaw auth profile id; default `anthropic:<account id>`. */
      profileId?: string;
    };

export interface DirectAccountShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
  direct?: DirectConfig;
}

export type DirectCredentialSource =
  /** The account never opted in. Nothing about it changes. */
  | { kind: "none" }
  | { kind: "ref"; ref: SecretRefShape; reused: boolean }
  | { kind: "file"; path: string; reused: boolean }
  /** A profile the operator already stored; ordered, never re-written. */
  | { kind: "existing" }
  | { kind: "unsupported"; code: string; reason: string };

/**
 * Why a native or config-dir login can't simply be reused. Stated once so the
 * wizard, doctor and explain all say the same thing.
 */
export const DIRECT_SETUP_TOKEN_GUIDANCE =
  "a native or config-dir Claude login is a rotating single-use OAuth grant — copying it into " +
  "OpenClaw would invalidate one of the two copies on the next refresh. Run `claude setup-token` " +
  "signed in as THIS account, store the printed token in your secret manager (or a 0600 file), " +
  "and set direct.tokenRef (or direct.tokenFile) on the account — or, if a profile for this " +
  'account is already stored in OpenClaw, name it with direct.profileId';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether an account opted into the direct route at all. */
export function directEnabled(account: DirectAccountShape): boolean {
  const d = account.direct;
  if (d === undefined || d === false) return false;
  return true;
}

/**
 * Which setup-token serves this account on the direct route.
 *
 * An explicit `direct.tokenRef` / `direct.tokenFile` always wins. Otherwise
 * `direct: true` reuses the account's own CLI token source — but only when
 * that source IS a setup-token (`oauthTokenRef` / `oauthTokenFile`). A native
 * or config-dir login is never read: its credential lives in Claude's own
 * store as a rotating grant, and this plugin never copies tokens out of it.
 */
export function directCredentialSource(account: DirectAccountShape): DirectCredentialSource {
  if (!directEnabled(account)) return { kind: "none" };
  const explicit = asRecord(account.direct);
  const explicitRef = explicit?.tokenRef;
  const explicitFile = typeof explicit?.tokenFile === "string" ? explicit.tokenFile.trim() : "";
  if (explicitRef !== undefined && explicitFile) {
    return {
      kind: "unsupported",
      code: "direct_sources_conflict",
      reason: "direct.tokenRef and direct.tokenFile are mutually exclusive — keep one",
    };
  }
  if (explicitRef !== undefined) {
    if (!isSecretRefShape(explicitRef)) {
      return {
        kind: "unsupported",
        code: "direct_ref_malformed",
        reason:
          'direct.tokenRef must be { "source": "...", "provider": "...", "id": "..." } like every other secret reference',
      };
    }
    return { kind: "ref", ref: explicitRef, reused: false };
  }
  if (explicitFile) return { kind: "file", path: explicitFile, reused: false };
  // An explicit profileId with no token of its own adopts a profile the
  // operator stored themselves (e.g. with `paste-token`). Checked before the
  // CLI-token reuse below: naming a profile is the more specific instruction.
  if (typeof explicit?.profileId === "string" && explicit.profileId.trim()) {
    return { kind: "existing" };
  }
  if (!account.native) {
    if (account.oauthTokenFile) {
      return { kind: "file", path: account.oauthTokenFile, reused: true };
    }
    if (isSecretRefShape(account.oauthTokenRef)) {
      return { kind: "ref", ref: account.oauthTokenRef, reused: true };
    }
  }
  return {
    kind: "unsupported",
    code: "direct_setup_token_required",
    reason: DIRECT_SETUP_TOKEN_GUIDANCE,
  };
}

const PROFILE_SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/**
 * The OpenClaw auth profile that carries this account's direct credential.
 * Stable (`anthropic:<id>`) so re-running setup/update rewrites the same
 * profile instead of accumulating copies. An override must stay inside the
 * `anthropic` provider — a profile under any other prefix would never be
 * offered to `anthropic/*` turns.
 */
export function directProfileId(account: DirectAccountShape): string {
  const explicit = asRecord(account.direct)?.profileId;
  if (typeof explicit === "string" && explicit.trim()) {
    const id = explicit.trim();
    if (!id.startsWith(DIRECT_PROFILE_PREFIX) || !PROFILE_SUFFIX_RE.test(id.slice(DIRECT_PROFILE_PREFIX.length))) {
      throw new Error(
        `account "${account.id}": direct.profileId must look like "${DIRECT_PROFILE_PREFIX}<name>" (got "${id}")`,
      );
    }
    return id;
  }
  const suffix = account.id.trim();
  if (!PROFILE_SUFFIX_RE.test(suffix)) {
    throw new Error(`account "${account.id}" cannot become an auth profile id — set direct.profileId`);
  }
  return `${DIRECT_PROFILE_PREFIX}${suffix}`;
}

export interface DirectMember {
  accountId: string;
  profileId: string;
  source: DirectCredentialSource;
}

/**
 * The accounts that take part in the direct route, in pool preference order
 * (pool.accounts first, then the rest of accounts[]), plus the ones that
 * asked to and cannot — reported, never silently dropped.
 */
export function collectDirectMembers(
  accounts: readonly DirectAccountShape[],
  poolOrder: readonly string[] = [],
): { members: DirectMember[]; problems: Array<{ accountId: string; code: string; reason: string }> } {
  const ordered: DirectAccountShape[] = [];
  const byId = new Map(accounts.filter((a) => a?.id).map((a) => [a.id.trim(), a]));
  for (const id of poolOrder) {
    const a = byId.get(id);
    if (a && !ordered.includes(a)) ordered.push(a);
  }
  for (const a of byId.values()) if (!ordered.includes(a)) ordered.push(a);

  const members: DirectMember[] = [];
  const problems: Array<{ accountId: string; code: string; reason: string }> = [];
  const seenProfiles = new Set<string>();
  for (const account of ordered) {
    const source = directCredentialSource(account);
    if (source.kind === "none") continue;
    if (source.kind === "unsupported") {
      problems.push({ accountId: account.id, code: source.code, reason: source.reason });
      continue;
    }
    let profileId: string;
    try {
      profileId = directProfileId(account);
    } catch (err) {
      problems.push({ accountId: account.id, code: "direct_profile_invalid", reason: (err as Error).message });
      continue;
    }
    if (seenProfiles.has(profileId)) {
      problems.push({
        accountId: account.id,
        code: "direct_profile_duplicate",
        reason: `profile ${profileId} is already used by another account`,
      });
      continue;
    }
    seenProfiles.add(profileId);
    members.push({ accountId: account.id, profileId, source });
  }
  return { members, problems };
}

/**
 * Rank for the order behind the chosen first profile. An account that can
 * serve comes before one near its limit; an exhausted account still
 * authenticates and so outranks a rejected login. Every managed profile stays
 * in the order: OpenClaw never tries a stored profile that an explicit order
 * omits, so dropping an exhausted account would remove the last resort too.
 */
const VERDICT_RANK: Record<HealthVerdict, number> = {
  ok: 0,
  no_data: 0,
  near_limit: 1,
  exhausted: 2,
  credential_failed: 3,
};

export interface DirectOrderPlan {
  /** Profile ids, managed first (health order), then unmanaged ones as they were. */
  order: string[];
  /** Account whose profile leads the order. */
  firstAccount: string;
  /** Sticky entry to persist; undefined = clear. */
  sticky?: StickyEntry;
  /** Whether `order` differs from `currentOrder`. */
  changed: boolean;
}

/**
 * The `anthropic` profile order that matches pool health right now.
 *
 * The first profile is chosen by exactly the rule the CLI pool uses
 * (decideStickySelection: home first, rotate away on near-limit or
 * exhaustion, dwell before returning home, health beats stickiness), so both
 * transports lean on the same account at the same moment. The rest follow by
 * health rank, ties kept in pool order.
 *
 * Profiles in the current order that this plugin does not manage (a key the
 * operator added by hand) are kept, after the managed ones, in their existing
 * relative order — the plugin rearranges its own accounts and nothing else.
 */
export function planDirectOrder(params: {
  members: Array<{ accountId: string; profileId: string; verdict: HealthVerdict }>;
  currentOrder?: readonly string[];
  sticky?: StickyEntry;
  nowMs: number;
  minDwellMs?: number;
}): DirectOrderPlan | undefined {
  const { members } = params;
  if (members.length === 0) return undefined;
  const decision = decideStickySelection({
    verdicts: members.map((m) => ({ id: m.accountId, verdict: m.verdict })),
    sticky: params.sticky,
    nowMs: params.nowMs,
    minDwellMs: params.minDwellMs,
  });
  const first = members.find((m) => m.accountId === decision.account) ?? members[0];
  const rest = members
    .filter((m) => m !== first)
    .map((m, index) => ({ m, index }))
    .sort((a, b) => VERDICT_RANK[a.m.verdict] - VERDICT_RANK[b.m.verdict] || a.index - b.index)
    .map(({ m }) => m.profileId);
  const managed = new Set(members.map((m) => m.profileId));
  const unmanaged = (params.currentOrder ?? []).filter(
    (id, i, all) => typeof id === "string" && !managed.has(id) && all.indexOf(id) === i,
  );
  const order = [first.profileId, ...rest, ...unmanaged];
  const current = params.currentOrder ?? [];
  const changed = order.length !== current.length || order.some((id, i) => id !== current[i]);
  return { order, firstAccount: first.accountId, sticky: decision.sticky, changed };
}
