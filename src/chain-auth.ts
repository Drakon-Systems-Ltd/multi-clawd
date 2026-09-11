/**
 * Does each rung of the model chain have a credential that can actually be
 * tried?
 *
 * `chain-audit.ts` answers "is this chain routed correctly" — it reads the
 * refs. This answers the adjacent question nothing asked: a chain can name a
 * perfectly good fallback whose provider has no eligible auth profile left, and
 * every existing check still reports READY. The failure is invisible until the
 * rung above it dies and the failover it was supposed to provide isn't there.
 *
 * Two things make a rung unauthenticatable, and OpenClaw itself documents both:
 *
 *   1. `auth.order.<provider>` filtering. "A stored profile for that provider
 *      that is omitted from the explicit order is not silently tried later"
 *      (`excluded_by_auth_order`). So an order that lists only ids which are
 *      not in the store, or excludes every stored profile, leaves the provider
 *      with nothing eligible — while `models auth list` still shows profiles.
 *   2. No profile at all, for a provider that is not authenticated statically.
 *
 * Expiry is deliberately NOT treated as breakage on its own: OAuth access
 * tokens expire constantly and are refreshed on use, so a just-passed
 * `expiresAt` is normal operation. Only an expiry stale beyond
 * STALE_OAUTH_GRACE_MS — far longer than any healthy refresh cycle — is
 * evidence that refresh itself has stopped working.
 *
 * Pure and io-free: the caller supplies the chain refs and the profile list
 * (`openclaw models auth list --json`), so this is testable against fixtures.
 */

export interface AuthProfileRecord {
  id: string;
  provider: string;
  /** "oauth" | "token" | "api_key" — as reported by `models auth list --json`. */
  type?: string;
  email?: string;
  /** ISO timestamp; OAuth profiles only. */
  expiresAt?: string;
}

export interface ChainAuthInput {
  /** Chain refs as collected by chain-audit's collectChainRefs. */
  refs: Array<{ surface: string; ref: string; allowlist: boolean }>;
  profiles: AuthProfileRecord[];
  /** `auth.order` from openclaw.json: provider id → ordered profile ids. */
  order?: Record<string, unknown>;
  /** The clawd pool id, so pool/pool-member rungs are skipped (they are CLI-backed). */
  poolId?: string;
  nowMs: number;
}

export interface ChainAuthFinding {
  severity: "bad" | "warn" | "note";
  provider: string;
  /** Live chain surfaces that depend on this provider. */
  surfaces: string[];
  reason: string;
}

/**
 * How long past `expiresAt` an OAuth profile must sit before staleness is
 * evidence rather than noise. A healthy profile refreshes on use, and every
 * agent turn is a use, so a week of nothing is a broken refresh — not a busy
 * token.
 */
export const STALE_OAUTH_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Providers that authenticate without an OpenClaw auth profile: CLI-backed
 * Claude (the plugin owns the credential), and local runtimes that need none.
 * Reporting "no profile" for these would be a pure false positive.
 */
const PROFILE_FREE_PROVIDERS = new Set([
  "claude-cli",
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "sglang",
  "local",
]);

const POOL_MEMBER_RE = /^claw\d+$/;

function providerOf(ref: string): string | undefined {
  const idx = ref.indexOf("/");
  if (idx < 1) return undefined; // bare id: the router decides, nothing to check
  return ref.slice(0, idx).trim().toLowerCase();
}

/** Profile ids explicitly ordered for a provider; undefined = no order set. */
function orderedIds(order: Record<string, unknown> | undefined, provider: string): string[] | undefined {
  const entry = order?.[provider];
  if (!Array.isArray(entry)) return undefined;
  const ids = entry.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function expiryAgeMs(profile: AuthProfileRecord, nowMs: number): number | undefined {
  if (!profile.expiresAt) return undefined;
  const at = Date.parse(profile.expiresAt);
  if (Number.isNaN(at)) return undefined;
  return nowMs - at;
}

function humanAge(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * One finding per provider that a LIVE chain rung depends on. Allowlist-only
 * providers are skipped: a registered-but-unused rung with no credential costs
 * nothing, and flagging it would bury the live findings.
 */
export function auditChainAuth(input: ChainAuthInput): ChainAuthFinding[] {
  const poolId = input.poolId?.trim().toLowerCase();
  const bySurface = new Map<string, string[]>();
  for (const { surface, ref, allowlist } of input.refs) {
    if (allowlist) continue;
    const provider = providerOf(ref);
    if (!provider) continue;
    if (provider === poolId || POOL_MEMBER_RE.test(provider)) continue;
    if (PROFILE_FREE_PROVIDERS.has(provider)) continue;
    const list = bySurface.get(provider) ?? [];
    if (!list.includes(surface)) list.push(surface);
    bySurface.set(provider, list);
  }

  const findings: ChainAuthFinding[] = [];
  for (const [provider, surfaces] of [...bySurface.entries()].sort()) {
    const profiles = input.profiles.filter((p) => p.provider?.trim().toLowerCase() === provider);
    const order = orderedIds(input.order, provider);

    if (profiles.length === 0) {
      // No profile is not proof of breakage — the provider may authenticate
      // from an API key in the environment, which doctor cannot see from here.
      findings.push({
        severity: "warn",
        provider,
        surfaces,
        reason:
          `no saved auth profile; this rung can only authenticate from an environment API key. ` +
          `Confirm with \`openclaw models auth list --provider ${provider}\``,
      });
      continue;
    }

    const eligible = order ? profiles.filter((p) => order.includes(p.id)) : profiles;
    if (eligible.length === 0) {
      // The documented `excluded_by_auth_order` case: the profiles exist and
      // are listed by `models auth list`, and not one of them will ever be
      // tried. This is positive evidence, so it fails.
      const missing = order?.filter((id) => !profiles.some((p) => p.id === id)) ?? [];
      findings.push({
        severity: "bad",
        provider,
        surfaces,
        reason:
          `auth.order.${provider} excludes every saved profile (${profiles
            .map((p) => p.id)
            .join(", ")})${
            missing.length > 0 ? ` and names ${missing.join(", ")}, which is not in the store` : ""
          } — the rung can never authenticate. Fix the order or remove it.`,
      });
      continue;
    }

    if (order) {
      // The order is satisfiable, but an entry that matches nothing is a typo
      // or a profile that was logged out: harmless today, an outage the moment
      // the working entry ahead of it goes.
      const missing = order.filter((id) => !profiles.some((p) => p.id === id));
      if (missing.length > 0) {
        findings.push({
          severity: "warn",
          provider,
          surfaces,
          reason: `auth.order.${provider} names ${missing.join(", ")}, which is not in the auth store — silently ignored`,
        });
      }
    }

    // Staleness is judged over the ELIGIBLE set only: a fresh profile that the
    // order excludes cannot rescue this rung.
    const ages = eligible.map((p) => ({ profile: p, age: expiryAgeMs(p, input.nowMs) }));
    const dated = ages.filter((a) => a.age !== undefined) as Array<{
      profile: AuthProfileRecord;
      age: number;
    }>;
    const undatedUsable = ages.length > dated.length; // api_key / token profiles never expire
    if (!undatedUsable && dated.length > 0 && dated.every((a) => a.age > 0)) {
      const freshest = Math.min(...dated.map((a) => a.age));
      if (freshest > STALE_OAUTH_GRACE_MS) {
        findings.push({
          severity: "bad",
          provider,
          surfaces,
          reason:
            `every eligible profile's OAuth token expired (oldest usable one ${humanAge(freshest)} ago, ` +
            `past the ${Math.round(STALE_OAUTH_GRACE_MS / 86_400_000)}d refresh grace) — refresh has stopped working. ` +
            `Re-run \`openclaw models auth login --provider ${provider}\``,
        });
      } else {
        findings.push({
          severity: "warn",
          provider,
          surfaces,
          reason:
            `every eligible profile's OAuth token is past expiry (${humanAge(freshest)} ago). ` +
            `Normally refreshed on next use — if this rung is failing, probe it`,
        });
      }
    }
  }
  return findings;
}
