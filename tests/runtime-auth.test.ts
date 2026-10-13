/**
 * Runtime-auth synthesis for CLI-login accounts (#39).
 *
 * OpenClaw >= 2026.10 computes model availability per provider from the
 * synthetic credential a provider plugin returns. A `native` / `configDir`
 * account has no setup token to hand over, so it used to return nothing and
 * the host marked every one of its models "missing-auth". The fix proves the
 * login from the stored credential's metadata and answers with a non-secret
 * marker. These tests pin the three properties that matter:
 *
 * - the marker is emitted only for a login judged usable, never for a dead one
 *   (a login the CLI has rejected on a real turn is dead, whatever the stored
 *   credential looks like at rest);
 * - no token value ever leaves the resolver, and the synchronous surface never
 *   reads a credential source (on macOS that is a `security` call that can
 *   block for seconds);
 * - the marker is refused as a request credential, so the direct API path
 *   keeps failing closed instead of putting a placeholder on the wire — for
 *   the pool too, which must never hand out a member's real token.
 */
import { describe, expect, test } from "vitest";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  keychainServiceForConfigDir,
  type CredentialAccountShape,
  type CredentialCheck,
  type CredentialIo,
  type KeychainRead,
} from "../src/login-health.js";
import {
  LOGIN_AUTH_CACHE_TTL_MS,
  createLoginAuthCache,
  isRuntimeAuthMarker,
  loginRuntimeAuth,
  poolRuntimeAuth,
  refuseRuntimeAuthMarker,
  runtimeAuthMarker,
} from "../src/runtime-auth.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const ACCESS = "fake-access-token-value";
const REFRESH = "fake-refresh-token-value";

function cred(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt, scopes: ["user:inference"] },
  });
}

function fileIo(files: Record<string, string>): CredentialIo {
  return {
    readFile: (p) => {
      const data = files[p];
      if (data === undefined) throw new Error(`ENOENT ${p}`);
      return data;
    },
    expandHome: (p) => p.replace(/^~/, "/home/example"),
    readKeychainItem: () => ({ status: "absent" }),
    keychainAccount: "example-user",
    platform: "linux",
  };
}

function noSecrets(value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
}

const ok = (expiresAt?: number): CredentialCheck => ({ status: "ok", detail: "x", expiresAt });

describe("runtimeAuthMarker", () => {
  test("is the host's own non-secret oauth marker for the provider", () => {
    expect(runtimeAuthMarker("clawd")).toBe("oauth:clawd");
    expect(runtimeAuthMarker("claw2")).toBe("oauth:claw2");
  });

  test("isRuntimeAuthMarker recognises exactly that shape", () => {
    expect(isRuntimeAuthMarker("oauth:clawd")).toBe(true);
    expect(isRuntimeAuthMarker(" oauth:clawd ")).toBe(true);
    expect(isRuntimeAuthMarker("oauth:")).toBe(false);
    expect(isRuntimeAuthMarker("sk-ant-oat01-abc")).toBe(false);
    expect(isRuntimeAuthMarker("")).toBe(false);
    expect(isRuntimeAuthMarker(undefined)).toBe(false);
  });
});

describe("loginRuntimeAuth", () => {
  test("usable login → marker credential for that provider, oauth mode, expiry carried", () => {
    const result = loginRuntimeAuth(ok(NOW + 2 * HOUR), { providerId: "claw2", accountId: "claw2", nowMs: NOW });
    expect(result).toEqual({
      apiKey: "oauth:claw2",
      source: "claude login (claw2)",
      mode: "oauth",
      expiresAt: NOW + 2 * HOUR,
    });
  });

  test("a login proven by a recent turn after expiry carries no stale expiry", () => {
    const result = loginRuntimeAuth(ok(NOW - HOUR), { providerId: "claw2", accountId: "claw2", nowMs: NOW });
    expect(result?.apiKey).toBe("oauth:claw2");
    expect(result?.expiresAt).toBeUndefined();
  });

  test.each(["unverified", "broken", "unknown"] as const)("%s login → nothing (host keeps missing-auth)", (status) => {
    expect(
      loginRuntimeAuth({ status, reason: "r" }, { providerId: "claw2", accountId: "claw2", nowMs: NOW }),
    ).toBeUndefined();
  });

  test("the pool re-keys a member's marker to the pool's own provider id", () => {
    const member = loginRuntimeAuth(ok(NOW + HOUR), { providerId: "claw2", accountId: "claw2", nowMs: NOW })!;
    const pool = poolRuntimeAuth("clawd", [() => undefined, () => member]);
    expect(pool).toEqual({
      apiKey: "oauth:clawd",
      source: "claude login (claw2)",
      mode: "oauth",
      expiresAt: NOW + HOUR,
    });
  });

  test("a member's real token NEVER rides out under the pool: the pool answers its marker", () => {
    const pool = poolRuntimeAuth("clawd", [
      () => ({ apiKey: "sk-ant-oat01-real", source: "multi-clawd claw1 token", mode: "token" }),
    ]);
    expect(pool).toEqual({ apiKey: "oauth:clawd", source: "multi-clawd claw1 token", mode: "oauth" });
    expect(JSON.stringify(pool)).not.toContain("sk-ant");
    // ...and that marker is refused on the direct path, as every marker is.
    expect(() => refuseRuntimeAuthMarker({ provider: "clawd", modelId: "m", apiKey: pool!.apiKey })).toThrow();
  });

  test("pool with no live member → nothing; a throwing member is treated as not live", () => {
    expect(poolRuntimeAuth("clawd", [() => undefined, () => undefined])).toBeUndefined();
    expect(
      poolRuntimeAuth("clawd", [
        () => {
          throw new Error("token file unreadable");
        },
      ]),
    ).toBeUndefined();
  });
});

describe("createLoginAuthCache", () => {
  const native: CredentialAccountShape = { id: "claw1", native: true };
  const dir: CredentialAccountShape = { id: "claw2", configDir: "~/.claude-claw2" };

  test("native: reads ~/.claude/.credentials.json on refresh; unexpired → marker, no secret leaves", async () => {
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) }) });
    await cache.refresh(native, NOW);
    const result = cache.peek(native, "claw1", NOW);
    expect(result?.apiKey).toBe("oauth:claw1");
    expect(result?.mode).toBe("oauth");
    noSecrets(result);
  });

  test("native: expired with no proof of refresh → nothing", async () => {
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude/.credentials.json": cred(NOW - HOUR) }) });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW)).toBeUndefined();
  });

  test("native: expired but a successful turn since proves the refresh → marker", async () => {
    const cache = createLoginAuthCache({
      io: fileIo({ "~/.claude/.credentials.json": cred(NOW - HOUR) }),
      health: () => ({ lastSuccessAt: NOW - 10 * MIN }),
    });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
  });

  test("a login the CLI rejected on a real turn (credential_failed) answers nothing — even with an unexpired token", async () => {
    let failed = false;
    const cache = createLoginAuthCache({
      io: fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) }),
      health: () => ({ failed }),
    });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
    // The shim records the failure after a turn; the next peek must see it
    // at once, without waiting for any re-read.
    failed = true;
    expect(cache.peek(native, "claw1", NOW + 1)).toBeUndefined();
    failed = false;
    expect(cache.peek(native, "claw1", NOW + 2)?.apiKey).toBe("oauth:claw1");
  });

  test("configDir: reads <dir>/.credentials.json", async () => {
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude-claw2/.credentials.json": cred(NOW + HOUR) }) });
    await cache.refresh(dir, NOW);
    expect(cache.peek(dir, "claw2", NOW)?.apiKey).toBe("oauth:claw2");
  });

  test("configDir: missing file → nothing, and an io that throws never escapes refresh", async () => {
    const cache = createLoginAuthCache({ io: fileIo({}) });
    await cache.refresh(dir, NOW);
    expect(cache.peek(dir, "claw2", NOW)).toBeUndefined();
    const broken: CredentialIo = {
      ...fileIo({}),
      readFile: () => {
        throw new TypeError("boom");
      },
    };
    const cache2 = createLoginAuthCache({ io: broken });
    await expect(cache2.refresh(dir, NOW)).resolves.toBeUndefined();
    expect(cache2.peek(dir, "claw2", NOW)).toBeUndefined();
  });

  test("peek is cache-only: a cold peek answers nothing, starts ONE background refresh, never reads inline", async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) });
    const cache = createLoginAuthCache({
      io: { ...io, platform: "darwin" },
      readKeychainItemAsync: async () => {
        reads += 1;
        await gate; // the Keychain is slow (locked, prompting, timing out)
        return { status: "absent" };
      },
    });
    expect(cache.peek(native, "claw1", NOW)).toBeUndefined();
    expect(cache.peek(native, "claw1", NOW)).toBeUndefined();
    expect(cache.peek(native, "claw1", NOW)).toBeUndefined();
    expect(reads).toBe(1);
    release!();
    await cache.refresh(native, NOW); // joins the in-flight refresh
    // Keychain absent → file fallback, which is live.
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
  });

  test("macOS: refresh reads the Keychain asynchronously, by the CLI's service and account, never via the sync reader", async () => {
    const asked: Array<[string, string]> = [];
    const syncReads: string[] = [];
    const io: CredentialIo = {
      ...fileIo({}),
      platform: "darwin",
      keychainAccount: "example-user",
      readKeychainItem: (service) => {
        syncReads.push(service);
        return { status: "unreadable" };
      },
    };
    const cache = createLoginAuthCache({
      io,
      readKeychainItemAsync: async (service, account): Promise<KeychainRead> => {
        asked.push([service, account]);
        return { status: "found", data: cred(NOW + HOUR) };
      },
    });
    await cache.refresh(native, NOW);
    await cache.refresh(dir, NOW);
    expect(asked).toEqual([
      [CLAUDE_KEYCHAIN_SERVICE, "example-user"],
      [keychainServiceForConfigDir("/home/example/.claude-claw2"), "example-user"],
    ]);
    expect(syncReads).toEqual([]);
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(dir, "claw2", NOW)?.apiKey).toBe("oauth:claw2");
    noSecrets(cache.peek(native, "claw1", NOW));
  });

  test("macOS: a Keychain read that times out (unreadable) → nothing, judged once, no storm", async () => {
    let reads = 0;
    const cache = createLoginAuthCache({
      io: { ...fileIo({}), platform: "darwin" },
      readKeychainItemAsync: async () => {
        reads += 1;
        return { status: "unreadable" };
      },
    });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW)).toBeUndefined();
    expect(cache.peek(native, "claw1", NOW + 1)).toBeUndefined();
    expect(reads).toBe(1);
  });

  test("a fresh verdict is served for the TTL; a stale one is served while ONE background re-read runs", async () => {
    let reads = 0;
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) });
    const counting: CredentialIo = {
      ...io,
      readFile: (p) => {
        reads += 1;
        return io.readFile(p);
      },
    };
    const cache = createLoginAuthCache({ io: counting });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW + LOGIN_AUTH_CACHE_TTL_MS - 1)?.apiKey).toBe("oauth:claw1");
    expect(reads).toBe(1);
    // Stale: still served (the token is good for an hour), re-read in the background.
    expect(cache.peek(native, "claw1", NOW + LOGIN_AUTH_CACHE_TTL_MS + 1)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(native, "claw1", NOW + LOGIN_AUTH_CACHE_TTL_MS + 2)?.apiKey).toBe("oauth:claw1");
    await cache.refresh(native, NOW + LOGIN_AUTH_CACHE_TTL_MS + 2);
    expect(reads).toBe(2);
    expect(LOGIN_AUTH_CACHE_TTL_MS).toBe(30 * 1000);
  });

  test("a usable verdict is never served past the access token's own expiry", async () => {
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude/.credentials.json": cred(NOW + 90 * 1000) }) });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
    // Inside the expiry skew the cached "ok" is withheld, whatever the TTL says.
    expect(cache.peek(native, "claw1", NOW + 31 * 1000)).toBeUndefined();
  });

  test("a near-term token expiry caps hardUntil even when it falls inside the TTL window", async () => {
    // Expiry at +70s, skew 60s → tokenBound is +10s, well short of the 30s TTL.
    // A buggy max(tokenBound, ttl) would keep serving "ok" through +30s.
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude/.credentials.json": cred(NOW + 70 * 1000) }) });
    await cache.refresh(native, NOW);
    expect(cache.peek(native, "claw1", NOW + 9 * 1000)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(native, "claw1", NOW + 11 * 1000)).toBeUndefined();
  });

  test("record(): the probe's own verdict feeds the cache on its cadence", () => {
    const cache = createLoginAuthCache({ io: fileIo({}) });
    cache.record("claw1", ok(NOW + HOUR), NOW);
    expect(cache.peek(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
    cache.record("claw1", { status: "broken", reason: "gone" }, NOW + 1);
    expect(cache.peek(native, "claw1", NOW + 2)).toBeUndefined();
  });

  test("token-backed accounts are not this cache's business", async () => {
    const cache = createLoginAuthCache({ io: fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) }) });
    const file = { id: "t", oauthTokenFile: "~/t.token" };
    const ref = { id: "r", oauthTokenRef: { source: "exec", provider: "p", id: "x" } };
    await cache.refresh(file, NOW);
    await cache.refresh(ref, NOW);
    expect(cache.peek(file, "t", NOW)).toBeUndefined();
    expect(cache.peek(ref, "r", NOW)).toBeUndefined();
  });
});

describe("refuseRuntimeAuthMarker — the direct API path fails closed", () => {
  test("the marker is refused with a plain explanation, never returned as a credential", () => {
    expect(() =>
      refuseRuntimeAuthMarker({ provider: "clawd", modelId: "claude-sonnet-5-5", apiKey: "oauth:clawd" }),
    ).toThrow(/clawd\/claude-sonnet-5-5.*Claude Code.*not.*direct/i);
  });

  test("a real credential passes through untouched (token accounts keep today's direct path)", () => {
    expect(
      refuseRuntimeAuthMarker({ provider: "claw1", modelId: "claude-sonnet-5-5", apiKey: "sk-ant-oat01-real" }),
    ).toBeUndefined();
  });

  test("the thrown message carries no credential value", () => {
    try {
      refuseRuntimeAuthMarker({ provider: "clawd", modelId: "m", apiKey: "oauth:clawd" });
    } catch (err) {
      expect(String(err)).not.toContain("oauth:clawd");
    }
  });
});
