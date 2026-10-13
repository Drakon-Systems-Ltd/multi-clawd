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
 * - the marker is emitted only for a login judged usable, never for a dead one;
 * - no token value ever leaves the resolver;
 * - the marker is refused as a request credential, so the direct API path
 *   keeps failing closed instead of putting a placeholder on the wire.
 */
import { describe, expect, test } from "vitest";
import type { CredentialAccountShape, CredentialCheck, CredentialIo } from "../src/login-health.js";
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

  test("a member's real token is passed through unchanged by the pool", () => {
    const pool = poolRuntimeAuth("clawd", [
      () => ({ apiKey: "sk-ant-oat01-real", source: "multi-clawd claw1 token", mode: "token" }),
    ]);
    expect(pool).toEqual({ apiKey: "sk-ant-oat01-real", source: "multi-clawd claw1 token", mode: "token" });
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

  test("native: reads ~/.claude/.credentials.json; unexpired → marker, no secret leaves", () => {
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) });
    const cache = createLoginAuthCache({ io });
    const result = cache.resolve(native, "claw1", NOW);
    expect(result?.apiKey).toBe("oauth:claw1");
    expect(result?.mode).toBe("oauth");
    noSecrets(result);
  });

  test("native: expired with no proof of refresh → nothing", () => {
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW - HOUR) });
    expect(createLoginAuthCache({ io }).resolve(native, "claw1", NOW)).toBeUndefined();
  });

  test("native: expired but a successful turn since proves the refresh → marker", () => {
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW - HOUR) });
    const cache = createLoginAuthCache({ io, lastSuccessAt: () => NOW - 10 * MIN });
    expect(cache.resolve(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
  });

  test("configDir: reads <dir>/.credentials.json", () => {
    const io = fileIo({ "~/.claude-claw2/.credentials.json": cred(NOW + HOUR) });
    expect(createLoginAuthCache({ io }).resolve(dir, "claw2", NOW)?.apiKey).toBe("oauth:claw2");
  });

  test("configDir: missing file → nothing, and an io that throws never escapes", () => {
    expect(createLoginAuthCache({ io: fileIo({}) }).resolve(dir, "claw2", NOW)).toBeUndefined();
    const broken: CredentialIo = {
      ...fileIo({}),
      readFile: () => {
        throw new TypeError("boom");
      },
    };
    expect(createLoginAuthCache({ io: broken }).resolve(dir, "claw2", NOW)).toBeUndefined();
  });

  test("the read is cached per account for the TTL, then re-read", () => {
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
    cache.resolve(native, "claw1", NOW);
    cache.resolve(native, "claw1", NOW + LOGIN_AUTH_CACHE_TTL_MS - 1);
    expect(reads).toBe(1);
    cache.resolve(native, "claw1", NOW + LOGIN_AUTH_CACHE_TTL_MS + 1);
    expect(reads).toBe(2);
    expect(LOGIN_AUTH_CACHE_TTL_MS).toBe(30 * 1000);
  });

  test("a usable verdict is not cached past the access token's own expiry", () => {
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW + 90 * 1000) });
    let reads = 0;
    const counting: CredentialIo = {
      ...io,
      readFile: (p) => {
        reads += 1;
        return io.readFile(p);
      },
    };
    const cache = createLoginAuthCache({ io: counting });
    expect(cache.resolve(native, "claw1", NOW)?.apiKey).toBe("oauth:claw1");
    // Inside the expiry skew the cached "ok" must not be served: re-read, judged expired.
    expect(cache.resolve(native, "claw1", NOW + 60 * 1000)).toBeUndefined();
    expect(reads).toBe(2);
  });

  test("token-backed accounts are not this cache's business", () => {
    const io = fileIo({ "~/.claude/.credentials.json": cred(NOW + HOUR) });
    const cache = createLoginAuthCache({ io });
    expect(cache.resolve({ id: "t", oauthTokenFile: "~/t.token" }, "t", NOW)).toBeUndefined();
    expect(cache.resolve({ id: "r", oauthTokenRef: { source: "exec", provider: "p", id: "x" } }, "r", NOW)).toBeUndefined();
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
