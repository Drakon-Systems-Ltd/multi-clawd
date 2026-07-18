/**
 * Secret-ref resolution for account setup-tokens (v0.3 oauthTokenRef).
 *
 * `oauthTokenRef` takes the same shape OpenClaw uses everywhere else in
 * openclaw.json — `{ "source": "exec", "provider": "onepassword",
 * "id": "op://Vault/Item/field" }` — and is resolved through the gateway's
 * own configured secret providers, so tokens never touch plaintext files.
 *
 * Semantics chosen for launch-path safety:
 * - Resolved values are cached (default 5 min) so per-launch resolution does
 *   not add a secret-manager round trip to every turn.
 * - Failures are reported and return undefined — never thrown — so a
 *   secret-provider outage degrades that account (auth fails, chain steps)
 *   instead of crashing the launch path. Failures are NOT cached: the next
 *   launch retries.
 * - `peek` serves the sync-only surfaces (resolveSyntheticAuth) from the
 *   warm cache without triggering resolution.
 */

export interface SecretRefShape {
  source: string;
  provider: string;
  id: string;
}

export type ResolveRefsFn = (refs: SecretRefShape[]) => Promise<Map<string, unknown>>;

/**
 * Failure classes surfaced by resolveDetailed. The distinction drives the
 * login-health probe's backoff: a resolver that *ran* and returned nothing is
 * a credential problem (broken now); a resolver that *threw* (timeout/network)
 * is transient (degrade, retry).
 */
export type ResolveFailure = "provider_error" | "empty_result";

export interface DetailedResolution {
  value?: string;
  failure?: ResolveFailure;
}

export interface TokenRefResolver {
  resolve(ref: SecretRefShape, nowMs?: number): Promise<string | undefined>;
  /**
   * Like resolve(), but classifies *why* resolution produced no token so
   * callers can tell a credential problem (empty_result) from a transient
   * provider outage (provider_error). Shares the cache and redaction path.
   */
  resolveDetailed(ref: SecretRefShape, nowMs?: number): Promise<DetailedResolution>;
  peek(ref: SecretRefShape, nowMs?: number): string | undefined;
}

/**
 * Fixed-reason-code redaction: the rendered message must leak
 * none of the three classes — resolved token values, SecretRef metadata
 * (provider/id can themselves be sensitive), or provider-supplied exception
 * text. Only the error CLASS name survives, for debuggability.
 */
export function redactRefError(_ref: SecretRefShape, error: unknown): string {
  const errorClass =
    error instanceof Error ? error.constructor.name : typeof error;
  return `credential_resolution_failed (${errorClass})`;
}

export function isSecretRefShape(value: unknown): value is SecretRefShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.source === "string" &&
    v.source.length > 0 &&
    typeof v.provider === "string" &&
    v.provider.length > 0 &&
    typeof v.id === "string" &&
    v.id.length > 0
  );
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function cacheKey(ref: SecretRefShape): string {
  return `${ref.source}\u0000${ref.provider}\u0000${ref.id}`;
}

export function createTokenRefResolver(options: {
  resolveRefs: ResolveRefsFn;
  ttlMs?: number;
  onError?: (ref: SecretRefShape, error: unknown) => void;
  /** Pre-redact errors before they reach onError (fixed reason codes only). */
  redact?: boolean;
}): TokenRefResolver {
  const reportError = (ref: SecretRefShape, error: unknown) => {
    options.onError?.(ref, options.redact ? redactRefError(ref, error) : error);
  };
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { value: string; expiresAt: number }>();

  const fromCache = (ref: SecretRefShape, nowMs: number): string | undefined => {
    const hit = cache.get(cacheKey(ref));
    if (hit && hit.expiresAt > nowMs) return hit.value;
    return undefined;
  };

  return {
    peek(ref, nowMs = Date.now()) {
      return fromCache(ref, nowMs);
    },
    async resolveDetailed(ref, nowMs = Date.now()) {
      const cached = fromCache(ref, nowMs);
      if (cached !== undefined) return { value: cached };
      let resolved: unknown;
      try {
        const values = await options.resolveRefs([ref]);
        // OpenClaw's resolver keys results by secretRefKey (source:provider:id);
        // accept a bare-id keying too for resolver-agnostic callers.
        resolved =
          values.get(`${ref.source}:${ref.provider}:${ref.id}`) ?? values.get(ref.id);
      } catch (error) {
        reportError(ref, error);
        return { failure: "provider_error" };
      }
      if (typeof resolved !== "string" || resolved.trim().length === 0) {
        reportError(
          ref,
          new Error(`secret ref resolved to ${resolved === undefined ? "nothing" : typeof resolved}`),
        );
        return { failure: "empty_result" };
      }
      const value = resolved.trim();
      cache.set(cacheKey(ref), { value, expiresAt: nowMs + ttlMs });
      return { value };
    },
    async resolve(ref, nowMs = Date.now()) {
      return (await this.resolveDetailed(ref, nowMs)).value;
    },
  };
}
