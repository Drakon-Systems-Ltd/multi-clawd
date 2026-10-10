/**
 * Live usage polling through the real wire: register() → the poll loop → a
 * scripted endpoint → the health file → the SAME prepareExecution the pool
 * uses for every launch → the account the next turn would run on.
 *
 * Pinned end to end, because each promise lives in the wiring rather than in a
 * helper:
 * - a 5-hour window the provider reports at 90% rotates the next launch off
 *   the home account — the case the stream's bare status could never pre-empt;
 * - 100% is `exhausted` with the provider's own reset, and recovers at it;
 * - the warn threshold raises an operator alert that clears itself when the
 *   number falls;
 * - the poll is read-only on credentials, skips what it must not read
 *   (token-based accounts, expired tokens) and keeps the shim's own records;
 * - off by config, off outside a full registration, no stacked timers.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const {
  default: plugin,
  healthStateFile,
  pendingOperatorAlerts,
  runUsagePollTickNow,
  startUsagePoll,
  stopUsagePoll,
  usagePollCredentialsFile,
  usageStateFile,
} = await import("../src/index.js");
const { parseStoredState } = await import("../src/shim-core.js");

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** Scripted endpoint: per-token usage bodies, with a call log. */
function fakeEndpoint(byToken: Record<string, Record<string, unknown> | number>) {
  const calls: Array<{ auth: string; beta: string }> = [];
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers.Authorization.replace(/^Bearer /, "");
    calls.push({ auth: init.headers.Authorization, beta: init.headers["anthropic-beta"] });
    const scripted = byToken[token];
    if (scripted === undefined) return { status: 401, json: async () => ({}) };
    if (typeof scripted === "number") return { status: scripted, json: async () => ({}) };
    return { status: 200, json: async () => scripted };
  };
  return { fetchImpl, calls };
}

function usageBody(fiveHourPct: number, weeklyPct = 20, fiveHourResetMs = 60 * 60_000) {
  return {
    five_hour: { utilization: fiveHourPct, resets_at: iso(fiveHourResetMs) },
    seven_day: { utilization: weeklyPct, resets_at: iso(2 * 86_400_000) },
    seven_day_opus: null,
    limits: [],
  };
}

function writeCredentials(configDir: string, token: string, expiresAt = Date.now() + 3_600_000) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }), {
    mode: 0o600,
  });
}

function makeApi(pluginConfig: unknown, mode: string | undefined = "full") {
  const info: string[] = [];
  const warn: string[] = [];
  let backend: { id?: string; prepareExecution?: unknown } | undefined;
  const api = {
    ...(mode === undefined ? {} : { registrationMode: mode }),
    config: {},
    pluginConfig,
    runtime: { config: { current: () => ({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }) } },
    logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m), error: () => {} },
    registerCliBackend: (b: { id?: string; prepareExecution?: unknown }) => {
      if (b.id === "clawd") backend = b;
    },
    registerProvider: () => {},
    on: () => {},
  };
  const prepare = async (modelId = "clawd/claude-opus-5-5") => {
    if (!backend?.prepareExecution) throw new Error("pool backend did not register");
    const fn = backend.prepareExecution as (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }>;
    const { env } = await fn({ modelId, workspaceDir: "/tmp/ws" });
    return env.MULTI_CLAWD_ACCOUNT_ID ?? env.CLAUDE_CONFIG_DIR ?? "(none)";
  };
  return { api, info, warn, prepare };
}

let claw1Dir: string;
let claw2Dir: string;
const logger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-usage-home-"));
  claw1Dir = join(home.dir, ".claude");
  claw2Dir = join(home.dir, ".claude-two");
  writeCredentials(claw1Dir, "tok-one");
  writeCredentials(claw2Dir, "tok-two");
});

afterEach(() => {
  stopUsagePoll();
  rmSync(home.dir, { recursive: true, force: true });
});

const accounts = () => [
  { id: "claw1", native: true },
  { id: "claw2", configDir: claw2Dir },
];
const pool = (extra: Record<string, unknown> = {}) => ({ id: "clawd", accounts: ["claw1", "claw2"], ...extra });

describe("the poll feeds the selector", () => {
  test("a 5-hour window at 90% rotates the next launch off home; 100% is exhausted until the provider's reset", async () => {
    const endpoint = fakeEndpoint({ "tok-one": usageBody(90), "tok-two": usageBody(5) });
    const { api, prepare, info } = makeApi({ accounts: accounts(), pool: pool() });
    plugin.register(api as never);
    expect(info.some((m) => m.includes("usage poll: reading live usage for claw1, claw2"))).toBe(true);
    // Before the first tick there is no telemetry at all: home wins.
    expect(await prepare()).toContain("claw1");

    // register() wires the global fetch; re-point the loop at the scripted endpoint.
    startUsagePoll({ accounts: accounts(), pool: pool(), registrationMode: "full", logger, fetchImpl: endpoint.fetchImpl });
    const report = await runUsagePollTickNow();
    expect(report?.accounts.map((a) => [a.id, a.verdict])).toEqual([
      ["claw1", "near_limit"],
      ["claw2", "ok"],
    ]);
    // The bearer token went only to the endpoint, with the OAuth beta header.
    expect(endpoint.calls.map((c) => c.auth).sort()).toEqual(["Bearer tok-one", "Bearer tok-two"]);
    expect(endpoint.calls.every((c) => c.beta === "oauth-2025-04-20")).toBe(true);

    // The poll writes its OWN file (v1.10.1); the shim's health file is never
    // created or rewritten by a tick.
    const state = parseStoredState(readFileSync(usageStateFile("claw1"), "utf8"))!;
    expect(state.windows["usage:five_hour"].utilization).toBeCloseTo(0.9);
    expect(state.windows["usage:five_hour"].status).toBe("allowed");
    expect(statSync(usageStateFile("claw1")).mode & 0o777).toBe(0o600);
    expect(existsSync(healthStateFile("claw1"))).toBe(false);

    // THE point: the next launch runs on the spare, before any turn was refused.
    expect(await prepare()).toContain("claw2");

    // Now the provider says 100%: exhausted, for every model, until reset.
    endpoint.calls.length = 0;
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(100, 20, 30 * 60_000), "tok-two": usageBody(5) }).fetchImpl,
    });
    const second = await runUsagePollTickNow();
    expect(second?.accounts[0].verdict).toBe("exhausted");
    const exhausted = parseStoredState(readFileSync(usageStateFile("claw1"), "utf8"))!;
    expect(exhausted.windows["usage:five_hour"].status).toBe("rejected");
    expect(await prepare("clawd/claude-sonnet-5-5")).toContain("claw2");
  });

  test("the shim's own records survive the poll's write, and the poll's survive the shim's", async () => {
    const { api, prepare } = makeApi({ accounts: accounts(), pool: pool() });
    plugin.register(api as never);
    // A shim-written weekly observation on disk...
    const file = healthStateFile("claw1");
    mkdirSync(join(file, ".."), { recursive: true });
    const shimSeen = Date.now() - 60_000;
    writeFileSync(
      file,
      JSON.stringify({
        accountId: "claw1",
        updatedAt: shimSeen,
        windows: {
          seven_day: { status: "allowed_warning", utilization: 0.3, resetsAt: Math.floor(Date.now() / 1000) + 86_400, seenAt: shimSeen },
          five_hour: { status: "allowed", resetsAt: Math.floor(Date.now() / 1000) + 3600, seenAt: shimSeen },
        },
        credential: { status: "ok", seenAt: shimSeen },
      }),
    );
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(40), "tok-two": usageBody(5) }).fetchImpl,
    });
    const shimBytes = readFileSync(file, "utf8");
    await runUsagePollTickNow();
    // ...is byte-for-byte untouched: the poll never opens the shim's file for
    // writing, so there is no read-merge-write of it to lose an update against.
    expect(readFileSync(file, "utf8")).toBe(shimBytes);
    const usage = parseStoredState(readFileSync(usageStateFile("claw1"), "utf8"))!;
    expect(usage.windows["usage:five_hour"].utilization).toBeCloseTo(0.4);
    expect(usage.windows["usage:seven_day"].utilization).toBeCloseTo(0.2);
    expect(usage.windows.seven_day).toBeUndefined();
    // Both records reach the selector at once: 40% usage keeps claw1 home...
    expect(await prepare()).toContain("claw1");
    // ...and the race's losing interleave — the shim commits a rejection AFTER
    // the poll took its read — is now harmless: the shim's write lands in its
    // own file and the next launch sees it next to the fresh usage figures.
    const shimRejected = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        ...JSON.parse(shimBytes),
        updatedAt: shimRejected,
        windows: {
          ...JSON.parse(shimBytes).windows,
          five_hour: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, seenAt: shimRejected },
        },
      }),
    );
    expect(await prepare()).toContain("claw2");
    const stillFresh = parseStoredState(readFileSync(usageStateFile("claw1"), "utf8"))!;
    expect(stillFresh.windows["usage:five_hour"].utilization).toBeCloseTo(0.4);
  });
});

describe("the warn threshold reaches the operator", () => {
  test("96% raises an alert naming the account, window and hand-over; it clears when the number falls", async () => {
    const hot = fakeEndpoint({ "tok-one": usageBody(96, 20, 45 * 60_000), "tok-two": usageBody(5) });
    const lines: string[] = [];
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      fetchImpl: hot.fetchImpl,
    });
    const report = await runUsagePollTickNow();
    expect(report?.raised).toEqual(["usage:clawd:claw1:five_hour"]);
    const text = pendingOperatorAlerts(Date.now()) ?? "";
    expect(text).toContain("[multi-clawd] ERROR");
    expect(text).toContain('account "claw1" 5-hour usage at 96%');
    expect(text).toContain("resets in ~45m");
    expect(text).toContain("new launches route to claw2");
    // The token reached the endpoint and nothing else: not the alert, not the
    // journal, not the health file, not the tick report.
    for (const surface of [text, lines.join("\n"), readFileSync(usageStateFile("claw1"), "utf8"), JSON.stringify(report)]) {
      expect(surface).not.toContain("tok-one");
    }

    // Below the line again (the window reset): the alert ends on the next tick.
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(3), "tok-two": usageBody(5) }).fetchImpl,
    });
    const after = await runUsagePollTickNow();
    expect(after?.cleared).toEqual(["usage:clawd:claw1:five_hour"]);
    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toContain("5-hour usage");
  });

  test("every account hot raises the pool-wide alert; a custom warnThreshold is honoured", async () => {
    startUsagePoll({
      accounts: accounts(),
      pool: pool({ usagePoll: { warnThreshold: 0.8 } }),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(85), "tok-two": usageBody(10, 82) }).fetchImpl,
    });
    const report = await runUsagePollTickNow();
    expect(report?.raised.sort()).toEqual(["usage-pool:clawd", "usage:clawd:claw1:five_hour", "usage:clawd:claw2:seven_day"]);
    expect(pendingOperatorAlerts(Date.now()) ?? "").toContain("EVERY account is above 80%");
  });
});

describe("what the poll must not do", () => {
  test("credentials are read, never written; an expired token is skipped and the CLI's file is left alone", async () => {
    writeCredentials(claw1Dir, "tok-one", Date.now() - 1);
    const before = readFileSync(join(claw1Dir, ".credentials.json"), "utf8");
    const endpoint = fakeEndpoint({ "tok-one": usageBody(99), "tok-two": usageBody(5) });
    const warn: string[] = [];
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger: { info: () => {}, warn: (m) => warn.push(m) },
      fetchImpl: endpoint.fetchImpl,
    });
    const report = await runUsagePollTickNow();
    expect(report?.accounts[0].skipped).toMatch(/expired/);
    expect(endpoint.calls.map((c) => c.auth)).toEqual(["Bearer tok-two"]); // the expired token was never sent
    expect(readFileSync(join(claw1Dir, ".credentials.json"), "utf8")).toBe(before);
    expect(warn.some((m) => m.includes('account "claw1"') && m.includes("expired"))).toBe(true);
    // Said once, not per tick.
    await runUsagePollTickNow();
    expect(warn.filter((m) => m.includes("expired"))).toHaveLength(1);
    // The skipped account got no write of either file (no file at all here).
    expect(() => readFileSync(healthStateFile("claw1"))).toThrow();
    expect(() => readFileSync(usageStateFile("claw1"))).toThrow();
  });

  test("a token-based account is not polled: its credentials file is another login's", () => {
    expect(usagePollCredentialsFile({ id: "claw3", oauthTokenRef: { source: "exec", provider: "vault", id: "op://Vault/Item/field" } })).toMatchObject({
      reason: expect.stringContaining("setup-token login"),
    });
    expect(usagePollCredentialsFile({ id: "claw3", configDir: "/tmp/x", oauthTokenFile: "/tmp/t" })).toMatchObject({
      reason: expect.stringContaining("setup-token login"),
    });
    expect(usagePollCredentialsFile({ id: "claw1", native: true })).toEqual({ file: join(home.dir, ".claude", ".credentials.json") });
    expect(usagePollCredentialsFile({ id: "claw2", configDir: claw2Dir })).toEqual({ file: join(claw2Dir, ".credentials.json") });
    const info: string[] = [];
    const r = startUsagePoll({
      accounts: [{ id: "claw1", native: true }, { id: "claw3", configDir: "/tmp/x", oauthTokenRef: { source: "exec", provider: "vault", id: "op://V/I/f" } }],
      pool: { id: "clawd", accounts: ["claw1", "claw3"] },
      registrationMode: "full",
      logger: { info: (m) => info.push(m), warn: () => {} },
    });
    expect(r).toEqual({ active: true, members: ["claw1"] });
    expect(info.at(-1)).toContain("not polled: claw3 (setup-token login");
  });

  test("a tick that cannot read an account leaves that account's live alert — and the pool-wide one — exactly as they were", async () => {
    // Both accounts hot: per-account alerts plus the pool-wide alert.
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(100), "tok-two": usageBody(97) }).fetchImpl,
    });
    const first = await runUsagePollTickNow();
    expect(first?.raised.sort()).toEqual(["usage-pool:clawd", "usage:clawd:claw1:five_hour", "usage:clawd:claw2:five_hour"]);
    // Now claw1 — idle because exhausted, so its token is never refreshed —
    // cannot be read, while claw2 is still hot. Nothing about claw1 is known.
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": 429, "tok-two": usageBody(97) }).fetchImpl,
    });
    const second = await runUsagePollTickNow();
    expect(second?.accounts[0].failure).toMatchObject({ kind: "throttled" });
    expect(second?.cleared).toEqual([]);
    const text = pendingOperatorAlerts(Date.now()) ?? "";
    expect(text).toContain('account "claw1" 5-hour usage at 100%');
    expect(text).toContain("EVERY account is above 95%");
    // And a tick that KNOWS claw1 recovered ends both.
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger,
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(2), "tok-two": usageBody(97) }).fetchImpl,
    });
    const third = await runUsagePollTickNow();
    expect(third?.cleared.sort()).toEqual(["usage-pool:clawd", "usage:clawd:claw1:five_hour"]);
    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toContain("EVERY account");
  });

  test("a present but unreadable health file is left alone; the poll still writes its own file and reports UNKNOWN", async () => {
    const file = healthStateFile("claw1");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ this is not json");
    const warn: string[] = [];
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger: { info: () => {}, warn: (m) => warn.push(m) },
      fetchImpl: fakeEndpoint({ "tok-one": usageBody(50), "tok-two": usageBody(5) }).fetchImpl,
    });
    const report = await runUsagePollTickNow();
    expect(report?.accounts[0].skipped).toContain("health file unreadable");
    expect(report?.accounts[0].verdict).toBe("no_data");
    // The shim's bytes are untouched (v1.10.1: the poll never writes this file)...
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
    expect(warn.some((m) => m.includes('"claw1"') && m.includes("health file unreadable"))).toBe(true);
    // ...and the poll's own file is written regardless: nothing of the shim's
    // is at stake there, and the figures are current when the shim's file heals.
    expect(parseStoredState(readFileSync(usageStateFile("claw1"), "utf8"))!.windows["usage:five_hour"].utilization).toBeCloseTo(0.5);
    // claw2's write is unaffected.
    expect(parseStoredState(readFileSync(usageStateFile("claw2"), "utf8"))!.windows["usage:five_hour"].utilization).toBeCloseTo(0.05);
  });

  test("an endpoint failure changes nothing on disk and is logged once per transition", async () => {
    const warn: string[] = [];
    startUsagePoll({
      accounts: accounts(),
      pool: pool(),
      registrationMode: "full",
      logger: { info: () => {}, warn: (m) => warn.push(m) },
      fetchImpl: fakeEndpoint({ "tok-one": 503, "tok-two": usageBody(5) }).fetchImpl,
    });
    const report = await runUsagePollTickNow();
    expect(report?.accounts[0].failure).toMatchObject({ kind: "transient" });
    expect(report?.accounts[0].verdict).toBe("no_data");
    expect(() => readFileSync(healthStateFile("claw1"))).toThrow();
    await runUsagePollTickNow();
    expect(warn.filter((m) => m.includes("HTTP 503"))).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("off by config, off outside a full registration, off without a pool", async () => {
    expect(startUsagePoll({ accounts: accounts(), pool: pool({ usagePoll: { enabled: false } }), registrationMode: "full", logger }).active).toBe(false);
    expect(await runUsagePollTickNow()).toBeUndefined();
    for (const mode of ["discovery", "setup", "cli"]) {
      expect(startUsagePoll({ accounts: accounts(), pool: pool(), registrationMode: mode, logger }).active).toBe(false);
    }
    expect(startUsagePoll({ accounts: accounts(), registrationMode: "full", logger }).active).toBe(false);
    // Legacy hosts without registrationMode still get the loop.
    expect(startUsagePoll({ accounts: accounts(), pool: pool(), registrationMode: undefined, logger }).active).toBe(true);
  });

  test("re-registering with the same config keeps the one loop; a changed interval replaces it and clears the old timers", () => {
    const setI = vi.spyOn(globalThis, "setInterval");
    const clearI = vi.spyOn(globalThis, "clearInterval");
    const clearT = vi.spyOn(globalThis, "clearTimeout");
    startUsagePoll({ accounts: accounts(), pool: pool(), registrationMode: "full", logger });
    startUsagePoll({ accounts: accounts(), pool: pool(), registrationMode: "full", logger });
    expect(setI).toHaveBeenCalledTimes(1);
    const firstInterval = setI.mock.results[0].value;
    startUsagePoll({ accounts: accounts(), pool: pool({ usagePoll: { intervalMs: 300_000 } }), registrationMode: "full", logger });
    expect(setI).toHaveBeenCalledTimes(2);
    expect(setI.mock.calls[1][1]).toBe(300_000);
    expect(clearI.mock.calls.some((c) => c[0] === firstInterval)).toBe(true);
    expect(clearT).toHaveBeenCalled(); // the first loop's initial tick, too
    setI.mockRestore();
    clearI.mockRestore();
    clearT.mockRestore();
  });

  test("the interval is floored at one minute", () => {
    const setI = vi.spyOn(globalThis, "setInterval");
    startUsagePoll({ accounts: accounts(), pool: pool({ usagePoll: { intervalMs: 5_000 } }), registrationMode: "full", logger });
    expect(setI.mock.calls[0][1]).toBe(60_000);
    setI.mockRestore();
  });
});
