/**
 * #52: a cached `ok` login verdict after the stored login goes missing or
 * unreadable. The cache deliberately serves last-known-good for a bounded
 * window (the hook never reads the credential source synchronously); these
 * tests pin that window and that the next completed refresh drops the
 * account — and a pool whose only available member it was. Injected IO and
 * temp fixtures only; placeholder credential strings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  AUTH_PROOF_FRESH_MS,
  type CredentialIo,
  type KeychainRead,
} from "../src/login-health.js";
import { LOGIN_AUTH_CACHE_TTL_MS, createLoginAuthCache, poolRuntimeAuth } from "../src/runtime-auth.js";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const HOUR = 60 * 60 * 1000;
const ttl = LOGIN_AUTH_CACHE_TTL_MS;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const cred = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: "test-access-token-1", refreshToken: "test-refresh-token-1", expiresAt },
  });

type Source = "present" | "missing" | "unreadable";

const fsError = (code: string) => Object.assign(new Error(`${code}: test fixture`), { code });

/** Linux file io whose per-path state the test flips; counts every read. */
function sourceIo(contents: Record<string, string>) {
  const state: Record<string, Source> = {};
  const reads = { n: 0 };
  const io: CredentialIo = {
    readFile: (path) => {
      reads.n += 1;
      const s = state[path] ?? "missing";
      if (s === "missing") throw fsError("ENOENT");
      if (s === "unreadable") throw fsError("EACCES");
      return contents[path] ?? "";
    },
    expandHome: (p) => p,
    readKeychainItem: () => ({ status: "absent" }),
    keychainAccount: "test",
    platform: "linux",
  };
  return { io, state, reads };
}

const native = { id: "claw1", native: true };
const configDir = { id: "claw2", configDir: "~/.claude-claw2" };
const pathOf = (a: { native?: boolean; configDir?: string }) =>
  `${a.native ? "~/.claude" : a.configDir}/.credentials.json`;

/**
 * token: an unexpired stored access token (hard bound = its expiry less skew).
 * proof: an expired token proven by a recent successful turn (hard bound =
 * min(assessment + 2*ttl, lastSuccessAt + 24h)).
 */
const kinds = {
  token: {
    raw: cred(T0 + 2 * HOUR),
    lastSuccessAt: undefined as number | undefined,
    hardUntil: T0 + 2 * HOUR - ACCESS_TOKEN_EXPIRY_SKEW_MS,
  },
  proof: { raw: cred(T0 - HOUR), lastSuccessAt: T0 - 60_000 as number | undefined, hardUntil: T0 + 2 * ttl },
};

function setup(kind: keyof typeof kinds, account: typeof native | typeof configDir) {
  const k = kinds[kind];
  const src = sourceIo({ [pathOf(account)]: k.raw });
  src.state[pathOf(account)] = "present";
  const cache = createLoginAuthCache({ io: src.io, health: () => ({ lastSuccessAt: k.lastSuccessAt }) });
  return { ...src, cache, k };
}

const matrix = (["token", "proof"] as const).flatMap((kind) =>
  (["missing", "unreadable"] as const).flatMap((lost) =>
    [native, configDir].map((account) => ({ kind, lost, account })),
  ),
);

describe("#52 source lost after an ok verdict (injected io)", () => {
  test.each(matrix)("$kind ok, source $lost, $account.id: served only inside the cached window", async ({
    kind,
    lost,
    account,
  }) => {
    const { cache, state, reads, k } = setup(kind, account);
    await cache.refresh(account, T0);
    expect(cache.peek(account, account.id, T0)?.apiKey).toBe(`oauth:${account.id}`);
    state[pathOf(account)] = lost;
    // Documents current behaviour: last-known-good inside the window, with
    // no synchronous read of the (now lost) source.
    expect(cache.peek(account, account.id, T0 + 1)?.apiKey).toBe(`oauth:${account.id}`);
    expect(cache.peek(account, account.id, T0 + ttl - 1)?.apiKey).toBe(`oauth:${account.id}`);
    expect(reads.n).toBe(1);
    // Never at or past the hard bound, even before any refresh lands.
    expect(cache.peek(account, account.id, k.hardUntil)).toBeUndefined();
    expect(cache.peek(account, account.id, k.hardUntil + 1)).toBeUndefined();
    expect(reads.n).toBe(1);
  });

  test.each(matrix)("$kind ok, source $lost, $account.id: the scheduled refresh stores no stale ok", async ({
    kind,
    lost,
    account,
  }) => {
    const { cache, state, reads } = setup(kind, account);
    await cache.refresh(account, T0);
    state[pathOf(account)] = lost;
    // The first peek past the TTL still serves (refresh pending) and starts the refresh.
    expect(cache.peek(account, account.id, T0 + ttl)?.apiKey).toBe(`oauth:${account.id}`);
    await cache.refresh(account, T0 + ttl); // joins the in-flight refresh
    expect(reads.n).toBe(2);
    expect(cache.peek(account, account.id, T0 + ttl + 1)).toBeUndefined();
    expect(cache.peek(account, account.id, T0 + 2 * ttl - 1)).toBeUndefined();
  });

  test.each(matrix)("$kind ok, source $lost, $account.id: a pool whose only available member it was", async ({
    kind,
    lost,
    account,
  }) => {
    const k = kinds[kind];
    const other = account === native ? configDir : native;
    // The other member's login is missing from the start: never available.
    const src = sourceIo({ [pathOf(account)]: k.raw });
    src.state[pathOf(account)] = "present";
    const cache = createLoginAuthCache({ io: src.io, health: () => ({ lastSuccessAt: k.lastSuccessAt }) });
    await Promise.all([cache.refresh(account, T0), cache.refresh(other, T0)]);
    // Wired as src/index.ts resolveSyntheticAuth wires a pool.
    const pool = (t: number) =>
      poolRuntimeAuth(
        "clawd",
        [native, configDir].map((m) => () => cache.peek(m, m.id, t)),
      )?.apiKey;
    expect(pool(T0)).toBe("oauth:clawd");
    expect(cache.peek(other, other.id, T0)).toBeUndefined();
    src.state[pathOf(account)] = lost;
    expect(pool(T0 + ttl - 1)).toBe("oauth:clawd");
    expect(pool(T0 + ttl)).toBe("oauth:clawd"); // stale-served; starts the refreshes
    await Promise.all([cache.refresh(account, T0 + ttl), cache.refresh(other, T0 + ttl)]);
    expect(pool(T0 + ttl + 1)).toBeUndefined();
  });

  test("macOS: a lost Keychain item (absent, unreadable, or a failed read) drops the account on refresh", async () => {
    for (const read of ["absent", "unreadable", "rejects"] as const) {
      let current: "data" | typeof read = "data";
      const io: CredentialIo = {
        readFile: () => {
          throw fsError("ENOENT");
        },
        expandHome: (p) => p,
        readKeychainItem: () => ({ status: "absent" }),
        keychainAccount: "test",
        platform: "darwin",
      };
      const cache = createLoginAuthCache({
        io,
        readKeychainItemAsync: async (): Promise<KeychainRead> => {
          if (current === "data") return { status: "found", data: cred(T0 + 2 * HOUR) };
          if (current === "rejects") throw new Error("test: security failed");
          return { status: current };
        },
      });
      for (const account of [native, configDir]) {
        await cache.refresh(account, T0);
        expect(cache.peek(account, account.id, T0)?.apiKey).toBe(`oauth:${account.id}`);
      }
      current = read;
      for (const account of [native, configDir]) {
        expect(cache.peek(account, account.id, T0 + ttl)?.apiKey).toBe(`oauth:${account.id}`);
        await cache.refresh(account, T0 + ttl);
        expect(cache.peek(account, account.id, T0 + ttl + 1), `${read} ${account.id}`).toBeUndefined();
      }
    }
  });

  test("a recorded CLI failure removes the stale-served account at once", async () => {
    let failed = false;
    const { io, state } = sourceIo({ [pathOf(native)]: cred(T0 + 2 * HOUR) });
    state[pathOf(native)] = "present";
    const cache = createLoginAuthCache({ io, health: () => ({ failed }) });
    await cache.refresh(native, T0);
    state[pathOf(native)] = "missing";
    expect(cache.peek(native, "claw1", T0 + 1)?.apiKey).toBe("oauth:claw1");
    failed = true;
    expect(cache.peek(native, "claw1", T0 + 2)).toBeUndefined();
  });
});

describe("#52 worst-case stale window (fake timers, exact boundaries)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Peek at an absolute clock time without letting any pending refresh run. */
  const peekAt = (cache: ReturnType<typeof createLoginAuthCache>, t: number, account = native) => {
    vi.setSystemTime(t);
    return cache.peek(account, account.id)?.apiKey;
  };

  test("proof-only ok: assessment + 2*ttl when the proof is recent (equality refuses)", async () => {
    const { io, state } = sourceIo({ [pathOf(native)]: cred(T0 - HOUR) });
    state[pathOf(native)] = "present";
    const cache = createLoginAuthCache({ io, health: () => ({ lastSuccessAt: T0 - 60_000 }) });
    await cache.refresh(native);
    state[pathOf(native)] = "missing";
    expect(peekAt(cache, T0 + ttl)).toBe("oauth:claw1"); // refresh now pending
    expect(peekAt(cache, T0 + 2 * ttl - 1)).toBe("oauth:claw1");
    expect(peekAt(cache, T0 + 2 * ttl)).toBeUndefined();
  });

  test("proof-only ok: lastSuccessAt + 24h when that is earlier (equality refuses)", async () => {
    const lastSuccessAt = T0 - AUTH_PROOF_FRESH_MS + 10_000;
    const { io, state } = sourceIo({ [pathOf(native)]: cred(lastSuccessAt - HOUR) });
    state[pathOf(native)] = "present";
    const cache = createLoginAuthCache({ io, health: () => ({ lastSuccessAt }) });
    await cache.refresh(native);
    expect(peekAt(cache, T0)).toBe("oauth:claw1");
    state[pathOf(native)] = "unreadable";
    expect(peekAt(cache, T0 + 9_999)).toBe("oauth:claw1");
    expect(peekAt(cache, T0 + 10_000)).toBeUndefined();
    expect(T0 + 10_000).toBeLessThan(T0 + 2 * ttl);
  });

  test("plain ok (no token expiry, no known success): assessment + ttl (equality refuses)", () => {
    const { io } = sourceIo({});
    const cache = createLoginAuthCache({ io });
    cache.record("claw1", { status: "ok" });
    expect(peekAt(cache, T0 + ttl - 1)).toBe("oauth:claw1");
    expect(peekAt(cache, T0 + ttl)).toBeUndefined();
  });

  test("token ok whose expiry bound falls inside the ttl: that bound (equality refuses)", async () => {
    const { io, state } = sourceIo({ [pathOf(native)]: cred(T0 + 72_000) });
    state[pathOf(native)] = "present";
    const cache = createLoginAuthCache({ io });
    await cache.refresh(native);
    state[pathOf(native)] = "missing";
    const bound = T0 + 72_000 - ACCESS_TOKEN_EXPIRY_SKEW_MS;
    expect(bound).toBeLessThan(T0 + ttl);
    expect(peekAt(cache, bound - 1)).toBe("oauth:claw1");
    expect(peekAt(cache, bound)).toBeUndefined();
  });

  test("token ok past the ttl: served only while the refresh is pending, never past the token bound", async () => {
    // A refresh that never lands (a hung Keychain read) is the worst case.
    let hang = false;
    const io: CredentialIo = {
      readFile: () => {
        throw fsError("ENOENT");
      },
      expandHome: (p) => p,
      readKeychainItem: () => ({ status: "absent" }),
      keychainAccount: "test",
      platform: "darwin",
    };
    const cache = createLoginAuthCache({
      io,
      readKeychainItemAsync: (): Promise<KeychainRead> =>
        hang ? new Promise(() => {}) : Promise.resolve<KeychainRead>({ status: "found", data: cred(T0 + 2 * HOUR) }),
    });
    await cache.refresh(native);
    hang = true;
    const bound = T0 + 2 * HOUR - ACCESS_TOKEN_EXPIRY_SKEW_MS;
    expect(peekAt(cache, T0 + ttl)).toBe("oauth:claw1");
    await vi.advanceTimersByTimeAsync(0);
    expect(peekAt(cache, bound - 1)).toBe("oauth:claw1");
    expect(peekAt(cache, bound)).toBeUndefined();
  });

  test("token ok past the ttl: once the refresh lands on a lost source the account is gone", async () => {
    const { io, state } = sourceIo({ [pathOf(native)]: cred(T0 + 2 * HOUR) });
    state[pathOf(native)] = "present";
    const cache = createLoginAuthCache({ io });
    await cache.refresh(native);
    state[pathOf(native)] = "missing";
    expect(peekAt(cache, T0 + ttl)).toBe("oauth:claw1");
    await vi.advanceTimersByTimeAsync(0);
    expect(peekAt(cache, T0 + ttl)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "darwin")("#52 through register(): login file lost after warm-up", () => {
  beforeEach(() => {
    vi.resetModules();
    home.dir = mkdtempSync(join(tmpdir(), "mc-52-"));
    mkdirSync(join(home.dir, ".claude"), { recursive: true });
    mkdirSync(join(home.dir, ".claude-claw2"), { recursive: true });
    writeFileSync(join(home.dir, ".claude", ".credentials.json"), cred(Date.now() + 2 * HOUR));
    // claw2's login is expired and unproven: never available, so claw1 is the pool's only member.
    writeFileSync(join(home.dir, ".claude-claw2", ".credentials.json"), cred(Date.now() - HOUR));
  });
  afterEach(() => rmSync(home.dir, { recursive: true, force: true }));

  async function registerAndWarm() {
    const index = await import("../src/index.js");
    const providers = new Map<string, { id: string; resolveSyntheticAuth?: (c: unknown) => unknown }>();
    index.default.register({
      config: {},
      pluginConfig: {
        accounts: [native, configDir],
        pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      },
      runtime: { config: { current: () => ({ plugins: { entries: {} } }) } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: () => {},
      registerProvider: (p: { id: string }) => providers.set(p.id, p),
      on: () => {},
    } as never);
    await index.loginAuthWarmed();
    const auth = (id: string) =>
      (providers.get(id)?.resolveSyntheticAuth?.({ provider: id }) as { apiKey?: string } | undefined)?.apiKey;
    return { index, auth };
  }

  for (const lost of ["missing", "unreadable"] as const) {
    test(`login file ${lost}: account and pool drop after the next refresh`, async () => {
      const { index, auth } = await registerAndWarm();
      expect({ claw1: auth("claw1"), claw2: auth("claw2"), clawd: auth("clawd") }).toEqual({
        claw1: "oauth:claw1",
        claw2: undefined,
        clawd: "oauth:clawd",
      });
      const file = join(home.dir, ".claude", ".credentials.json");
      rmSync(file);
      // A directory in its place: the read throws (EISDIR) even for root.
      if (lost === "unreadable") mkdirSync(file);
      await index.warmLoginAuth([native]);
      expect({ claw1: auth("claw1"), clawd: auth("clawd") }).toEqual({ claw1: undefined, clawd: undefined });
    });
  }
});
