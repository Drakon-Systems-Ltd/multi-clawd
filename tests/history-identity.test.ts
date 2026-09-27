/**
 * #23 — the identity core derives a CLI history owner from.
 *
 * Core's derivation is restated here in small helpers (it lives in OpenClaw's
 * bundled runtime, `prepare.runtime-*.mjs`, region
 * `src/agents/cli-runner/history-boundary.ts`, not in the plugin SDK). Each
 * helper names the dist function whose rule it applies.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { buildIdentityCredential, ensureIdentityProfiles, hasIdentity, identityProfileId } =
  await import("../src/history-identity.js");
type ProviderAuthSdk = import("../src/history-identity.js").ProviderAuthSdk;
const {
  default: plugin,
  awaitHistoryIdentityEnsure,
  buildBackend,
  healthStateFile,
  registerPoolBackend,
  setProviderAuthSdkLoaderForTests,
} = await import("../src/index.js");

type Cred = Record<string, unknown>;

/**
 * Rule applied by `prepareCliHistoryBoundary`: an OAuth credential names an
 * owner only through a non-blank accountId or email; the owner tuple is then
 * the provider plus the account/identity fields. Anything else → no owner.
 */
function coreOwner(c: Cred | undefined): unknown[] | undefined {
  if (c?.type !== "oauth") return undefined;
  const named = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!named(c.accountId) && !named(c.email)) return undefined;
  return ["oauth", c.provider, c.accountId, c.email, c.clientId, c.enterpriseUrl, c.projectId];
}

/** `prepareCliHistoryBoundary`: sha256 over a versioned tag, the run provider and the owner. */
function coreFingerprint(runProvider: string, owner: unknown[] | undefined): string | undefined {
  if (!owner) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(["cli-history-v1", runProvider.trim().toLowerCase(), owner]))
    .digest("hex");
}

/** `isKnownCliHistoryBoundary`: the fingerprint shape a stored boundary must have. */
const CORE_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

/** `hasUsableOAuthCredential`: a live login needs a non-blank access token that has not expired. */
function coreUsableLogin(c: Cred): boolean {
  if (c.type !== "oauth") return false;
  if (typeof c.access !== "string" || c.access.trim() === "") return false;
  return typeof c.expires === "number" && c.expires - Date.now() > 300_000;
}

/** `normalizeRawCredentialEntry` (oauth branch): blank strings are dropped when core loads a row. */
function coreLoadRow(raw: Cred): Cred {
  const out: Cred = { type: "oauth", provider: String(raw.provider).trim().toLowerCase() };
  for (const f of ["email", "displayName", "access", "refresh", "accountId", "clientId", "enterpriseUrl", "projectId"]) {
    const v = raw[f];
    if (typeof v === "string" && v.trim() !== "") out[f] = v.trim();
  }
  if (raw.expires !== undefined) out.expires = typeof raw.expires === "number" && raw.expires > 0 ? raw.expires : 0;
  return out;
}

describe("identity credential → core history owner", () => {
  test("(i) the pool identity yields the owner shape core binds a history boundary to", () => {
    const owner = coreOwner(buildIdentityCredential("clawd") as unknown as Cred);
    expect(owner).toEqual(["oauth", "clawd", "multi-clawd:clawd", undefined, undefined, undefined, undefined]);
    expect(coreFingerprint("clawd", owner)).toMatch(CORE_FINGERPRINT_RE);
  });

  test("(i) the identity survives core's store load in every field the owner hashes", () => {
    const written = buildIdentityCredential("clawd") as unknown as Cred;
    const loaded = coreLoadRow(written);
    expect(coreOwner(loaded)).toEqual(coreOwner(written));
    expect(loaded).not.toHaveProperty("access");
    expect(loaded).not.toHaveProperty("refresh");
    expect(hasIdentity(loaded, buildIdentityCredential("clawd"))).toBe(true);
  });

  test("(ii) two backends produce two different owners and fingerprints", () => {
    const a = coreOwner(buildIdentityCredential("claw1") as unknown as Cred);
    const b = coreOwner(buildIdentityCredential("claw2") as unknown as Cred);
    const p = coreOwner(buildIdentityCredential("clawd") as unknown as Cred);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(p);
    expect(new Set([coreFingerprint("claw1", a), coreFingerprint("claw2", b), coreFingerprint("clawd", p)]).size).toBe(3);
    expect(identityProfileId("claw1")).not.toBe(identityProfileId("claw2"));
  });

  test("(ii) one pool is one owner: the identity depends on the backend id only, not the member", () => {
    // A rotation must not move the boundary: core keys the CLI session binding on
    // authProfileId + epoch (`resolveCliSessionReuse`), so a member-dependent
    // identity would reset the session on every rotation. See DESIGN.md.
    expect(buildIdentityCredential("clawd")).toEqual(buildIdentityCredential("clawd"));
    expect(JSON.stringify(buildIdentityCredential("clawd"))).not.toContain("claw1");
  });

  test("(iii) the identity is a name, never a login core could use", () => {
    const cred = buildIdentityCredential("clawd") as unknown as Cred;
    expect(coreUsableLogin(cred)).toBe(false);
    expect(cred.access).toBe("");
    expect(cred.refresh).toBe("");
    expect(JSON.stringify(cred)).not.toMatch(/sk-ant-/);
  });
});

// ---------------------------------------------------------------------------
// Wiring: the backend field core reads, and the store write the gateway makes.
// ---------------------------------------------------------------------------

function fakeSdk(initial: Record<string, unknown> = {}) {
  const profiles: Record<string, unknown> = { ...initial };
  const writes: Array<{ profileId: string; credential: unknown }> = [];
  const sdk: ProviderAuthSdk = {
    ensureAuthProfileStore: () => ({ profiles }),
    upsertAuthProfileWithLock: async (p) => {
      writes.push(p);
      profiles[p.profileId] = p.credential;
      return null;
    },
  };
  return { sdk, profiles, writes };
}

function writeAllowed(accountId: string): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    file,
    JSON.stringify({
      accountId,
      updatedAt: Date.now(),
      windows: { five_hour: { status: "allowed", utilization: 0.1, resetsAt: now + 3600, seenAt: Date.now() } },
    }),
  );
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-identity-"));
});

afterEach(() => {
  setProviderAuthSdkLoaderForTests(undefined);
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("wiring", () => {
  test("(iii) every backend points core at its identity profile", () => {
    expect(buildBackend({ id: "claw1", native: true }).defaultAuthProfileId).toBe("claw1:multi-clawd-identity");
    expect(buildBackend({ id: "claw2", configDir: "/tmp/claw2" }).defaultAuthProfileId).toBe("claw2:multi-clawd-identity");
  });

  test("(iii) the identity changes nothing about which account executes", async () => {
    let backend: { defaultAuthProfileId?: string; prepareExecution?: (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }> } | undefined;
    const api = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: (b: typeof backend) => {
        if (b?.prepareExecution) backend = b;
      },
      registerProvider: () => {},
    } as never;
    writeAllowed("claw1");
    writeAllowed("claw2");
    registerPoolBackend(
      api,
      { id: "clawd", accounts: ["claw1", "claw2"] },
      [{ id: "claw1", configDir: "/tmp/claw1-login" }, { id: "claw2", configDir: "/tmp/claw2-login" }],
      new Set(["claw1", "claw2"]),
    );
    expect(backend?.defaultAuthProfileId).toBe("clawd:multi-clawd-identity");
    // Core passes the selected profile id into prepareExecution; the pool ignores it.
    const withId = await backend!.prepareExecution!({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws", authProfileId: "clawd:multi-clawd-identity" });
    const without = await backend!.prepareExecution!({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });
    expect(withId.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claw1-login");
    expect(withId.env.CLAUDE_CONFIG_DIR).toBe(without.env.CLAUDE_CONFIG_DIR);
    expect(withId.env.MULTI_CLAWD_ACCOUNT_ID).toBe(without.env.MULTI_CLAWD_ACCOUNT_ID);
  });

  test("ensureIdentityProfiles writes missing profiles once and keeps correct ones", async () => {
    const { sdk, writes } = fakeSdk({ "claw1:multi-clawd-identity": buildIdentityCredential("claw1") });
    const first = await ensureIdentityProfiles(["claw1", "claw2", "clawd"], sdk);
    expect(first.kept).toEqual(["claw1:multi-clawd-identity"]);
    expect(first.written).toEqual(["claw2:multi-clawd-identity", "clawd:multi-clawd-identity"]);
    expect(first.failed).toEqual([]);
    const second = await ensureIdentityProfiles(["claw1", "claw2", "clawd"], sdk);
    expect(second.written).toEqual([]);
    expect(second.kept).toHaveLength(3);
    expect(writes).toHaveLength(2);
  });

  test("a store that cannot be read is never written to", async () => {
    const sdk: ProviderAuthSdk = {
      ensureAuthProfileStore: () => {
        throw new Error("locked");
      },
      upsertAuthProfileWithLock: async () => {
        throw new Error("must not be called");
      },
    };
    const result = await ensureIdentityProfiles(["clawd"], sdk);
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([{ profileId: "clawd:multi-clawd-identity", reason: "store read failed: Error: locked" }]);
  });

  test("(iv) register() stores one identity per registered backend id through the SDK, idempotently", async () => {
    const { sdk, profiles, writes } = fakeSdk();
    setProviderAuthSdkLoaderForTests(async () => sdk);
    const backends: Array<{ id: string; defaultAuthProfileId?: string }> = [];
    const info: string[] = [];
    const pluginConfig = {
      accounts: [{ id: "claw1", native: true }, { id: "claw2", configDir: "/tmp/claw2" }],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
    };
    const api = {
      registrationMode: "full",
      config: {},
      pluginConfig,
      runtime: { config: { current: () => ({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }) } },
      logger: { info: (m: string) => info.push(m), warn: () => {}, error: () => {} },
      registerCliBackend: (b: { id: string; defaultAuthProfileId?: string }) => backends.push(b),
      registerProvider: () => {},
      on: () => {},
    };
    plugin.register(api as never);
    const result = await awaitHistoryIdentityEnsure();
    expect(backends.map((b) => b.id).sort()).toEqual(["claw1", "claw2", "clawd"]);
    for (const b of backends) {
      // The consumer side: core reads defaultAuthProfileId, looks it up in the
      // store, and finds a credential that names an owner.
      expect(b.defaultAuthProfileId).toBe(identityProfileId(b.id));
      const stored = profiles[b.defaultAuthProfileId!] as Cred;
      expect(coreOwner(stored)).toEqual(["oauth", b.id, `multi-clawd:${b.id}`, undefined, undefined, undefined, undefined]);
    }
    expect(result?.written.sort()).toEqual(["claw1:multi-clawd-identity", "claw2:multi-clawd-identity", "clawd:multi-clawd-identity"]);
    expect(info.some((l) => l.includes("history identity: stored"))).toBe(true);

    // A config rebuild re-runs register(): nothing is rewritten.
    plugin.register(api as never);
    const again = await awaitHistoryIdentityEnsure();
    expect(again?.written).toEqual([]);
    expect(writes).toHaveLength(3);
  });

  test("(iv) historyIdentity: false makes no store call; non-full registration passes make none either", async () => {
    const { sdk, writes } = fakeSdk();
    setProviderAuthSdkLoaderForTests(async () => sdk);
    const base = {
      accounts: [{ id: "claw1", native: true }, { id: "claw2", configDir: "/tmp/claw2" }],
    };
    const mk = (pluginConfig: Record<string, unknown>, registrationMode: string) => ({
      registrationMode,
      config: {},
      pluginConfig,
      runtime: { config: { current: () => ({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }) } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: () => {},
      registerProvider: () => {},
      on: () => {},
    });
    plugin.register(mk({ ...base, historyIdentity: false }, "full") as never);
    expect(await awaitHistoryIdentityEnsure()).toBeUndefined();
    plugin.register(mk(base, "discovery") as never);
    expect(await awaitHistoryIdentityEnsure()).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  test("a core without the provider-auth SDK writers is skipped with a warning, never thrown", async () => {
    setProviderAuthSdkLoaderForTests(async () => undefined);
    const warn: string[] = [];
    const pluginConfig = { accounts: [{ id: "claw1", native: true }] };
    plugin.register({
      registrationMode: "full",
      config: {},
      pluginConfig,
      runtime: { config: { current: () => ({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }) } },
      logger: { info: () => {}, warn: (m: string) => warn.push(m), error: () => {} },
      registerCliBackend: () => {},
      registerProvider: () => {},
      on: () => {},
    } as never);
    expect(await awaitHistoryIdentityEnsure()).toBeUndefined();
    expect(warn.some((l) => l.includes("history identity") && l.includes("skipped"))).toBe(true);
  });
});
