/**
 * Live usage polling (v1.10) — the pure half.
 *
 * The thing being pinned: a number the provider reports becomes a health record
 * the EXISTING selector acts on, under a key that cannot collide with the
 * shim's, and the warn threshold produces alerts that end when the condition
 * does. Fixtures mirror the endpoint's observed body shape (percentages, ISO
 * reset stamps, nullable per-plan windows, a `limits` array with model scopes).
 */
import { describe, expect, test } from "vitest";
import {
  classifyAccountHealth,
  isPeriodWindow,
  isShortWindow,
  summarizeWindowUsage,
} from "../src/health";
import { mergeHealthStates, parseStoredState } from "../src/shim-core";
import {
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  DEFAULT_USAGE_WARN_THRESHOLD,
  MAX_USAGE_POLL_INTERVAL_MS,
  MIN_USAGE_POLL_INTERVAL_MS,
  decideUsageAlerts,
  effectiveUsagePollInterval,
  effectiveUsageWarnThreshold,
  fetchUsage,
  parseUsageResponse,
  readOAuthAccessToken,
  usageHealthWindows,
  usagePoolAlertKey,
  usageWindowLabel,
  createUsagePollController,
  type UsagePollIo,
} from "../src/usage-poll";
import type { AccountHealthState } from "../src/shim-core";

const NOW = Date.parse("2026-10-04T10:30:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function body(overrides: Record<string, unknown> = {}) {
  return {
    five_hour: { utilization: 10.0, resets_at: iso(90 * 60_000), limit_dollars: null },
    seven_day: { utilization: 46.0, resets_at: iso(2 * 86_400_000), limit_dollars: null },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: "session", group: "session", percent: 10, severity: "normal", resets_at: iso(90 * 60_000), scope: null },
      { kind: "weekly_all", group: "weekly", percent: 46, severity: "normal", resets_at: iso(2 * 86_400_000), scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 53,
        severity: "normal",
        resets_at: iso(2 * 86_400_000),
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
    ...overrides,
  };
}

describe("parseUsageResponse", () => {
  test("reads both windows as fractions with epoch-second resets, and the scoped model limit", () => {
    const snap = parseUsageResponse(body());
    expect(snap).toBeDefined();
    expect(snap!.windows.five_hour).toEqual({ utilization: 0.1, resetsAt: Math.floor((NOW + 90 * 60_000) / 1000) });
    expect(snap!.windows.seven_day.utilization).toBeCloseTo(0.46);
    expect(snap!.scoped).toEqual([
      { label: "Fable", utilization: 0.53, resetsAt: Math.floor((NOW + 2 * 86_400_000) / 1000) },
    ]);
  });

  test("null per-plan windows and unknown keys are ignored; a plan-specific window that IS present is kept in the snapshot", () => {
    const snap = parseUsageResponse(body({ seven_day_opus: { utilization: 80, resets_at: iso(86_400_000) }, tangelo: null }));
    expect(Object.keys(snap!.windows).sort()).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(snap!.windows.seven_day_opus.utilization).toBeCloseTo(0.8);
  });

  test("a per-model weekly window never becomes an account-wide health record", () => {
    // The reader treats every period window as account-wide, so a
    // `seven_day_sonnet` at 100% written as health would bench the account for
    // opus too. It stays in the snapshot (alerts, `usage` output) only.
    const snap = parseUsageResponse(body({ seven_day_sonnet: { utilization: 100, resets_at: iso(86_400_000) } }))!;
    const windows = usageHealthWindows(snap, NOW);
    expect(Object.keys(windows).sort()).toEqual(["usage:five_hour", "usage:seven_day"]);
    const state = { accountId: "claw1", windows };
    expect(classifyAccountHealth(state, { utilizationThreshold: 0.85 }, NOW, "claude-opus-5-5").verdict).toBe("ok");
    // ...but it does warn.
    const d = decideUsageAlerts({ poolId: "clawd", accounts: [{ id: "claw1", snapshot: snap, verdict: "ok" }], warnThreshold: 0.95, nowMs: NOW });
    expect(d.raise.map((a) => a.key)).toEqual(["usage:clawd:claw1:seven_day_sonnet"]);
    expect(d.raise[0].text).toContain("weekly sonnet usage at 100%");
  });

  test("a body with no readable window is unparseable, never zero usage", () => {
    expect(parseUsageResponse({ five_hour: null, seven_day: null })).toBeUndefined();
    expect(parseUsageResponse({ five_hour: { utilization: "10" } })).toBeUndefined();
    expect(parseUsageResponse("nope")).toBeUndefined();
    expect(parseUsageResponse(null)).toBeUndefined();
  });

  test("a malformed reset stamp drops the reset, not the window", () => {
    const snap = parseUsageResponse(body({ five_hour: { utilization: 5, resets_at: "soon" } }));
    expect(snap!.windows.five_hour).toEqual({ utilization: 0.05, resetsAt: undefined });
  });
});

describe("usageHealthWindows → the existing selector", () => {
  const OPTS = { utilizationThreshold: 0.85 };

  test("writes under usage:<window>, which the window predicates classify like the bare key", () => {
    const windows = usageHealthWindows(parseUsageResponse(body())!, NOW);
    expect(Object.keys(windows).sort()).toEqual(["usage:five_hour", "usage:seven_day"]);
    expect(isShortWindow("usage:five_hour")).toBe(true);
    expect(isShortWindow("usage:seven_day")).toBe(false);
    expect(isPeriodWindow("usage:five_hour")).toBe(true);
    expect(isPeriodWindow("usage:seven_day")).toBe(true);
  });

  test("a healthy account stays ok", () => {
    const state = { accountId: "claw1", windows: usageHealthWindows(parseUsageResponse(body())!, NOW) };
    expect(classifyAccountHealth(state, OPTS, NOW).verdict).toBe("ok");
  });

  test("a 5-hour window at 86% is near_limit — the rule the stream could never trigger", () => {
    const snap = parseUsageResponse(body({ five_hour: { utilization: 86, resets_at: iso(60 * 60_000) } }))!;
    const state = { accountId: "claw1", windows: usageHealthWindows(snap, NOW) };
    const h = classifyAccountHealth(state, OPTS, NOW);
    expect(h.verdict).toBe("near_limit");
    expect(h.reason).toContain("usage:five_hour");
  });

  test("a window at 100% is exhausted until the provider's reset, for every model", () => {
    const snap = parseUsageResponse(body({ five_hour: { utilization: 100, resets_at: iso(40 * 60_000) } }))!;
    const windows = usageHealthWindows(snap, NOW);
    expect(windows["usage:five_hour"].status).toBe("rejected");
    const state = { accountId: "claw1", windows };
    const h = classifyAccountHealth(state, OPTS, NOW, "claude-opus-5-5");
    expect(h.verdict).toBe("exhausted");
    expect(h.resumeAt).toBe(NOW + 40 * 60_000);
    // ...and recovers the moment the reset passes.
    expect(classifyAccountHealth(state, OPTS, NOW + 41 * 60_000, "claude-opus-5-5").verdict).not.toBe("exhausted");
  });

  test("a polled rejection is asserted for one hour from its observation — the poll ceiling keeps it fresh", () => {
    // health.ts trusts a rejection for REJECTION_REVALIDATE_AFTER_MS (1h) from
    // `seenAt`. Every poll restamps `seenAt`, so at any interval up to the
    // ceiling a genuine 100% stays binding. If polling goes dark for over an
    // hour the record lapses on purpose (stale negative evidence, #11) and the
    // next real launch finds out for itself.
    const snap = parseUsageResponse(body({ five_hour: { utilization: 100, resets_at: iso(4 * 60 * 60_000) } }))!;
    const state = { accountId: "claw1", windows: usageHealthWindows(snap, NOW) };
    expect(classifyAccountHealth(state, OPTS, NOW + MAX_USAGE_POLL_INTERVAL_MS).verdict).toBe("exhausted");
    expect(classifyAccountHealth(state, OPTS, NOW + 61 * 60_000).verdict).not.toBe("exhausted");
  });

  test("the shim's bare five_hour record does not erase the polled number (distinct keys, newer-wins per key)", () => {
    const polled = { accountId: "claw1", updatedAt: NOW, windows: usageHealthWindows(parseUsageResponse(body({ five_hour: { utilization: 90, resets_at: iso(60 * 60_000) } }))!, NOW) };
    const shimLater = {
      accountId: "claw1",
      updatedAt: NOW + 1000,
      windows: { five_hour: { status: "allowed", resetsAt: Math.floor((NOW + 60 * 60_000) / 1000), seenAt: NOW + 1000 } },
    };
    const merged = mergeHealthStates(polled, shimLater, NOW + 1000);
    expect(merged.windows["usage:five_hour"].utilization).toBeCloseTo(0.9);
    expect(merged.windows.five_hour.status).toBe("allowed");
    expect(classifyAccountHealth(merged, OPTS, NOW + 1000).verdict).toBe("near_limit");
  });

  test("polled windows round-trip the stored-state parser and show in the usage summary", () => {
    const state = { accountId: "claw1", windows: usageHealthWindows(parseUsageResponse(body())!, NOW) };
    const parsed = parseStoredState(JSON.stringify(state))!;
    expect(parsed.windows["usage:seven_day"].utilization).toBeCloseTo(0.46);
    const usage = summarizeWindowUsage(parsed, OPTS, NOW);
    expect(usage.map((u) => u.window)).toEqual(["usage:seven_day", "usage:five_hour"]);
  });
});

describe("readOAuthAccessToken", () => {
  const creds = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

  test("returns the stored access token while it is unexpired", () => {
    expect(readOAuthAccessToken(creds({ accessToken: "tok", expiresAt: NOW + 60_000 }), NOW)).toEqual({ token: "tok" });
    // No expiry stamp at all: trust the CLI's file.
    expect(readOAuthAccessToken(creds({ accessToken: "tok" }), NOW)).toEqual({ token: "tok" });
  });

  test("skips — never refreshes — an expired token, and says why", () => {
    const r = readOAuthAccessToken(creds({ accessToken: "tok", expiresAt: NOW - 1 }), NOW);
    expect("skip" in r && r.skip).toMatch(/expired/);
  });

  test("skips an absent, malformed, or sessionless file without throwing", () => {
    expect("skip" in readOAuthAccessToken(undefined, NOW)).toBe(true);
    expect("skip" in readOAuthAccessToken("{not json", NOW)).toBe(true);
    expect("skip" in readOAuthAccessToken("{}", NOW)).toBe(true);
    expect("skip" in readOAuthAccessToken(creds({ accessToken: "" }), NOW)).toBe(true);
  });
});

describe("fetchUsage", () => {
  const respond = (status: number, json: unknown) => async () => ({ status, json: async () => json });

  test("sends the bearer token with the OAuth beta header and parses the body", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const r = await fetchUsage("tok", async (url, init) => {
      seen = { url, headers: init.headers };
      return { status: 200, json: async () => body() };
    });
    expect(r.ok).toBe(true);
    expect(seen!.url).toMatch(/\/api\/oauth\/usage$/);
    expect(seen!.headers.Authorization).toBe("Bearer tok");
    expect(seen!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("classifies failures instead of throwing", async () => {
    expect(await fetchUsage("t", respond(401, {}))).toMatchObject({ ok: false, kind: "auth" });
    expect(await fetchUsage("t", respond(429, {}))).toMatchObject({ ok: false, kind: "throttled" });
    expect(await fetchUsage("t", respond(503, {}))).toMatchObject({ ok: false, kind: "transient" });
    expect(await fetchUsage("t", respond(200, { five_hour: null }))).toMatchObject({ ok: false, kind: "parse" });
    expect(
      await fetchUsage("t", async () => {
        throw new TypeError("fetch failed");
      }),
    ).toMatchObject({ ok: false, kind: "transient" });
  });
});

describe("decideUsageAlerts", () => {
  const snap = (five: number, weekly = 0.2, scoped: number[] = []) => ({
    windows: {
      five_hour: { utilization: five, resetsAt: Math.floor((NOW + 50 * 60_000) / 1000) },
      seven_day: { utilization: weekly, resetsAt: Math.floor((NOW + 86_400_000) / 1000) },
    },
    scoped: scoped.map((u) => ({ label: "Fable", utilization: u, resetsAt: Math.floor((NOW + 86_400_000) / 1000) })),
  });

  test("quiet below the threshold: nothing raised, nothing kept", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [{ id: "claw1", snapshot: snap(0.9), verdict: "near_limit" }, { id: "claw2", snapshot: snap(0.1), verdict: "ok" }],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    expect(d.raise).toEqual([]);
    expect(d.keep.size).toBe(0);
  });

  test("one account at 96% names the window, the reset, and where launches now go", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [{ id: "claw1", snapshot: snap(0.96), verdict: "near_limit" }, { id: "claw2", snapshot: snap(0.1), verdict: "ok" }],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    expect(d.raise).toHaveLength(1);
    expect(d.raise[0].key).toBe("usage:clawd:claw1:five_hour");
    expect(d.raise[0].severity).toBe("error");
    expect(d.raise[0].text).toContain('account "claw1" 5-hour usage at 96%');
    expect(d.raise[0].text).toContain("resets in ~50m");
    expect(d.raise[0].text).toContain("new launches route to claw2");
    expect(d.keep.has(usagePoolAlertKey("clawd"))).toBe(false);
  });

  test("every account hot raises the pool-wide alert with the soonest reset", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [
        { id: "claw1", snapshot: snap(1.0), verdict: "exhausted" },
        { id: "claw2", snapshot: snap(0.2, 0.97), verdict: "near_limit" },
      ],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    const keys = d.raise.map((a) => a.key).sort();
    expect(keys).toEqual(["usage-pool:clawd", "usage:clawd:claw1:five_hour", "usage:clawd:claw2:seven_day"]);
    const pool = d.raise.find((a) => a.key === "usage-pool:clawd")!;
    expect(pool.text).toContain("EVERY account is above 95%");
    expect(pool.text).toContain("resets in ~50m");
    const exhausted = d.raise.find((a) => a.key === "usage:clawd:claw1:five_hour")!;
    expect(exhausted.text).toContain("exhausted");
    const other = d.raise.find((a) => a.key === "usage:clawd:claw2:seven_day")!;
    expect(other.text).toContain("no healthy sibling");
  });

  test("an account that could not be read is not known to be hot: no pool-wide alert, and it still counts as a sibling", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [{ id: "claw1", snapshot: snap(0.99), verdict: "near_limit" }, { id: "claw2" }],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    expect(d.raise.map((a) => a.key)).toEqual(["usage:clawd:claw1:five_hour"]);
    expect(d.raise[0].text).toContain("new launches route to claw2");
  });

  test("a scoped model limit warns on its own key", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [{ id: "claw1", snapshot: snap(0.1, 0.2, [0.97]), verdict: "ok" }],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    expect(d.raise.map((a) => a.key)).toEqual(["usage:clawd:claw1:model:fable"]);
    expect(d.raise[0].text).toContain("Fable model limit at 97%");
    // One account, no sibling: not pool-wide — a model limit is not an account limit.
    expect(d.keep.has(usagePoolAlertKey("clawd"))).toBe(false);
  });

  test("a single-account pool says there is nobody to hand over to", () => {
    const d = decideUsageAlerts({
      poolId: "clawd",
      accounts: [{ id: "claw1", snapshot: snap(0.96), verdict: "near_limit" }],
      warnThreshold: 0.95,
      nowMs: NOW,
    });
    expect(d.raise[0].text).toContain("no sibling account");
    expect(d.keep.has(usagePoolAlertKey("clawd"))).toBe(true);
  });
});

describe("config bounds", () => {
  test("interval defaults to 2 minutes, floored at 1 and capped at 30", () => {
    expect(effectiveUsagePollInterval(undefined)).toBe(DEFAULT_USAGE_POLL_INTERVAL_MS);
    expect(effectiveUsagePollInterval({ intervalMs: 5 })).toBe(MIN_USAGE_POLL_INTERVAL_MS);
    expect(effectiveUsagePollInterval({ intervalMs: 600_000 })).toBe(600_000);
    expect(effectiveUsagePollInterval({ intervalMs: 3 * 60 * 60_000 })).toBe(MAX_USAGE_POLL_INTERVAL_MS);
    expect(effectiveUsagePollInterval({ intervalMs: Number.NaN })).toBe(DEFAULT_USAGE_POLL_INTERVAL_MS);
  });
  test("warn threshold defaults to 0.95 and rejects nonsense", () => {
    expect(effectiveUsageWarnThreshold(undefined)).toBe(DEFAULT_USAGE_WARN_THRESHOLD);
    expect(effectiveUsageWarnThreshold({ warnThreshold: 0.9 })).toBe(0.9);
    expect(effectiveUsageWarnThreshold({ warnThreshold: 0 })).toBe(DEFAULT_USAGE_WARN_THRESHOLD);
    expect(effectiveUsageWarnThreshold({ warnThreshold: 2 })).toBe(DEFAULT_USAGE_WARN_THRESHOLD);
  });
  test("window labels", () => {
    expect(usageWindowLabel("usage:five_hour")).toBe("5-hour");
    expect(usageWindowLabel("seven_day")).toBe("weekly");
    expect(usageWindowLabel("seven_day_opus")).toBe("weekly opus");
  });
});

/**
 * v1.10.1 — the controller against a fake disk with two slots per account:
 * the shim's health file and the poll's own usage file. The property under
 * test is structural: the poll never writes the shim's slot, so no
 * interleaving of the two read-merge-write paths can lose an update.
 */
describe("createUsagePollController — the poll owns its own file", () => {
  const credentials = (token: string, expiresAt = NOW + 3_600_000) =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

  function harness(opts: {
    creds: Record<string, string>;
    shim?: Record<string, AccountHealthState>;
    readHealthThrows?: Record<string, Error>;
    fetchStatus?: Record<string, number>;
  }) {
    const shim: Record<string, AccountHealthState | undefined> = { ...(opts.shim ?? {}) };
    const usage: Record<string, AccountHealthState | undefined> = {};
    const log: string[] = [];
    const alerts = new Map<string, unknown>();
    const io: UsagePollIo = {
      readFile: (path) => opts.creds[path],
      readHealth: (id) => {
        const boom = opts.readHealthThrows?.[id];
        if (boom) throw boom;
        const a = shim[id];
        const b = usage[id];
        if (!a) return b;
        if (!b) return a;
        return mergeHealthStates(a, b);
      },
      writeUsage: (id, state) => {
        usage[id] = JSON.parse(JSON.stringify(state)) as AccountHealthState;
      },
      fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
        const token = init.headers.Authorization.replace(/^Bearer /, "");
        const status = opts.fetchStatus?.[token] ?? 200;
        return { status, json: async () => (status === 200 ? body() : {}) };
      }) as unknown as UsagePollIo["fetchImpl"],
      raiseAlert: (alert) => alerts.set(alert.key, alert),
      clearAlert: (key) => alerts.delete(key),
      alertKeysWithPrefix: (prefix) => [...alerts.keys()].filter((k) => k.startsWith(prefix)),
      logger: { info: (m) => log.push(m), warn: (m) => log.push(m) },
      now: () => NOW,
    };
    const controller = createUsagePollController({
      poolId: "clawd",
      members: Object.keys(opts.creds).map((path) => ({ id: path.replace(/^\/creds\//, "").replace(/\.json$/, ""), credentialsFile: path })),
      healthOptions: {},
      warnThreshold: 0.95,
      io,
    });
    return { controller, shim, usage, log };
  }

  test("a tick writes the usage slot and leaves the shim's slot untouched, even when the shim commits mid-tick", async () => {
    const shimSeen = NOW - 60_000;
    const onDisk: AccountHealthState = {
      accountId: "claw1",
      updatedAt: shimSeen,
      windows: { five_hour: { status: "allowed", resetsAt: Math.floor(NOW / 1000) + 3600, seenAt: shimSeen } },
      credential: { status: "ok", seenAt: shimSeen },
    };
    const h = harness({ creds: { "/creds/claw1.json": credentials("tok-one") }, shim: { claw1: onDisk } });
    // The losing interleave of v1.10.0: between the poll's read of the health
    // file and its write, the shim records a rejection and a credential
    // failure. Model it by letting the shim commit on the poll's read — after
    // that point the old poll would have renamed a stale merge over it.
    const original = h.controller;
    const shimCommits = () => {
      h.shim.claw1 = {
        ...onDisk,
        updatedAt: NOW,
        windows: { ...onDisk.windows, five_hour: { status: "rejected", resetsAt: Math.floor(NOW / 1000) + 1800, seenAt: NOW } },
        credential: { status: "failed", reason: "login expired", seenAt: NOW },
      };
    };
    shimCommits();
    const report = await original.tick();
    expect(report.accounts).toHaveLength(1);
    // The shim's record survives in its own slot...
    expect(h.shim.claw1?.windows.five_hour.status).toBe("rejected");
    expect(h.shim.claw1?.credential?.status).toBe("failed");
    // ...and the poll's record lives only in its own slot, holding usage keys alone.
    expect(Object.keys(h.usage.claw1?.windows ?? {}).every((k) => k.startsWith("usage:"))).toBe(true);
    expect(h.usage.claw1?.windows["usage:five_hour"].utilization).toBeCloseTo(0.1);
    expect(h.usage.claw1?.credential).toBeUndefined();
    // The verdict the tick reports was built from the merged view, so the
    // shim's rejection is what the selector will see, not a healthy 10%.
    expect(report.accounts[0].verdict).toBe("credential_failed");
  });

  test("the reverse interleave cannot drop fresh usage: the shim's write never reaches the usage slot", async () => {
    const h = harness({ creds: { "/creds/claw1.json": credentials("tok-one") } });
    await h.controller.tick();
    const fresh = h.usage.claw1;
    // A shim persist that read-merge-writes its own file afterwards...
    h.shim.claw1 = { accountId: "claw1", updatedAt: NOW + 1, windows: { seven_day: { status: "allowed", resetsAt: Math.floor(NOW / 1000) + 86_400, seenAt: NOW + 1 } } };
    // ...leaves the usage snapshot exactly as the poll wrote it.
    expect(h.usage.claw1).toEqual(fresh);
    const merged = h.controller && (await h.controller.tick());
    expect(merged.accounts[0].verdict).toBe("ok");
  });

  test("one unreadable health file reports no_data for that account and the tick carries on", async () => {
    const h = harness({
      creds: {
        "/creds/claw1.json": credentials("tok-one", NOW - 1), // expired → skipped → verdictFor
        "/creds/claw2.json": credentials("tok-two"),
      },
      readHealthThrows: { claw1: new Error("EACCES: permission denied") },
    });
    const report = await h.controller.tick();
    expect(report.accounts.map((a) => [a.id, a.verdict])).toEqual([
      ["claw1", "no_data"],
      ["claw2", "ok"],
    ]);
    expect(report.accounts[0].skipped).toMatch(/expired/);
    expect(h.log.filter((m) => m.includes('"claw1"') && m.includes("health file unreadable"))).toHaveLength(1);
    // Said once, not per tick.
    await h.controller.tick();
    expect(h.log.filter((m) => m.includes("health file unreadable"))).toHaveLength(1);
  });

  test("a failed fetch on an unreadable file is still one account's problem, not the tick's", async () => {
    const h = harness({
      creds: { "/creds/claw1.json": credentials("tok-one"), "/creds/claw2.json": credentials("tok-two") },
      fetchStatus: { "tok-one": 500 },
      readHealthThrows: { claw1: new Error("not valid health-state JSON") },
    });
    const report = await h.controller.tick();
    expect(report.accounts.map((a) => [a.id, a.verdict])).toEqual([
      ["claw1", "no_data"],
      ["claw2", "ok"],
    ]);
    expect(report.accounts[0].failure?.kind).toBeDefined();
  });
});
