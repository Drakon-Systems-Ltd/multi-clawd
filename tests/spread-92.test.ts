/**
 * Spread strategy (#92): opt-in placement of NEW sessions on the healthy
 * account with the fewest recent served launches. These are the decision
 * rules; tests/spread-92-wiring.test.ts drives the real launch path.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { choosePoolAccount, pickPoolAccountForLaunch, poolStrategy, type PoolVerdict } from "../src/health";
import { decideStickySelection } from "../src/sticky";
import { planDirectOrder } from "../src/direct-route";
import { createDirectOrderController, type OpenclawRunner } from "../src/direct-sync";
import { renderExplanation } from "../src/explain-core";
import type { HistoryEvent } from "../src/history";
import {
  DEFAULT_SPREAD_WINDOW_MS, MAX_SPREAD_WINDOW_MS, MIN_SPREAD_WINDOW_MS,
  spreadStatsFromHistory, spreadWindowMs, withSpreadStats,
} from "../src/spread";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const served = (accountId: string, agoMs: number): HistoryEvent =>
  ({ at: new Date(NOW - agoMs).toISOString(), kind: "served", accountId });
const member = (
  id: string, verdict: PoolVerdict["verdict"], servedInWindow?: number, lastServedAgoMs?: number,
): PoolVerdict => ({
  id, verdict,
  ...(servedInWindow !== undefined ? { servedInWindow } : {}),
  ...(lastServedAgoMs !== undefined ? { lastServedAt: NOW - lastServedAgoMs } : {}),
});

describe("spread statistics from the served-launch journal", () => {
  test("counts only served events inside the window; retries, rotations, old and future events are ignored", () => {
    const events: HistoryEvent[] = [
      served("home", 5 * MIN), served("home", 30 * MIN), served("spare", 2 * MIN),
      served("home", 61 * MIN), // outside a 1h window
      { at: new Date(NOW + 5 * MIN).toISOString(), kind: "served", accountId: "spare" }, // future clock
      { at: new Date(NOW - MIN).toISOString(), kind: "retry", accountId: "home", toAccountId: "spare" },
      { at: new Date(NOW - MIN).toISOString(), kind: "rotation", accountId: "home", toAccountId: "spare" },
    ];
    const stats = spreadStatsFromHistory(events, NOW, 60 * MIN);
    expect(stats.get("home")).toEqual({ servedInWindow: 2, lastServedAt: NOW - 5 * MIN });
    expect(stats.get("spare")).toEqual({ servedInWindow: 1, lastServedAt: NOW - 2 * MIN });
    expect(withSpreadStats([{ id: "home" }, { id: "spare" }, { id: "idle" }], stats)).toEqual([
      { id: "home", servedInWindow: 2, lastServedAt: NOW - 5 * MIN },
      { id: "spare", servedInWindow: 1, lastServedAt: NOW - 2 * MIN },
      { id: "idle", servedInWindow: 0 },
    ]);
  });

  test("the window is bounded: default one hour, clamped, anything unusable means the default", () => {
    expect(spreadWindowMs(undefined)).toBe(DEFAULT_SPREAD_WINDOW_MS);
    expect(spreadWindowMs("1h")).toBe(DEFAULT_SPREAD_WINDOW_MS);
    expect(spreadWindowMs(-5)).toBe(DEFAULT_SPREAD_WINDOW_MS);
    expect(spreadWindowMs(Number.NaN)).toBe(DEFAULT_SPREAD_WINDOW_MS);
    expect(spreadWindowMs(1)).toBe(MIN_SPREAD_WINDOW_MS);
    expect(spreadWindowMs(10 * 24 * 60 * MIN)).toBe(MAX_SPREAD_WINDOW_MS);
    expect(spreadWindowMs(15 * MIN)).toBe(15 * MIN);
  });
});

describe("spread selection", () => {
  test("ordered and omitted strategy keep home whatever the counts say (defaults unchanged)", () => {
    const pool = [member("home", "ok", 9, MIN), member("spare", "ok", 0)];
    expect(choosePoolAccount(pool)).toBe("home");
    expect(choosePoolAccount(pool, "ordered")).toBe("home");
    expect(choosePoolAccount(pool, "reset-aware")).toBe("home");
    expect(choosePoolAccount(pool, "spread")).toBe("spare");
    expect(pickPoolAccountForLaunch(pool, NOW, "spread")).toBe("spare");
  });

  test("fewest served launches wins; equal counts go to the least recently served; a full tie keeps pool order", () => {
    expect(choosePoolAccount([member("home", "ok", 3, MIN), member("spare", "ok", 2, 50 * MIN)], "spread")).toBe("spare");
    expect(choosePoolAccount([member("home", "ok", 2, MIN), member("spare", "ok", 2, 50 * MIN)], "spread")).toBe("spare");
    expect(choosePoolAccount([member("home", "ok", 2, 50 * MIN), member("spare", "ok", 2, MIN)], "spread")).toBe("home");
    expect(choosePoolAccount([member("home", "ok", 2, MIN), member("spare", "ok", 2)], "spread")).toBe("spare");
    expect(choosePoolAccount([member("home", "ok", 0), member("spare", "ok", 0)], "spread")).toBe("home");
    expect(choosePoolAccount([member("home", "ok"), member("spare", "ok")], "spread")).toBe("home");
  });

  test("no_data counts as healthy; near-limit, exhausted and credential-broken members are never spread onto", () => {
    expect(choosePoolAccount([member("home", "ok", 1, MIN), member("spare", "no_data", 0)], "spread")).toBe("spare");
    expect(choosePoolAccount([member("home", "ok", 9, MIN), member("spare", "near_limit", 0)], "spread")).toBe("home");
    expect(choosePoolAccount([member("home", "ok", 9, MIN), member("spare", "exhausted", 0)], "spread")).toBe("home");
    expect(choosePoolAccount([member("home", "ok", 9, MIN), member("spare", "credential_failed", 0)], "spread")).toBe("home");
    expect(choosePoolAccount([member("home", "ok", 9, MIN), member("spare", "credential_unverified", 0)], "spread")).toBe("home");
  });

  test("with no healthy member, spread answers exactly as ordered does", () => {
    const pools: PoolVerdict[][] = [
      [member("home", "near_limit", 5), member("spare", "near_limit", 0)],
      [member("home", "exhausted", 5), member("spare", "near_limit", 0)],
      [member("home", "exhausted", 0), member("spare", "exhausted", 0)],
      [member("home", "credential_failed"), member("spare", "exhausted")],
    ];
    for (const pool of pools) {
      expect(choosePoolAccount(pool, "spread")).toBe(choosePoolAccount(pool, "ordered"));
      expect(pickPoolAccountForLaunch(pool, NOW, "spread")).toBe(pickPoolAccountForLaunch(pool, NOW, "ordered"));
    }
  });

  test("spread keeps no sticky entry and has no dwell: each launch follows the counts", () => {
    const pool = [member("home", "ok", 3, MIN), member("spare", "ok", 1, 20 * MIN)];
    expect(decideStickySelection({ verdicts: pool, nowMs: NOW, strategy: "spread" })).toEqual({ account: "spare" });
    // A sticky entry left over from ordered mode neither holds the launch nor survives.
    expect(decideStickySelection({ verdicts: pool, sticky: { account: "home", since: NOW - 1000 }, nowMs: NOW, strategy: "spread" }))
      .toEqual({ account: "spare" });
    // Nothing usable: the existing last-resort rule, unchanged.
    const dead = [member("home", "exhausted"), member("spare", "exhausted")];
    expect(decideStickySelection({ verdicts: dead, nowMs: NOW, strategy: "spread" }))
      .toEqual(decideStickySelection({ verdicts: dead, nowMs: NOW }));
  });
});

describe("direct route under spread", () => {
  const members = (counts: Record<string, [PoolVerdict["verdict"], number]>) =>
    Object.entries(counts).map(([id, [verdict, n]]) => ({
      accountId: id, profileId: `anthropic:${id}`, verdict, servedInWindow: n, lastServedAt: NOW - MIN,
    }));

  test("the first profile is the least-served healthy account and the rest follow by count, unhealthy last", () => {
    const plan = planDirectOrder({ members: members({ home: ["ok", 4], spare: ["ok", 1], third: ["ok", 2], tired: ["near_limit", 0] }), nowMs: NOW, strategy: "spread" });
    expect(plan?.firstAccount).toBe("spare");
    expect(plan?.order).toEqual(["anthropic:spare", "anthropic:third", "anthropic:home", "anthropic:tired"]);
    expect(plan?.sticky).toBeUndefined();
    // Default strategy with the same counts: pool order, untouched.
    expect(planDirectOrder({ members: members({ home: ["ok", 4], spare: ["ok", 1] }), nowMs: NOW })?.order)
      .toEqual(["anthropic:home", "anthropic:spare"]);
  });

  test("the order controller reads the journal and writes the least-served profile first", async () => {
    let storedOrder: string[] | null = null;
    const calls: string[][] = [];
    const runner: OpenclawRunner = async (args) => {
      calls.push(args);
      if (args[2] === "list") return { code: 0, stdout: JSON.stringify({ profiles: ["anthropic:home", "anthropic:spare"].map((id) => ({ id, provider: "anthropic" })) }), stderr: "" };
      if (args[3] === "get") return { code: 0, stdout: JSON.stringify({ order: storedOrder }), stderr: "" };
      if (args[3] === "set") { storedOrder = args.slice(8); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    };
    const events = [served("home", MIN), served("home", 2 * MIN), served("spare", 3 * MIN)];
    const controller = createDirectOrderController({
      members: [
        { accountId: "home", profileId: "anthropic:home", source: { kind: "existing" } } as never,
        { accountId: "spare", profileId: "anthropic:spare", source: { kind: "existing" } } as never,
      ],
      agents: ["main"],
      runner,
      readHealth: () => undefined,
      healthOptions: {},
      strategy: "spread",
      readHistory: () => events,
      configOrder: () => undefined,
      readSticky: () => undefined,
      writeSticky: () => {},
      logger: { info: () => {}, warn: () => {} },
      now: () => NOW,
    });
    const report = await controller.tick();
    expect(report.managedOrder).toEqual(["anthropic:spare", "anthropic:home"]);
    expect(storedOrder).toEqual(["anthropic:spare", "anthropic:home"]);
  });
});

describe("explain under spread", () => {
  const base = {
    accounts: [{ id: "home" }, { id: "spare" }],
    health: [{ id: "home", verdict: "ok" }, { id: "spare", verdict: "ok" }],
    nowMs: NOW,
    history: [served("home", MIN), served("home", 2 * MIN), served("spare", 20 * MIN)],
  };

  test("names the strategy, the next placement, its reason and the counts behind it", () => {
    const out = renderExplanation({ ...base, pool: { id: "clawd", accounts: ["home", "spare"], strategy: "spread" } });
    expect(out).toMatch(/Strategy: spread\./);
    expect(out).toMatch(/fewest served launches in the last 1h/);
    expect(out).toMatch(/session affinity is on/);
    expect(out).toMatch(/strategy: spread — next new session on spare: fewest served launches in the last 1h \(1\)/);
    expect(out).toMatch(/home: 2 served in the last 1h, last ~1m ago/);
    expect(out).toMatch(/spare: 1 served in the last 1h, last ~20m ago/);
    expect(out).toMatch(/no home account under spread/);
    expect(out).not.toMatch(/rotated onto|returns home/);
  });

  test("a never-served account, a custom window and an ignored sessionAffinity: false are all said plainly", () => {
    const out = renderExplanation({
      ...base, history: [served("home", MIN)],
      pool: { id: "clawd", accounts: ["home", "spare"], strategy: "spread", spreadWindowMs: 15 * MIN, sessionAffinity: false },
    });
    expect(out).toMatch(/next new session on spare: not served in the last 15m/);
    expect(out).toMatch(/sessionAffinity: false is ignored under spread/);
  });

  test("the same history leaves the default strategy's explanation unchanged", () => {
    const out = renderExplanation({ ...base, pool: { id: "clawd", accounts: ["home", "spare"] } });
    expect(out).toMatch(/strategy: ordered — picked home: first healthy member in pool order/);
    expect(out).not.toMatch(/served in the last/);
  });
});

test("the schema admits spread and the runtime guard accepts it; unknown values still default to ordered", () => {
  const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const pool = schema.configSchema.properties.pool.properties;
  expect(pool.strategy.enum).toEqual(["ordered", "reset-aware", "spread"]);
  expect(pool.spreadWindowMs).toMatchObject({ type: "number", exclusiveMinimum: 0 });
  expect(poolStrategy("spread")).toBe("spread");
  expect(poolStrategy("least-loaded")).toBe("ordered");
});
