/**
 * CLI history identity (#23): give OpenClaw core a stable owner for each
 * backend this plugin registers, so core's CLI history boundary can bind.
 *
 * What core does (read from the 2026.9.6 dist, `prepare.runtime-*.mjs`):
 * before every CLI run `prepareCliRunContextWithinReadFence` resolves an
 * `authCredential` from ITS OWN auth-profile store — never from anything the
 * backend returns — and hands it to `prepareCliHistoryBoundary(params,
 * { credential })`. That function derives the history OWNER only from a
 * credential of type `oauth` with an `accountId` or `email` (or a static
 * `api_key` / `token`). No owner → no boundary → `rawTranscriptReseedReason`
 * is `"auth-unknown"` → `loadCliSessionPromptContext` logs
 * `cli session history refused across auth boundary: reason=auth-unknown`
 * and refuses to reseed history into a fresh CLI session.
 *
 * Our accounts are Claude Code logins in their own config dirs, not OpenClaw
 * auth profiles, so `authCredential` was always undefined for `claw1/*`,
 * `claw2/*` and `clawd/*` runs. Every turn that could not `--resume` its CLI
 * session therefore started with NO prior context.
 *
 * The seam: `CliBackendPlugin.defaultAuthProfileId` ("Preferred auth-profile
 * id when the caller did not explicitly lock one"). Core looks that id up
 * directly — `authCredential = authStore.profiles[effectiveAuthProfileId]` —
 * with no eligibility filter, and for a plugin backend it never materializes,
 * refreshes or uses the credential: `resolveBundledCliBackendAuthPolicy` only
 * knows `claude-cli` and `google-gemini-cli`, and without a policy
 * `shouldResolveAuthProfileForExecution` is false. So we store one
 * identity-only OAuth profile per backend id (a named account, no token
 * material) and point `defaultAuthProfileId` at it. Core reads the name,
 * hashes it into the boundary fingerprint, and leaves the credential alone.
 * Which account actually executes is still decided by `prepareExecution`.
 *
 * The identity is per BACKEND ID, not per pool member, on purpose: a pool
 * rotation must keep the session. Core keys the stored CLI session binding on
 * `authProfileId` + auth epoch (`resolveCliSessionReuse`), so an identity that
 * changed with the launched member would invalidate the CLI session and
 * refuse the reseed (`reason=auth-profile`) on every rotation — undoing the
 * v1.9.1 resume handover — and core resolves the profile BEFORE
 * `prepareExecution` chooses the member, so it would also lag one turn. The
 * pool already treats its members' transcripts as one operator's conversation
 * (the handover copies them across config dirs); one owner per pool matches.
 *
 * Best-effort by contract: if the profile cannot be stored, core sees no
 * credential and behaves exactly as before this module existed.
 */

/** Profile-id suffix; the full id is `<backendId>:<suffix>`. */
export const IDENTITY_PROFILE_SUFFIX = "multi-clawd-identity";

/** Plugin config key that disables the identity profiles (default on). */
export const HISTORY_IDENTITY_CONFIG_KEY = "historyIdentity";

/**
 * The stored credential. Shape follows core's `OAuthCredential`
 * (`{ type, provider, refresh, access, expires, ...metadata }`): `provider` is
 * the backend id, `accountId` is the stable non-secret name core hashes into
 * the owner, and the token fields are deliberately empty — core's
 * `hasUsableOAuthCredential` is false and `evaluateStoredCredentialEligibility`
 * reports `missing_credential`, which is the truth: this is a name, not a
 * login. `expires: 1` (epoch ms) reads as "expired" on status surfaces rather
 * than "invalid".
 */
export interface IdentityCredential {
  type: "oauth";
  provider: string;
  accountId: string;
  displayName: string;
  access: "";
  refresh: "";
  expires: 1;
}

export function identityProfileId(backendId: string): string {
  return `${backendId}:${IDENTITY_PROFILE_SUFFIX}`;
}

export function identityAccountId(backendId: string): string {
  return `multi-clawd:${backendId}`;
}

export function buildIdentityCredential(backendId: string): IdentityCredential {
  return {
    type: "oauth",
    provider: backendId,
    accountId: identityAccountId(backendId),
    displayName: `multi-clawd history identity for ${backendId} (a name, not a credential)`,
    access: "",
    refresh: "",
    expires: 1,
  };
}

/**
 * Whether a stored profile already carries this backend's identity. Only the
 * fields core hashes matter (`encodeOAuthIdentity`: provider, clientId, email,
 * enterpriseUrl, projectId, accountId); anything else is cosmetic.
 */
export function hasIdentity(existing: unknown, wanted: IdentityCredential): boolean {
  if (!existing || typeof existing !== "object") return false;
  const cred = existing as Record<string, unknown>;
  return (
    cred.type === "oauth" &&
    cred.provider === wanted.provider &&
    cred.accountId === wanted.accountId &&
    cred.email === undefined &&
    cred.clientId === undefined &&
    cred.enterpriseUrl === undefined &&
    cred.projectId === undefined
  );
}

/**
 * The slice of `openclaw/plugin-sdk/provider-auth` this module uses. Injected
 * so tests drive the wiring with a fake store and the gateway gets the real
 * SDK (whose writes publish the runtime snapshot in-process).
 */
export interface ProviderAuthSdk {
  ensureAuthProfileStore: (
    agentDir?: string,
    options?: { readOnly?: boolean },
  ) => { profiles: Record<string, unknown> };
  upsertAuthProfileWithLock: (params: {
    profileId: string;
    credential: IdentityCredential;
  }) => Promise<unknown>;
}

export interface EnsureIdentityResult {
  /** Profiles written this pass. */
  written: string[];
  /** Profiles already correct. */
  kept: string[];
  /** Profiles that could not be verified or written, with a safe reason. */
  failed: Array<{ profileId: string; reason: string }>;
}

/**
 * Make sure every backend id has its identity profile in the SHARED auth
 * store (agentDir undefined). Core merges the shared store into every agent's
 * runtime view (`loadRuntimeAuthProfileStore` overlays `mainStore`), so one
 * write covers every agent that runs on these backends. Idempotent: a profile
 * that already carries the identity is left untouched, so a register() re-run
 * on a config rebuild costs one read.
 */
export async function ensureIdentityProfiles(
  backendIds: readonly string[],
  sdk: ProviderAuthSdk,
): Promise<EnsureIdentityResult> {
  const result: EnsureIdentityResult = { written: [], kept: [], failed: [] };
  let profiles: Record<string, unknown> | undefined;
  try {
    profiles = sdk.ensureAuthProfileStore(undefined, { readOnly: true }).profiles;
  } catch (err) {
    // Unreadable store: do not write blind into it. Report and leave core on
    // today's behaviour.
    for (const id of backendIds) {
      result.failed.push({ profileId: identityProfileId(id), reason: `store read failed: ${errorName(err)}` });
    }
    return result;
  }
  for (const id of backendIds) {
    const profileId = identityProfileId(id);
    const wanted = buildIdentityCredential(id);
    if (hasIdentity(profiles[profileId], wanted)) {
      result.kept.push(profileId);
      continue;
    }
    try {
      await sdk.upsertAuthProfileWithLock({ profileId, credential: wanted });
      result.written.push(profileId);
    } catch (err) {
      result.failed.push({ profileId, reason: `write failed: ${errorName(err)}` });
    }
  }
  return result;
}

/** One-line summary for the gateway log. */
export function describeEnsureResult(result: EnsureIdentityResult): string {
  const parts: string[] = [];
  if (result.written.length) parts.push(`stored ${result.written.join(", ")}`);
  if (result.kept.length) parts.push(`kept ${result.kept.join(", ")}`);
  for (const f of result.failed) parts.push(`${f.profileId}: ${f.reason}`);
  return parts.join("; ") || "nothing to do";
}

/** Error class + message only; never the store contents. */
function errorName(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Load the real SDK slice. A core without this subpath (or without these
 * exports) is reported as undefined and the feature is skipped; the
 * compatibility range stays what it was.
 */
export async function loadProviderAuthSdk(): Promise<ProviderAuthSdk | undefined> {
  try {
    const mod = (await import("openclaw/plugin-sdk/provider-auth")) as Partial<ProviderAuthSdk>;
    if (
      typeof mod.ensureAuthProfileStore !== "function" ||
      typeof mod.upsertAuthProfileWithLock !== "function"
    ) {
      return undefined;
    }
    return {
      ensureAuthProfileStore: mod.ensureAuthProfileStore,
      upsertAuthProfileWithLock: mod.upsertAuthProfileWithLock,
    };
  } catch {
    return undefined;
  }
}
