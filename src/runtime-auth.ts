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
 * The host's hook is synchronous, so it is served from a verdict cache only:
 * the credential-source read (a file on Linux, the Keychain via `security` on
 * macOS, which can block for seconds) runs asynchronously — warmed at
 * registration, refreshed in the background when a verdict goes stale, and
 * fed by the login-health probe on its cadence. A login the Claude CLI has
 * rejected on a real turn (health state `credential_failed`) answers nothing
 * at once, whatever the stored credential says at rest.
 *
 * No token value ever leaves this module: credentials are reduced to metadata
 * by `parseOauthCredential` on read, and only a verdict is cached.
 */
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  CLAUDE_KEYCHAIN_SERVICE,
  assessAccountCredential,
  keychainServiceForConfigDir,
  type CredentialAccountShape,
  type CredentialCheck,
  type CredentialIo,
  type KeychainRead,
} from "./login-health.js";

/** The host's own non-secret api-key marker prefix for OAuth-backed providers. */
export const RUNTIME_AUTH_MARKER_PREFIX = "oauth:";

/** How long one account's login verdict is served before a background re-read. */
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
 * The pool is signed in when any member is — and it says so with its OWN
 * marker, whatever the member's credential type. A member's real setup token
 * must never ride out under the pool's id: the direct API transport would
 * then run `clawd/...` on that one account, around the pool's routing and
 * limits, instead of being refused like every other pool request.
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
    return {
      apiKey: runtimeAuthMarker(poolId),
      source: result.source,
      mode: "oauth",
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    };
  }
  return undefined;
}

/** Accounts whose login this cache judges: CLI logins, not token-backed ones. */
export function loginAuthEligible(account: CredentialAccountShape): boolean {
  return !account.oauthTokenFile && !account.oauthTokenRef && Boolean(account.native || account.configDir);
}

/** What the account's health state says about its login, from outside the credential store. */
export interface LoginHealthEvidence {
  /** Last time the API accepted this account's login (epoch ms), if ever seen. */
  lastSuccessAt?: number;
  /** The Claude CLI rejected this login on a real turn and the failure is still current. */
  failed?: boolean;
}

export interface LoginAuthCache {
  /**
   * The host's synchronous surface: a cached verdict or nothing, never a
   * credential-source read. A missing or stale verdict starts one background
   * refresh; a stale `ok` keeps being served until the access token itself
   * would expire. A current `credential_failed` health record vetoes at once.
   */
  peek(account: CredentialAccountShape, providerId: string, nowMs?: number): RuntimeAuthResult | undefined;
  /** Re-judge one account's credential source off the event loop. Never rejects. */
  refresh(account: CredentialAccountShape, nowMs?: number): Promise<void>;
  /** Adopt a verdict the login-health probe has just computed. */
  record(accountId: string, check: CredentialCheck, nowMs?: number): void;
}

interface CachedVerdict {
  check: CredentialCheck;
  /** Served without a refresh until here. */
  freshUntil: number;
  /** Never served past here (an `ok` is bounded by the token's own expiry). */
  hardUntil: number;
}

export function createLoginAuthCache(options: {
  io: CredentialIo;
  /**
   * macOS: the Keychain read, asynchronous. When given, a refresh fetches the
   * item first and judges with the result, so `security` never runs on the
   * synchronous path. Without it, refresh falls back to `io.readKeychainItem`.
   */
  readKeychainItemAsync?: (service: string, account: string) => Promise<KeychainRead>;
  health?: (accountId: string) => LoginHealthEvidence;
  ttlMs?: number;
}): LoginAuthCache {
  const ttlMs = options.ttlMs ?? LOGIN_AUTH_CACHE_TTL_MS;
  const cache = new Map<string, CachedVerdict>();
  const inflight = new Map<string, Promise<void>>();
  const health = (accountId: string): LoginHealthEvidence => {
    try {
      return options.health?.(accountId) ?? {};
    } catch {
      return {};
    }
  };
  const eligible = loginAuthEligible;

  const store = (accountId: string, check: CredentialCheck, nowMs: number): void => {
    // An `ok` backed by an unexpired token may be served, stale, until that
    // token would expire; an `ok` proven by a recent turn (token already
    // expired) and every other verdict only for the TTL.
    const tokenBound =
      check.status === "ok" && check.expiresAt !== undefined
        ? check.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS
        : undefined;
    // A token-backed verdict is capped at tokenBound, whether that falls
    // inside or outside the TTL window — never served once the token itself
    // is within its expiry skew. A success-proven verdict with no token
    // expiry (tokenBound undefined) keeps the plain TTL.
    const hardUntil = tokenBound !== undefined && tokenBound > nowMs ? tokenBound : nowMs + ttlMs;
    cache.set(accountId, { check, freshUntil: nowMs + ttlMs, hardUntil });
  };

  const judge = async (account: CredentialAccountShape, nowMs: number): Promise<void> => {
    let io = options.io;
    if (io.platform === "darwin" && options.readKeychainItemAsync) {
      const dir = account.native ? "~/.claude" : account.configDir;
      const service = account.native
        ? CLAUDE_KEYCHAIN_SERVICE
        : keychainServiceForConfigDir(io.expandHome(dir ?? ""));
      const read = await options.readKeychainItemAsync(service, io.keychainAccount);
      io = { ...io, readKeychainItem: () => read };
    }
    const check = assessAccountCredential(account, io, {
      proof: { lastSuccessAt: health(account.id).lastSuccessAt },
      nowMs,
    });
    store(account.id, check, nowMs);
  };

  const refresh = (account: CredentialAccountShape, nowMs = Date.now()): Promise<void> => {
    if (!eligible(account)) return Promise.resolve();
    const running = inflight.get(account.id);
    if (running) return running;
    const task = judge(account, nowMs)
      .catch(() => {
        // An unreadable source proves nothing either way: record `unknown`
        // so the next peek does not re-trigger a refresh storm.
        store(account.id, { status: "unknown", reason: "credential source could not be judged" }, nowMs);
      })
      .finally(() => {
        inflight.delete(account.id);
      });
    inflight.set(account.id, task);
    return task;
  };

  return {
    peek(account, providerId, nowMs = Date.now()) {
      if (!eligible(account)) return undefined;
      if (health(account.id).failed) return undefined;
      const hit = cache.get(account.id);
      if (!hit || hit.freshUntil <= nowMs) void refresh(account, nowMs);
      if (!hit || hit.hardUntil <= nowMs) return undefined;
      return loginRuntimeAuth(hit.check, { providerId, accountId: account.id, nowMs });
    },
    refresh,
    record(accountId, check, nowMs = Date.now()) {
      store(accountId, check, nowMs);
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
