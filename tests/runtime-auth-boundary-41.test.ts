/**
 * Round-3 port of the reviewer repro for PR #40 to the async cache API
 * (refresh + peek). Same intents and assertion strength as the round-1 file;
 * each test asserts the EXPECTED behaviour. Placeholder credential strings only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { classifyAccountHealth, credentialFailureFor, lastAuthSuccessAt } from "../src/health.js";
import { AUTH_PROOF_FRESH_MS, type CredentialIo } from "../src/login-health.js";
import { LOGIN_AUTH_CACHE_TTL_MS, createLoginAuthCache } from "../src/runtime-auth.js";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const HOUR = 60 * 60 * 1000;
const cred = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: "test-access-token-1", refreshToken: "test-refresh-token-1", expiresAt },
  });

function io(readFile: () => string): CredentialIo {
  return {
    readFile,
    expandHome: (p) => p,
    readKeychainItem: () => ({ status: "absent" }),
    keychainAccount: "test",
    platform: "linux",
  };
}

// Wired exactly as src/index.ts loginAuth() wires `health`.
const healthFrom = (state: unknown) => () => ({
  lastSuccessAt: lastAuthSuccessAt(state as never),
  failed: credentialFailureFor(state as never, Date.now()) !== undefined,
});

describe("F1a (ported): revoked (credential_failed) but unexpired login", () => {
  test("module API: cache must not report the marker after a recorded credential failure", async () => {
    const now = Date.now();
    const failedState = {
      accountId: "claw1",
      windows: {},
      credential: { status: "failed" as const, reason: "test: invalid login", seenAt: now - 60_000 },
    };
    expect(classifyAccountHealth(failedState, {}, now).verdict).toBe("credential_failed");
    const acct = { id: "claw1", native: true };

    // Control: same credential, no failure → the marker IS reported (so the
    // undefined below is the veto, not a cold or broken cache).
    const control = createLoginAuthCache({
      io: io(() => cred(now + 2 * HOUR)),
      health: healthFrom({ accountId: "claw1", windows: {} }),
    });
    await control.refresh(acct, now);
    expect(control.peek(acct, "claw1", now)?.apiKey).toBe("oauth:claw1");

    const cache = createLoginAuthCache({ io: io(() => cred(now + 2 * HOUR)), health: healthFrom(failedState) });
    // Peek before the first refresh (reachable: registration warm-up is async).
    expect(cache.peek(acct, "claw1", now)).toBeUndefined();
    await cache.refresh(acct, now);
    expect(cache.peek(acct, "claw1", now)).toBeUndefined();
    expect(cache.peek(acct, "claw1", now + 1)).toBeUndefined();
  });

  test("an ok verdict already cached is vetoed at once when the failure is recorded (no 30s mask)", async () => {
    const now = Date.now();
    let state: unknown = { accountId: "claw1", windows: {} };
    const cache = createLoginAuthCache({
      io: io(() => cred(now + 2 * HOUR)),
      health: () => healthFrom(state)(),
    });
    const acct = { id: "claw1", native: true };
    await cache.refresh(acct, now);
    expect(cache.peek(acct, "claw1", now)?.apiKey).toBe("oauth:claw1");
    state = {
      accountId: "claw1",
      windows: {},
      credential: { status: "failed", reason: "test: invalid login", seenAt: Date.now() },
    };
    expect(cache.peek(acct, "claw1", now + 1)).toBeUndefined();
  });

  test("semantics probe: a failure older than CREDENTIAL_FAILED_TTL (credential_unverified) still vetoes", async () => {
    const now = Date.now();
    const state = {
      accountId: "claw1",
      windows: {},
      credential: { status: "failed" as const, reason: "test: invalid login", seenAt: now - 2 * HOUR },
    };
    expect(classifyAccountHealth(state, {}, now).verdict).toBe("credential_unverified");
    const cache = createLoginAuthCache({ io: io(() => cred(now + 2 * HOUR)), health: healthFrom(state) });
    await cache.refresh({ id: "claw1", native: true }, now);
    expect(cache.peek({ id: "claw1", native: true }, "claw1", now)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "darwin")("F1b (ported): through register(), after warm-up", () => {
  beforeEach(() => {
    vi.resetModules();
    home.dir = mkdtempSync(join(tmpdir(), "mc-40-r3-"));
    mkdirSync(join(home.dir, ".claude"), { recursive: true });
    writeFileSync(join(home.dir, ".claude", ".credentials.json"), cred(Date.now() + 2 * HOUR));
  });
  afterEach(() => rmSync(home.dir, { recursive: true, force: true }));

  const writeFailed = () => {
    const stateDir = join(home.dir, ".openclaw", "state", "multi-clawd");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "claw1.json"),
      JSON.stringify({
        accountId: "claw1",
        windows: {},
        credential: { status: "failed", reason: "test: invalid login", seenAt: Date.now() - 60_000 },
      }),
    );
  };

  async function registerAndWarm() {
    const index = await import("../src/index.js");
    const providers = new Map<string, { id: string; resolveSyntheticAuth?: (c: unknown) => unknown }>();
    index.default.register({
      config: {},
      pluginConfig: {
        accounts: [{ id: "claw1", native: true }, { id: "claw2", configDir: "~/.claude-claw2" }],
        pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      },
      runtime: { config: { current: () => ({ plugins: { entries: {} } }) } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: () => {},
      registerProvider: (p: { id: string }) => providers.set(p.id, p),
      on: () => {},
    } as never);
    await index.loginAuthWarmed();
    expect([...providers.keys()].sort()).toEqual(["claw1", "claw2", "clawd"]);
    const auth = (id: string) =>
      (providers.get(id)?.resolveSyntheticAuth?.({ provider: id }) as { apiKey?: string } | undefined)?.apiKey;
    return auth;
  }

  test("control: without a failure record the warmed providers DO report the marker", async () => {
    const auth = await registerAndWarm();
    expect({ claw1: auth("claw1"), clawd: auth("clawd") }).toEqual({ claw1: "oauth:claw1", clawd: "oauth:clawd" });
  });

  test("account and pool providers report no synthetic auth for a credential_failed login", async () => {
    writeFailed();
    const auth = await registerAndWarm();
    expect({ claw1: auth("claw1"), clawd: auth("clawd") }).toEqual({ claw1: undefined, clawd: undefined });
  });
});

describe("MEDIUM (ported): cache bound for an expired-but-proven login", () => {
  const acct = { id: "claw1", native: true };
  const setup = () => {
    const now = Date.now();
    const counter = { reads: 0 };
    const cache = createLoginAuthCache({
      io: io(() => {
        counter.reads += 1;
        return cred(now - HOUR);
      }),
      health: () => ({ lastSuccessAt: now - 60_000 }),
    });
    return { now, counter, cache };
  };

  test("one credential-source read per TTL across repeated peeks inside the TTL", async () => {
    const { now, counter, cache } = setup();
    await cache.refresh(acct, now);
    for (let i = 0; i < 50; i++) {
      const t = now + Math.floor((i * (LOGIN_AUTH_CACHE_TTL_MS - 1)) / 49);
      expect(cache.peek(acct, "claw1", t)?.apiKey).toBe("oauth:claw1");
      await Promise.resolve();
    }
    expect(counter.reads).toBe(1);
  });

  test("past the TTL: exactly one more read, and the verdict is re-served (not dropped)", async () => {
    const { now, counter, cache } = setup();
    await cache.refresh(acct, now);
    const t = now + LOGIN_AUTH_CACHE_TTL_MS;
    // A proof-based ok remains available while the refresh is pending.
    const atTtl = cache.peek(acct, "claw1", t)?.apiKey;
    await new Promise((r) => setTimeout(r, 0));
    expect(counter.reads).toBe(2);
    for (let i = 1; i < 20; i++) {
      expect(cache.peek(acct, "claw1", t + i * 1000)?.apiKey).toBe("oauth:claw1");
    }
    expect(counter.reads).toBe(2);
    expect(atTtl).toBe("oauth:claw1");
  });

  test("a cold peek never reads the credential file synchronously", async () => {
    const { now, counter, cache } = setup();
    expect(cache.peek(acct, "claw1", now)).toBeUndefined();
    expect(counter.reads).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(counter.reads).toBe(1);
  });
});

describe("#41 cache boundaries", () => {
  const acct = { id: "claw1", native: true };
  const ttl = LOGIN_AUTH_CACHE_TTL_MS;

  test("a token bound inside the TTL starts one refresh and sees a rewritten login", async () => {
    const now = Date.now();
    let raw = cred(now + 72_000); // expiry skew makes the serving bound +12s
    let reads = 0;
    const cache = createLoginAuthCache({
      io: io(() => { reads++; return raw; }),
    });
    await cache.refresh(acct, now);
    expect(cache.peek(acct, "claw1", now + 11_999)?.apiKey).toBe("oauth:claw1");
    raw = cred(now + 2 * HOUR);
    expect(cache.peek(acct, "claw1", now + 12_000)).toBeUndefined();
    expect(cache.peek(acct, "claw1", now + 12_001)).toBeUndefined();
    expect(reads).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(2);
    expect(cache.peek(acct, "claw1", now + 12_003)?.apiKey).toBe("oauth:claw1");
  });

  test("proof-only ok stays served during refresh, then ends at two TTLs", async () => {
    const now = Date.now();
    let reads = 0;
    const cache = createLoginAuthCache({
      io: io(() => { reads++; return cred(now - HOUR); }),
      health: () => ({ lastSuccessAt: now - 60_000 }),
    });
    await cache.refresh(acct, now);
    expect(cache.peek(acct, "claw1", now + ttl)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(acct, "claw1", now + 2 * ttl - 1)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(acct, "claw1", now + 2 * ttl)).toBeUndefined();
    expect(reads).toBe(1);
    await cache.refresh(acct, now + ttl);
    expect(reads).toBe(2);
  });

  test("recorded proof-only ok ends at the 24h proof bound", () => {
    const now = Date.now();
    const cache = createLoginAuthCache({
      io: io(() => cred(now - HOUR)),
      health: () => ({ lastSuccessAt: now - AUTH_PROOF_FRESH_MS + 10_000 }),
    });
    cache.record("claw1", { status: "ok", expiresAt: now - HOUR }, now);
    expect(cache.peek(acct, "claw1", now + 9_999)?.apiKey).toBe("oauth:claw1");
    expect(cache.peek(acct, "claw1", now + 10_000)).toBeUndefined();
  });

  test("record uses the same extra window, but no extra window without a known success", () => {
    const now = Date.now();
    let lastSuccessAt: number | undefined = now - 60_000;
    const cache = createLoginAuthCache({
      io: io(() => cred(now - HOUR)),
      health: () => ({ lastSuccessAt }),
    });
    cache.record("claw1", { status: "ok", expiresAt: now - HOUR }, now);
    expect(cache.peek(acct, "claw1", now + ttl)?.apiKey).toBe("oauth:claw1");
    lastSuccessAt = undefined;
    cache.record("claw1", { status: "ok", expiresAt: now - HOUR }, now);
    expect(cache.peek(acct, "claw1", now + ttl)).toBeUndefined();
  });

  test("a failure vetoes a proof-only ok while it is stale-served", async () => {
    const now = Date.now();
    let failed = false;
    const cache = createLoginAuthCache({
      io: io(() => cred(now - HOUR)),
      health: () => ({ lastSuccessAt: now - 60_000, failed }),
    });
    await cache.refresh(acct, now);
    expect(cache.peek(acct, "claw1", now + ttl)?.apiKey).toBe("oauth:claw1");
    failed = true;
    expect(cache.peek(acct, "claw1", now + ttl + 1)).toBeUndefined();
  });
});
