/**
 * Wiring test for #39 through the real `register()`: the provider the host
 * receives must answer `resolveSyntheticAuth` per account kind exactly as the
 * unit tests specify, and must refuse its own marker in `prepareRuntimeAuth`.
 * Real temp home, real credential files, real token file — the bug was never
 * in a helper, it was in what the registered provider answered.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted above the index.ts import: credential paths resolve through
// homedir() at call time, but the module is evaluated on import.
const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const plugin = (await import("../src/index.js")).default;

const HOUR = 60 * 60 * 1000;
const ACCESS = "fake-access-token-value";
const REFRESH = "fake-refresh-token-value";
const TOKEN = "sk-ant-oat01-fake-setup-token-value";

function cred(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt, scopes: ["user:inference"] },
  });
}

interface Provider {
  id: string;
  resolveSyntheticAuth?: (ctx: { provider: string }) => unknown;
  prepareRuntimeAuth?: (ctx: Record<string, unknown>) => Promise<unknown>;
}

function registerAll(): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  const api = {
    config: {},
    pluginConfig: {
      accounts: [
        { id: "claw1", native: true },
        { id: "claw2", configDir: "~/.claude-claw2" },
        { id: "claw3", oauthTokenFile: "~/claw3.token" },
      ],
      pool: { id: "clawd", accounts: ["claw2", "claw1", "claw3"] },
    },
    runtime: { config: { current: () => ({ plugins: { entries: {} } }) } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerCliBackend: () => {},
    registerProvider: (p: Provider) => providers.set(p.id, p),
    on: () => {},
  };
  plugin.register(api as never);
  return providers;
}

const auth = (p: Provider | undefined) => p?.resolveSyntheticAuth?.({ provider: p.id });

// The real credential io shells out to the macOS Keychain; this wiring test
// pins the file path the Linux host reads.
describe.skipIf(process.platform === "darwin")("register(): runtime auth per account kind", () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "mc-39-"));
    mkdirSync(join(home.dir, ".claude"), { recursive: true });
    mkdirSync(join(home.dir, ".claude-claw2"), { recursive: true });
    writeFileSync(join(home.dir, ".claude", ".credentials.json"), cred(Date.now() + 2 * HOUR));
    writeFileSync(join(home.dir, ".claude-claw2", ".credentials.json"), cred(Date.now() - HOUR));
    writeFileSync(join(home.dir, "claw3.token"), `${TOKEN}\n`, { mode: 0o600 });
  });
  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true });
  });

  test("native with a live login → oauth marker for its own provider id", () => {
    const providers = registerAll();
    const result = auth(providers.get("claw1")) as { apiKey: string; mode: string; expiresAt?: number; source: string };
    expect(result.apiKey).toBe("oauth:claw1");
    expect(result.mode).toBe("oauth");
    expect(result.source).toBe("claude login (claw1)");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain(ACCESS);
  });

  test("configDir with an expired, unproven login → nothing (host keeps missing-auth)", () => {
    expect(auth(registerAll().get("claw2"))).toBeUndefined();
  });

  test("token account keeps today's behaviour: the real token, mode token", () => {
    const result = auth(registerAll().get("claw3"));
    expect(result).toEqual({ apiKey: TOKEN, source: "multi-clawd claw3 token", mode: "token" });
  });

  test("pool reports the first live member, re-keyed to the pool's provider id", () => {
    const providers = registerAll();
    const result = auth(providers.get("clawd")) as { apiKey: string; source: string; mode: string };
    // Pool order is claw2 (dead) → claw1 (live): the marker names the pool.
    expect(result.apiKey).toBe("oauth:clawd");
    expect(result.source).toBe("claude login (claw1)");
    expect(result.mode).toBe("oauth");
    expect(JSON.stringify(result)).not.toContain(ACCESS);
  });

  test("pool with no live member → nothing", () => {
    writeFileSync(join(home.dir, ".claude", ".credentials.json"), cred(Date.now() - HOUR));
    rmSync(join(home.dir, "claw3.token"));
    expect(auth(registerAll().get("clawd"))).toBeUndefined();
  });

  test("every registered provider refuses its marker in prepareRuntimeAuth; a real token passes", async () => {
    const providers = registerAll();
    for (const id of ["claw1", "claw2", "claw3", "clawd"]) {
      const p = providers.get(id)!;
      expect(typeof p.prepareRuntimeAuth).toBe("function");
      await expect(
        p.prepareRuntimeAuth!({ provider: id, modelId: "claude-sonnet-5-5", apiKey: `oauth:${id}`, env: {} }),
      ).rejects.toThrow(/Claude Code CLI backend/);
    }
    await expect(
      providers.get("claw3")!.prepareRuntimeAuth!({ provider: "claw3", modelId: "m", apiKey: TOKEN, env: {} }),
    ).resolves.toBeUndefined();
  });

  test("the placeholder is only ever the host's non-secret marker — never a bare string a transport would bear", () => {
    const providers = registerAll();
    for (const id of ["claw1", "clawd"]) {
      const result = auth(providers.get(id)) as { apiKey: string };
      expect(result.apiKey).toMatch(/^oauth:[a-z0-9-]+$/);
      expect(result.apiKey).not.toMatch(/^sk-/);
    }
  });
});
