/**
 * #93: when nothing usable is left, the near-limit member with the most
 * headroom serves, not the first near-limit member in pool order. These are
 * the decision rules, the utilization figure they rest on, the direct-route
 * order, and `explain`; the wiring suite drives the real launch path.
 */
import { describe, expect, test } from "vitest";
import {
  choosePoolAccount, classifyAccountHealth, headroomBefore, logicalWindowKey, nearLimitWithMostHeadroom,
  pickPoolAccountForLaunch, REJECTION_REVALIDATE_AFTER_MS, type PoolStrategy, type PoolVerdict,
} from "../src/health";
import { decideStickySelection } from "../src/sticky";
import { planDirectOrder } from "../src/direct-route";
import { createDirectOrderController, type OpenclawRunner } from "../src/direct-sync";
import { gatherDirectStatus } from "../src/direct-report";
import { describeNearLimitPick, renderExplanation } from "../src/explain-core";
import { eligibleSessionAccount } from "../src/session-affinity";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const HOUR = 3_600_000;
const STRATEGIES: PoolStrategy[] = ["ordered", "reset-aware", "spread"];

const member = (id: string, verdict: PoolVerdict["verdict"], utilization?: number, extra: Partial<PoolVerdict> = {}): PoolVerdict =>
  ({ id, verdict, ...(utilization !== undefined ? { utilization } : {}), ...extra });

function state(windows: AccountHealthState["windows"]): AccountHealthState {
  return { accountId: "x", updatedAt: NOW - 1000, windows };
}

describe("selection among near-limit members (#93)", () => {
  test("every strategy picks the near-limit member with the most headroom, not the first in pool order", () => {
    const pool = [member("home", "near_limit", 0.99), member("spare", "near_limit", 0.86), member("third", "near_limit", 0.9)];
    for (const strategy of STRATEGIES) {
      expect(choosePoolAccount(pool, strategy)).toBe("spare");
      expect(pickPoolAccountForLaunch(pool, NOW, strategy)).toBe("spare");
    }
    expect(choosePoolAccount(pool)).toBe("spare");
    expect(nearLimitWithMostHeadroom(pool)?.id).toBe("spare");
  });

  test("equal utilization keeps pool order; a member with a number outranks one without; two unknowns keep pool order", () => {
    expect(choosePoolAccount([member("home", "near_limit", 0.9), member("spare", "near_limit", 0.9)])).toBe("home");
    expect(choosePoolAccount([member("home", "near_limit"), member("spare", "near_limit", 0.95)])).toBe("spare");
    expect(choosePoolAccount([member("home", "near_limit", 0.95), member("spare", "near_limit")])).toBe("home");
    expect(choosePoolAccount([member("home", "near_limit"), member("spare", "near_limit")])).toBe("home");
    expect(headroomBefore({ utilization: 0.86 }, { utilization: 0.9 })).toBe(true);
    expect(headroomBefore({ utilization: 0.9 }, { utilization: 0.86 })).toBe(false);
    expect(headroomBefore({ utilization: 0.9 }, { utilization: 0.9 })).toBe(false);
    expect(headroomBefore({ utilization: 0.99 }, {})).toBe(true);
    expect(headroomBefore({}, { utilization: 0.99 })).toBe(false);
    expect(headroomBefore({}, {})).toBe(false);
  });

  test("a usable member still beats every near-limit member whatever the figures say (ok/no_data order unchanged)", () => {
    for (const strategy of STRATEGIES) {
      expect(choosePoolAccount([member("home", "near_limit", 0.86), member("spare", "ok", 0.84)], strategy)).toBe("spare");
      expect(choosePoolAccount([member("home", "near_limit", 0.86), member("spare", "no_data")], strategy)).toBe("spare");
      expect(choosePoolAccount([member("home", "ok", 0.84), member("spare", "ok", 0.1)], strategy)).toBe("home");
      expect(choosePoolAccount([member("home", "no_data"), member("spare", "ok", 0.1)], strategy)).toBe("home");
    }
  });

  test("exhausted and credential-broken members are never chosen, and a wholly exhausted pool still fails for real", () => {
    for (const strategy of STRATEGIES) {
      expect(choosePoolAccount([member("home", "exhausted"), member("spare", "near_limit", 0.99)], strategy)).toBe("spare");
      expect(choosePoolAccount([member("home", "credential_failed"), member("spare", "near_limit", 0.99)], strategy)).toBe("spare");
      expect(choosePoolAccount([member("home", "credential_unverified"), member("spare", "near_limit", 0.99)], strategy)).toBe("spare");
      const dead = [member("home", "exhausted", undefined, { observedAt: NOW - 60_000 }), member("spare", "exhausted", undefined, { observedAt: NOW - 60_000 })];
      expect(choosePoolAccount(dead, strategy)).toBeUndefined();
      expect(pickPoolAccountForLaunch(dead, NOW, strategy)).toBe("home");
      // An overdue rejection is still the re-probe target (#26), unchanged.
      const overdue = [member("home", "exhausted", undefined, { observedAt: NOW - 60_000 }), member("spare", "exhausted", undefined, { observedAt: NOW - REJECTION_REVALIDATE_AFTER_MS - 1 })];
      expect(pickPoolAccountForLaunch(overdue, NOW, strategy)).toBe("spare");
    }
    expect(nearLimitWithMostHeadroom([member("home", "exhausted"), member("spare", "credential_failed")])).toBeUndefined();
  });

  test("health beats stickiness: a sticky near-limit account with less headroom does not hold the launch", () => {
    const pool = [member("home", "near_limit", 0.86), member("spare", "near_limit", 0.95)];
    const away = decideStickySelection({ verdicts: pool, sticky: { account: "spare", since: NOW - 1000 }, nowMs: NOW, minDwellMs: 600_000 });
    expect(away.account).toBe("home");
    // Running away from home on a headroom pick records the sticky entry exactly as a rotation always has.
    const rotated = decideStickySelection({ verdicts: [member("home", "near_limit", 0.95), member("spare", "near_limit", 0.86)], nowMs: NOW });
    expect(rotated).toEqual({ account: "spare", sticky: { account: "spare", since: NOW } });
    for (const strategy of STRATEGIES) {
      expect(decideStickySelection({ verdicts: pool, nowMs: NOW, strategy }).account).toBe("home");
    }
  });

  test("session affinity is unchanged: a pin on a near-limit account is dropped however much headroom it has", () => {
    const verdicts = [member("home", "near_limit", 0.86), member("spare", "near_limit", 0.95)];
    expect(eligibleSessionAccount({ account: "home", servedAt: NOW }, "spare", verdicts, ["home", "spare"])).toBeUndefined();
    expect(eligibleSessionAccount({ account: "spare", servedAt: NOW }, "spare", [member("home", "near_limit", 0.86), member("spare", "ok", 0.5)], ["home", "spare"])).toBe("spare");
  });
});

describe("the utilization figure on a verdict (#93)", () => {
  test("the highest fresh number across windows rides on ok and near-limit verdicts", () => {
    const near = classifyAccountHealth(state({
      five_hour: { status: "allowed", utilization: 0.5, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
      seven_day: { status: "allowed_warning", utilization: 0.9, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(near.verdict).toBe("near_limit");
    expect(near.utilization).toBe(0.9);
    const ok = classifyAccountHealth(state({
      five_hour: { status: "allowed", utilization: 0.5, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
      seven_day: { status: "allowed", utilization: 0.3, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(ok.verdict).toBe("ok");
    expect(ok.utilization).toBe(0.5);
  });

  test("for one window seen by both the stream and the usage poll, the fresher record is the figure", () => {
    expect(logicalWindowKey("usage:seven_day")).toBe("seven_day");
    expect(logicalWindowKey("seven_day")).toBe("seven_day");
    const stalerStream = classifyAccountHealth(state({
      seven_day: { status: "allowed_warning", utilization: 0.99, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 2 * HOUR },
      "usage:seven_day": { status: "allowed", utilization: 0.86, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 60_000 },
    }), {}, NOW);
    // The threshold still fires on any live window; the headroom figure is the fresh one.
    expect(stalerStream.verdict).toBe("near_limit");
    expect(stalerStream.utilization).toBe(0.86);
    const fresherStream = classifyAccountHealth(state({
      seven_day: { status: "allowed_warning", utilization: 0.99, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 60_000 },
      "usage:seven_day": { status: "allowed", utilization: 0.86, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 2 * HOUR },
    }), {}, NOW);
    expect(fresherStream.utilization).toBe(0.99);
  });

  test("a passed reset, a stale reset-less record and a model-scoped window never supply the figure", () => {
    const passed = classifyAccountHealth(state({
      seven_day: { status: "allowed_warning", utilization: 0.99, resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
      five_hour: { status: "allowed", utilization: 0.3, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(passed.verdict).toBe("ok");
    expect(passed.utilization).toBe(0.3);
    const stale = classifyAccountHealth(state({
      five_hour: { status: "allowed_warning", utilization: 0.95, seenAt: NOW - 7 * HOUR },
      seven_day: { status: "allowed", utilization: 0.4, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(stale.verdict).toBe("ok");
    expect(stale.utilization).toBe(0.4);
    const modelScoped = classifyAccountHealth(state({
      "model:claude-fable-5": { status: "rejected", utilization: 0.99, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
      five_hour: { status: "allowed", utilization: 0.2, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
    }), {}, NOW, "claude-opus-5");
    expect(modelScoped.verdict).toBe("ok");
    expect(modelScoped.utilization).toBe(0.2);
  });

  test("spill-over counts only when rotateOnOverage is set, mirroring what may drive near-limit", () => {
    const windows = {
      seven_day_overage_included: { status: "allowed", utilization: 0.95, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
      seven_day: { status: "allowed", utilization: 0.5, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
    };
    const kept = classifyAccountHealth(state(windows), {}, NOW);
    expect(kept.verdict).toBe("ok");
    expect(kept.utilization).toBe(0.5);
    const rotating = classifyAccountHealth(state(windows), { rotateOnOverage: true }, NOW);
    expect(rotating.verdict).toBe("near_limit");
    expect(rotating.utilization).toBe(0.95);
  });

  test("no number means no figure: a bare short-window warning, missing state and an exhausted account carry none", () => {
    const bare = classifyAccountHealth(state({
      five_hour: { status: "allowed_warning", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(bare.verdict).toBe("near_limit");
    expect(bare.utilization).toBeUndefined();
    expect(classifyAccountHealth(undefined, {}, NOW)).toEqual({ verdict: "no_data" });
    const exhausted = classifyAccountHealth(state({
      five_hour: { status: "rejected", utilization: 1, resetsAt: NOW_S + 1800, seenAt: NOW - 1000 },
    }), {}, NOW);
    expect(exhausted.verdict).toBe("exhausted");
    expect(exhausted.utilization).toBeUndefined();
  });
});

describe("direct route order (#93)", () => {
  const m = (accountId: string, verdict: PoolVerdict["verdict"], utilization?: number) => ({
    accountId, profileId: `anthropic:${accountId}`, verdict, ...(utilization !== undefined ? { utilization } : {}),
  });

  test("with every member near its limit the leader has the most headroom and the rest follow by headroom", () => {
    for (const strategy of STRATEGIES) {
      const plan = planDirectOrder({ members: [m("home", "near_limit", 0.99), m("spare", "near_limit", 0.86), m("third", "near_limit", 0.9)], nowMs: NOW, strategy });
      expect(plan?.firstAccount).toBe("spare");
      expect(plan?.order).toEqual(["anthropic:spare", "anthropic:third", "anthropic:home"]);
    }
  });

  test("rank behind the leader: usable, near-limit by headroom, exhausted, rejected login; no number after numbers", () => {
    const plan = planDirectOrder({
      members: [m("a", "credential_failed"), m("b", "exhausted"), m("c", "near_limit", 0.95), m("d", "near_limit"), m("e", "near_limit", 0.87), m("f", "ok")],
      nowMs: NOW,
    });
    expect(plan?.order).toEqual(["anthropic:f", "anthropic:e", "anthropic:c", "anthropic:d", "anthropic:b", "anthropic:a"]);
  });

  test("a healthy pool is untouched by the figures", () => {
    const plan = planDirectOrder({ members: [m("home", "ok", 0.84), m("spare", "ok", 0.1)], nowMs: NOW });
    expect(plan?.order).toEqual(["anthropic:home", "anthropic:spare"]);
    expect(plan?.sticky).toBeUndefined();
  });

  function fakeRunner(profiles: string[]): { runner: OpenclawRunner; stored: () => string[] | null } {
    let storedOrder: string[] | null = null;
    const runner: OpenclawRunner = async (args) => {
      if (args[2] === "list") return { code: 0, stdout: JSON.stringify({ profiles: profiles.map((id) => ({ id, provider: "anthropic" })) }), stderr: "" };
      if (args[3] === "get") return { code: 0, stdout: JSON.stringify({ order: storedOrder }), stderr: "" };
      if (args[3] === "set") { storedOrder = args.slice(8); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    };
    return { runner, stored: () => storedOrder };
  }
  const health: Record<string, AccountHealthState> = {
    home: { accountId: "home", updatedAt: NOW - 1000, windows: { seven_day: { status: "allowed_warning", utilization: 0.99, resetsAt: NOW_S + 86400, seenAt: NOW - 1000 } } },
    spare: { accountId: "spare", updatedAt: NOW - 1000, windows: { seven_day: { status: "allowed_warning", utilization: 0.86, resetsAt: NOW_S + 86400, seenAt: NOW - 1000 } } },
  };
  const members = [
    { accountId: "home", profileId: "anthropic:home", source: { kind: "existing" } } as never,
    { accountId: "spare", profileId: "anthropic:spare", source: { kind: "existing" } } as never,
  ];

  test("the order controller reads the health files and writes the most-headroom profile first", async () => {
    const { runner, stored } = fakeRunner(["anthropic:home", "anthropic:spare"]);
    const controller = createDirectOrderController({
      members, agents: ["main"], runner,
      readHealth: (id) => health[id], healthOptions: {},
      configOrder: () => undefined, readSticky: () => undefined, writeSticky: () => {},
      logger: { info: () => {}, warn: () => {} }, now: () => NOW,
    });
    const report = await controller.tick();
    expect(report.managedOrder).toEqual(["anthropic:spare", "anthropic:home"]);
    expect(stored()).toEqual(["anthropic:spare", "anthropic:home"]);
  });

  test("the direct status report carries the figures and the same pending order", async () => {
    const { runner } = fakeRunner(["anthropic:home", "anthropic:spare"]);
    const status = await gatherDirectStatus({
      accounts: [{ id: "home", direct: { profileId: "anthropic:home" } }, { id: "spare", direct: { profileId: "anthropic:spare" } }],
      poolAccounts: ["home", "spare"], agentId: "main", runner,
      readHealth: (id) => health[id], healthOptions: {}, nowMs: NOW, skipCooldowns: true,
    });
    expect(status?.verdicts.map((v) => [v.accountId, v.verdict, v.utilization])).toEqual([["home", "near_limit", 0.99], ["spare", "near_limit", 0.86]]);
    expect(status?.pendingOrder).toEqual(["anthropic:spare", "anthropic:home"]);
  });
});

describe("explain (#93)", () => {
  const base = { accounts: [{ id: "home" }, { id: "spare" }], nowMs: NOW };
  const pool = { id: "clawd", accounts: ["home", "spare"] };

  test("says every account is near its limit, which one was picked, at what figure, and what the others read", () => {
    const out = renderExplanation({
      ...base, pool,
      health: [{ id: "home", verdict: "near_limit", utilization: 0.99 }, { id: "spare", verdict: "near_limit", utilization: 0.86 }],
    });
    expect(out).toMatch(/strategy: ordered — picked spare: all near limit, picked spare at 86% — most headroom \(home 99%\)/);
    for (const strategy of ["reset-aware", "spread"] as const) {
      expect(renderExplanation({
        ...base, pool: { ...pool, strategy },
        health: [{ id: "home", verdict: "near_limit", utilization: 0.99 }, { id: "spare", verdict: "near_limit", utilization: 0.86 }],
      })).toMatch(/(picked|next new session on) spare: all near limit, picked spare at 86% — most headroom \(home 99%\)/);
    }
  });

  test("an exhausted sibling, a pick without a number and a single near-limit member are each said plainly", () => {
    expect(describeNearLimitPick([member("home", "exhausted"), member("spare", "near_limit", 0.9)], member("spare", "near_limit", 0.9)))
      .toBe("no healthy member, the rest near limit, picked spare at 90%");
    expect(describeNearLimitPick([member("home", "near_limit"), member("spare", "near_limit")], member("home", "near_limit")))
      .toBe("all near limit, picked home (no utilization number; pool order)");
    expect(describeNearLimitPick([member("home", "near_limit", 0.9), member("spare", "near_limit")], member("home", "near_limit", 0.9)))
      .toBe("all near limit, picked home at 90% — most headroom (spare no number)");
    expect(renderExplanation({ ...base, pool, health: [{ id: "home", verdict: "near_limit" }, { id: "spare", verdict: "near_limit" }] }))
      .toMatch(/picked home: all near limit, picked home \(no utilization number; pool order\)/);
  });

  test("a healthy pool reads exactly as before", () => {
    const out = renderExplanation({ ...base, pool, health: [{ id: "home", verdict: "ok", utilization: 0.5 }, { id: "spare", verdict: "ok", utilization: 0.1 }] });
    expect(out).toMatch(/strategy: ordered — picked home: first healthy member in pool order/);
    expect(out).not.toMatch(/near limit, picked/);
  });
});
