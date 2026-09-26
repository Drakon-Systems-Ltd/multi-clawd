/**
 * The direct route through the real wire: register() → the order loop →
 * a spawned `openclaw` (a scripted fixture on disk) → the stored order.
 *
 * Two promises are pinned end to end, because each lives in the wiring rather
 * than in any helper:
 * - with no `direct` on any account the loop never starts — nothing spawns,
 *   nothing reads the auth store (the compatibility contract);
 * - with it, a near-limit home account is written to the BACK of the anthropic
 *   order from the same health file the CLI pool reads.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { default: plugin, runDirectOrderTickNow, stopDirectOrderSync, startDirectOrderSync, healthStateFile } =
  await import("../src/index.js");

const FAKE = resolve(__dirname, "fixtures", "fake-openclaw.mjs");
const NOW_S = Math.floor(Date.now() / 1000);

function makeApi(pluginConfig: unknown, mode: string | undefined = "full") {
  const info: string[] = [];
  const warn: string[] = [];
  const api = {
    ...(mode === undefined ? {} : { registrationMode: mode }),
    config: {},
    pluginConfig,
    runtime: { config: { current: () => ({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }) } },
    logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m), error: () => {} },
    registerCliBackend: () => {},
    registerProvider: () => {},
    on: () => {},
  };
  return { api, info, warn };
}

function calls(): Array<{ args: string[]; input: string }> {
  const f = join(process.env.FAKE_OPENCLAW_DIR!, "calls.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function writeHealth(accountId: string, utilization: number) {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      accountId,
      windows: {
        seven_day: { status: "allowed", utilization, resetsAt: NOW_S + 86_400, seenAt: Date.now() },
      },
    }),
  );
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-direct-home-"));
  process.env.FAKE_OPENCLAW_DIR = mkdtempSync(join(tmpdir(), "mc-fake-openclaw-"));
  process.env.FAKE_OPENCLAW_PROFILES = "anthropic:claw1,anthropic:claw2,anthropic:handmade";
});

afterEach(() => {
  stopDirectOrderSync();
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(process.env.FAKE_OPENCLAW_DIR!, { recursive: true, force: true });
});

const REF = { source: "exec", provider: "vault", id: "op://Vault/Item/field" };

describe("compatibility: no `direct`, no loop", () => {
  test("register() with CLI-only accounts starts nothing and spawns nothing", async () => {
    const { api, info } = makeApi({
      accounts: [
        { id: "claw1", native: true },
        { id: "claw2", configDir: "/tmp/x", oauthTokenRef: REF },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      directRoute: { openclawCommand: FAKE },
    });
    plugin.register(api as never);
    expect(await runDirectOrderTickNow()).toBeUndefined();
    expect(calls()).toEqual([]);
    expect(info.some((m) => m.includes("direct route"))).toBe(false);
  });
});

describe("the loop, end to end", () => {
  const config = {
    accounts: [
      { id: "claw1", native: true, direct: { profileId: "anthropic:claw1" } },
      { id: "claw2", configDir: "/tmp/x", oauthTokenRef: REF, direct: true },
    ],
    pool: { id: "clawd", accounts: ["claw1", "claw2"] },
    directRoute: { openclawCommand: FAKE },
  };

  test("near-limit home goes to the back of the anthropic order; a hand-made profile stays at the end", async () => {
    writeHealth("claw1", 0.95);
    writeFileSync(join(process.env.FAKE_OPENCLAW_DIR!, "order.json"), JSON.stringify(["anthropic:handmade"]));
    const { api, info } = makeApi(config);
    plugin.register(api as never);
    expect(info.some((m) => m.includes("direct route: keeping anthropic order"))).toBe(true);
    await runDirectOrderTickNow();
    const order = JSON.parse(readFileSync(join(process.env.FAKE_OPENCLAW_DIR!, "order.json"), "utf8"));
    expect(order).toEqual(["anthropic:claw2", "anthropic:claw1", "anthropic:handmade"]);
    // No call ever carried a secret: order management has no token to carry.
    for (const c of calls()) {
      expect(c.input).toBe("");
      expect(c.args.join(" ")).not.toMatch(/sk-ant|op:\/\//);
    }
  });

  test("a second tick with unchanged health spawns nothing", async () => {
    writeHealth("claw1", 0.2);
    const { api } = makeApi(config);
    plugin.register(api as never);
    await runDirectOrderTickNow();
    const n = calls().length;
    expect(JSON.parse(readFileSync(join(process.env.FAKE_OPENCLAW_DIR!, "order.json"), "utf8"))).toEqual([
      "anthropic:claw1",
      "anthropic:claw2",
      "anthropic:handmade",
    ]);
    await runDirectOrderTickNow();
    expect(calls().length).toBe(n);
  });

  test("re-registering with the same config keeps the loop (no stacked timers, memo kept)", async () => {
    const { api } = makeApi(config);
    plugin.register(api as never);
    await runDirectOrderTickNow();
    const n = calls().length;
    plugin.register(makeApi(config).api as never);
    await runDirectOrderTickNow();
    expect(calls().length).toBe(n);
  });

  test("manageOrder: false and non-full registration modes start nothing", () => {
    const logger = { info: () => {}, warn: () => {} };
    const accounts = config.accounts as never;
    expect(
      startDirectOrderSync({ accounts, directRoute: { manageOrder: false }, configOrder: () => undefined, logger })
        .active,
    ).toBe(false);
    for (const mode of ["discovery", "tool-discovery", "setup-runtime"]) {
      expect(startDirectOrderSync({ accounts, registrationMode: mode, configOrder: () => undefined, logger }).active).toBe(
        false,
      );
    }
    expect(startDirectOrderSync({ accounts, registrationMode: undefined, configOrder: () => undefined, logger }).active).toBe(
      true,
    );
  });

  test("an account that asked for the direct route and cannot is warned, not silently dropped", () => {
    const { api, warn } = makeApi({
      accounts: [
        { id: "claw1", native: true, direct: true },
        { id: "claw2", configDir: "/tmp/x", oauthTokenRef: REF, direct: true },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      directRoute: { openclawCommand: FAKE },
    });
    plugin.register(api as never);
    expect(warn.some((m) => m.includes('account "claw1" skipped') && m.includes("claude setup-token"))).toBe(true);
  });
});

describe("directRoute.agents validation", () => {
  test("an unusable agent id is dropped with a warning; the rest still run", async () => {
    const logs: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => logs.push(m) };
    const accounts = [
      { id: "claw1", oauthTokenRef: REF, direct: true },
      { id: "claw2", configDir: "/tmp/x", oauthTokenRef: { ...REF, id: "op://Vault/Other/field" }, direct: true },
    ] as never;
    const out = startDirectOrderSync({
      accounts,
      directRoute: { agents: ["main", "../evil", "has space"], openclawCommand: FAKE },
      configOrder: () => undefined,
      logger,
    });
    expect(out.active).toBe(true);
    expect(logs.filter((m) => m.includes("ignoring agent id"))).toHaveLength(2);
    const report = (await runDirectOrderTickNow()) as { agents: Array<{ agentId: string }> };
    expect(report.agents.map((a) => a.agentId)).toEqual(["main"]);
    const none = startDirectOrderSync({
      accounts,
      directRoute: { agents: ["bad id"], openclawCommand: FAKE },
      configOrder: () => undefined,
      logger,
    });
    expect(none.active).toBe(false);
  });
});

describe("removing every account", () => {
  test("a full pass with no accounts stops the loop; a discovery pass does not", async () => {
    const config = {
      accounts: [
        { id: "claw1", oauthTokenRef: REF, direct: true },
        { id: "claw2", configDir: "/tmp/x", oauthTokenRef: { ...REF, id: "op://Vault/Other/field" }, direct: true },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      directRoute: { openclawCommand: FAKE },
    };
    plugin.register(makeApi(config).api as never);
    plugin.register(makeApi({ accounts: [] }, "discovery").api as never);
    expect(await runDirectOrderTickNow()).toBeDefined();
    plugin.register(makeApi({ accounts: [] }).api as never);
    expect(await runDirectOrderTickNow()).toBeUndefined();
  });
});
