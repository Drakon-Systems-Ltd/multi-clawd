/**
 * #14 — `seven_day_overage_included` measures consumption against allowance
 * PLUS purchased spill-over. High utilization there means "little paid overage
 * left", not "little quota left" — a different fact with a different answer.
 *
 * Live capture (two-window state, one account): overage 0.96 while real weekly
 * sat at 0.75 — 21 points apart across the 0.85 threshold, with the overage
 * number driving routing. Which window upstream intends as authoritative is
 * unestablished, so the owner decides: by default the pool does not rotate on
 * spill-over alone, and says so.
 */
import { describe, expect, test } from "vitest";
import { classifyAccountHealth, isOverageWindow } from "../src/health";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_784_500_000_000;

function stateWith(windows: AccountHealthState["windows"]): AccountHealthState {
  return { accountId: "claw1", updatedAt: NOW, windows };
}

const OVERAGE_HOT = {
  seven_day_overage_included: { status: "allowed", utilization: 0.96, seenAt: NOW - 60_000 },
  seven_day: { status: "allowed", utilization: 0.75, seenAt: NOW - 60_000 },
};

describe("isOverageWindow", () => {
  test("names the spill-over window and nothing else", () => {
    expect(isOverageWindow("seven_day_overage_included")).toBe(true);
    expect(isOverageWindow("seven_day")).toBe(false);
    expect(isOverageWindow("five_hour")).toBe(false);
  });
});

describe("by default, paid spill-over does not drive rotation", () => {
  test("overage at 96% with real quota at 75% is NOT near_limit", () => {
    expect(classifyAccountHealth(stateWith(OVERAGE_HOT), {}, NOW).verdict).toBe("ok");
  });

  test("the real quota window still drives rotation exactly as before", () => {
    const s = stateWith({
      seven_day: { status: "allowed", utilization: 0.9, seenAt: NOW - 60_000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });

  test("a REJECTION on the overage window still exhausts — refusing a turn is a fact", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: NOW / 1000 + 3600,
        seenAt: NOW - 60_000,
      },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });
});

describe("instead of deciding, it asks the owner", () => {
  test("carries an advisory naming both numbers and how to opt in", () => {
    const h = classifyAccountHealth(stateWith(OVERAGE_HOT), {}, NOW);
    expect(h.overageAdvisory).toBeDefined();
    expect(h.overageAdvisory).toContain("96%");
    expect(h.overageAdvisory).toContain("75%");
    expect(h.overageAdvisory).toMatch(/rotateOnOverage/);
  });

  test("no advisory when the real quota window is over threshold too — it rotates anyway", () => {
    const s = stateWith({
      seven_day_overage_included: { status: "allowed", utilization: 0.96, seenAt: NOW - 60_000 },
      seven_day: { status: "allowed", utilization: 0.9, seenAt: NOW - 60_000 },
    });
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).toBe("near_limit");
    expect(h.overageAdvisory).toBeUndefined();
  });

  test("no advisory when the overage window is comfortable", () => {
    const s = stateWith({
      seven_day_overage_included: { status: "allowed", utilization: 0.2, seenAt: NOW - 60_000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).overageAdvisory).toBeUndefined();
  });
});

describe("the owner can opt in, and then it rotates as it used to", () => {
  test("rotateOnOverage makes spill-over drive rotation again", () => {
    const h = classifyAccountHealth(stateWith(OVERAGE_HOT), { rotateOnOverage: true }, NOW);
    expect(h.verdict).toBe("near_limit");
  });

  test("having opted in, there is nothing left to ask", () => {
    const h = classifyAccountHealth(stateWith(OVERAGE_HOT), { rotateOnOverage: true }, NOW);
    expect(h.overageAdvisory).toBeUndefined();
  });
});
