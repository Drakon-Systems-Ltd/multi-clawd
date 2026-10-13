/**
 * Runtime-auth synthesis for CLI-login accounts (#39).
 *
 * OpenClaw >= 2026.10 derives per-provider model availability from the
 * synthetic credential a provider plugin returns: a provider that declares
 * `resolveSyntheticAuth` and then answers nothing is "missing-auth", and the
 * Control UI disables every one of its models. A `native` / `configDir`
 * account has no setup token to hand over, so that is exactly what happened.
 *
 * The answer is the login itself, judged on evidence the way the login-health
 * probe judges it (an unexpired stored access token, or a successful turn
 * since it expired — never mere presence), reported through the host's own
 * non-secret `oauth:<provider>` api-key marker. The host recognises that
 * marker as "not a secret" everywhere it inspects api keys (status, audit,
 * config projection, sentinel protection), and `refuseRuntimeAuthMarker`
 * keeps it off the wire: the direct API transport refuses it before a request
 * is built, so a CLI-login account fails closed exactly as it did before.
 *
 * Why not the SDK's `nativeAuth` field: on the 2026.10 host a credential
 * carrying `nativeAuth` is recorded as a native (object) runtime auth mode,
 * and the availability evaluator only honours string modes for a provider
 * that is its own CLI runtime — so `nativeAuth` leaves the models unavailable.
 * The marker form is what the host actually acts on.
 *
 * No token value ever leaves this module: credentials are reduced to metadata
 * by `parseOauthCredential` on read, and only a verdict is cached.
 */
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  assessAccountCredential,
  type CredentialAccountShape,
  type CredentialCheck,
  type CredentialIo,
} from "./login-health.js";

/** The host's own non-secret api-key marker prefix for OAuth-backed providers. */
export const RUNTIME_AUTH_MARKER_PREFIX = "oauth:";

/** How long one account's login verdict is served before the source is re-read. */
export const LOGIN_AUTH_CACHE_TTL_MS = 30 * 1000;

export interface RuntimeAuthResult {
  apiKey: string;
  source: string;
  mode: "oauth" | "token";
  /** Epoch ms; only when the stored access token's expiry is still ahead. */
  expiresAt?: number;
}

/** The placeholder credential that stands for "this provider's CLI login is usable". */
export function runtimeAuthMarker(providerId: string): string {
  return `${RUNTIME_AUTH_MARKER_PREFIX}${providerId.trim()}`;
}

export function isRuntimeAuthMarker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith(RUNTIME_AUTH_MARKER_PREFIX) && trimmed.length > RUNTIME_AUTH_MARKER_PREFIX.length;
}

/**
 * Turn a login-health verdict into the provider's synthetic credential.
 * Only `ok` proves a usable login; `unverified` (idle, expired, refresh
 * unproven), `broken` and `unknown` all answer nothing, which keeps the host's
 * honest "missing-auth" for a login that is not known to work.
 */
export function loginRuntimeAuth(
  check: CredentialCheck,
  ctx: { providerId: string; accountId: string; nowMs: number },
): RuntimeAuthResult | undefined {
  if (check.status !== "ok") return undefined;
  const expiresAt =
    check.expiresAt !== undefined && check.expiresAt > ctx.nowMs ? check.expiresAt : undefined;
  return {
    apiKey: runtimeAuthMarker(ctx.providerId),
    source: `claude login (${ctx.accountId})`,
    mode: "oauth",
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * The pool is signed in when any member is. The first live member's result is
 * re-keyed to the pool's own provider id when it is a marker (the marker names
 * the provider it authorises); a member's real setup token passes through as
 * is, which is what per-account token providers already report today.
 */
export function poolRuntimeAuth(
  poolId: string,
  members: Array<() => RuntimeAuthResult | undefined>,
): RuntimeAuthResult | undefined {
  for (const member of members) {
    let result: RuntimeAuthResult | undefined;
    try {
      result = member();
    } catch {
      continue;
    }
    if (!result) continue;
    return isRuntimeAuthMarker(result.apiKey) ? { ...result, apiKey: runtimeAuthMarker(poolId) } : result;
  }
  return undefined;
}

export interface LoginAuthCache {
  /**
   * Synchronous and bounded: one credential-source read per account per TTL,
   * served from a verdict cache in between. Never throws.
   */
  resolve(account: CredentialAccountShape, providerId: string, nowMs?: number): RuntimeAuthResult | undefined;
}

export function createLoginAuthCache(options: {
  io: CredentialIo;
  /** Last time the API accepted this account's login (epoch ms), if known. */
  lastSuccessAt?: (accountId: string) => number | undefined;
  ttlMs?: number;
}): LoginAuthCache {
  const ttlMs = options.ttlMs ?? LOGIN_AUTH_CACHE_TTL_MS;
  const cache = new Map<string, { check: CredentialCheck; until: number }>();
  return {
    resolve(account, providerId, nowMs = Date.now()) {
      if (account.oauthTokenFile || account.oauthTokenRef) return undefined;
      if (!account.native && !account.configDir) return undefined;
      let check: CredentialCheck | undefined;
      const hit = cache.get(account.id);
      if (hit && hit.until > nowMs) {
        check = hit.check;
      } else {
        try {
          check = assessAccountCredential(account, options.io, {
            proof: { lastSuccessAt: options.lastSuccessAt?.(account.id) },
            nowMs,
          });
        } catch {
          return undefined;
        }
        // A usable verdict is good until the TTL or the access token's own
        // expiry (less the probe's skew), whichever comes first.
        let until = nowMs + ttlMs;
        if (check.status === "ok" && check.expiresAt !== undefined) {
          until = Math.min(until, check.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS);
        }
        cache.set(account.id, { check, until });
      }
      return loginRuntimeAuth(check, { providerId, accountId: account.id, nowMs });
    },
  };
}

/**
 * `prepareRuntimeAuth` guard for the direct API transport (`infer model run`,
 * side-channel completions): the marker proves a CLI login to the host, it is
 * not a bearer. Refusing here fails the request locally, before any header is
 * built, so a CLI-login account keeps failing closed on that path. Real
 * credentials (token accounts) pass through untouched.
 */
export function refuseRuntimeAuthMarker(ctx: {
  provider: string;
  modelId: string;
  apiKey: string;
}): undefined {
  if (!isRuntimeAuthMarker(ctx.apiKey)) return undefined;
  throw new Error(
    `[multi-clawd] ${ctx.provider}/${ctx.modelId} runs through the Claude Code CLI backend; ` +
      `this account is a Claude login (no setup token), so the direct API transport is not available for it. ` +
      `Run the model as an agent turn, or give the account an oauthTokenFile/oauthTokenRef to use it directly.`,
  );
}
