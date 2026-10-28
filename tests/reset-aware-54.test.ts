import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { choosePoolAccount, pickPoolAccountForLaunch, poolStrategy, sevenDayReset } from "../src/health";
import { decideStickySelection } from "../src/sticky";
import { planDirectOrder } from "../src/direct-route";
import { renderExplanation } from "../src/explain-core";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const reset = (hours: number) => NOW + hours * HOUR;
const member = (id: string, verdict: "ok" | "near_limit" | "no_data", hours?: number) =>
  ({ id, verdict, sevenDayResetsAt: hours === undefined ? undefined : reset(hours) });

describe("pool reset-aware strategy (#54)", () => {
  test("ordered and omitted strategy keep home; reset-aware drains the sooner weekly reset", () => {
    const pool = [member("home", "ok", 72), member("spare", "ok", 6)];
    expect(choosePoolAccount(pool)).toBe("home");
    expect(choosePoolAccount(pool, "ordered")).toBe("home");
    expect(choosePoolAccount(pool, "reset-aware")).toBe("spare");
    expect(pickPoolAccountForLaunch(pool, NOW, "reset-aware")).toBe("spare");
  });

  test("a near-limit member never outranks an ok member", () => {
    expect(choosePoolAccount([member("home", "ok", 72), member("spare", "near_limit", 1)], "reset-aware")).toBe("home");
  });

  test("missing reset data ranks last; equal resets keep pool order", () => {
    expect(choosePoolAccount([member("home", "ok"), member("spare", "ok", 6)], "reset-aware")).toBe("spare");
    expect(choosePoolAccount([member("home", "ok", 6), member("spare", "ok", 6)], "reset-aware")).toBe("home");
  });

  test("with no live weekly reset anywhere, reset-aware answers exactly as ordered", () => {
    const pools = [
      [member("home", "no_data"), member("spare", "ok")],
      [member("home", "near_limit"), member("spare", "no_data")],
      [member("home", "near_limit"), member("spare", "near_limit", 2)],
    ];
    for (const pool of pools) {
      expect(choosePoolAccount(pool, "reset-aware")).toBe(choosePoolAccount(pool, "ordered"));
    }
    expect(choosePoolAccount([member("home", "no_data"), member("spare", "ok", 6)], "reset-aware")).toBe("spare");
  });

  test("uses live seven_day data, preferring the usage poll record", () => {
    const state: AccountHealthState = {
      accountId: "home", updatedAt: NOW, windows: {
        seven_day: { status: "allowed", utilization: 0.2, resetsAt: reset(72) / 1000, seenAt: NOW },
        "usage:seven_day": { status: "allowed", utilization: 0.2, resetsAt: reset(6) / 1000, seenAt: NOW },
      },
    };
    expect(sevenDayReset(state, {}, NOW)).toBe(reset(6));
    expect(sevenDayReset(undefined, {}, NOW)).toBeUndefined();
  });

  test("dwell holds a usable account, then adopts the new preference", () => {
    const pool = [member("home", "ok", 72), member("spare", "ok", 6)];
    const sticky = { account: "home", since: NOW - 1000 };
    expect(decideStickySelection({ verdicts: pool, sticky, nowMs: NOW, strategy: "reset-aware" }).account).toBe("home");
    expect(decideStickySelection({ verdicts: pool, sticky, nowMs: NOW + 600_001, strategy: "reset-aware" })).toEqual({
      account: "spare", sticky: { account: "spare", since: NOW + 600_001 },
    });
    expect(decideStickySelection({ verdicts: [member("home", "ok", 72), member("spare", "near_limit", 6)], sticky: { account: "spare", since: NOW - 1000 }, nowMs: NOW, strategy: "reset-aware" }).account).toBe("home");
  });

  test("direct route uses the same reset preference and dwell", () => {
    const members = [member("home", "ok", 72), member("spare", "ok", 6)].map((m) => ({
      accountId: m.id, profileId: `anthropic:${m.id}`, verdict: m.verdict, sevenDayResetsAt: m.sevenDayResetsAt,
    }));
    expect(planDirectOrder({ members, nowMs: NOW })?.firstAccount).toBe("home");
    expect(planDirectOrder({ members, nowMs: NOW, strategy: "reset-aware" })?.order).toEqual(["anthropic:spare", "anthropic:home"]);
    expect(planDirectOrder({ members, nowMs: NOW, strategy: "reset-aware", sticky: { account: "home", since: NOW - 1000 } })?.firstAccount).toBe("home");
  });

  test("explain names the active strategy, selected account, reset and dwell reason", () => {
    const base = {
      accounts: [{ id: "home" }, { id: "spare" }],
      health: [
        { id: "home", verdict: "ok", usage: [{ window: "usage:seven_day", utilization: 0.2, resetsAt: reset(72) }] },
        { id: "spare", verdict: "ok", usage: [{ window: "usage:seven_day", utilization: 0.2, resetsAt: reset(6) }] },
      ],
      nowMs: NOW,
    };
    expect(renderExplanation({ ...base, pool: { id: "clawd", accounts: ["home", "spare"] } })).toMatch(/strategy: ordered — picked home: first healthy member in pool order/);
    const pool = { id: "clawd", accounts: ["home", "spare"], strategy: "reset-aware" as const };
    expect(renderExplanation({ ...base, pool })).toMatch(/strategy: reset-aware — picked spare: seven-day window resets soonest \(in ~6h\)/);
    expect(renderExplanation({ ...base, pool, stickyEntry: { account: "home", since: NOW - 1000 } })).toMatch(/picked home: sticky dwell keeps this usable account/);
  });

  test("invalid strategy values are rejected by schema and runtime guard defaults to ordered", () => {
    const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const values: string[] = schema.configSchema.properties.pool.properties.strategy.enum;
    expect(values).toEqual(["ordered", "reset-aware", "spread"]);
    expect(values).not.toContain("random");
    expect(poolStrategy("random")).toBe("ordered");
  });
});
