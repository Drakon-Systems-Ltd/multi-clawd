import { describe, expect, test } from "vitest";
import {
  classifyAccountHealth,
  choosePoolAccount,
  pickPoolAccountForLaunch,
} from "../src/health";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_784_100_000_000; // ms
const NOW_S = NOW / 1000;

function state(windows: AccountHealthState["windows"], updatedAt = NOW - 1000): AccountHealthState {
  return { accountId: "x", updatedAt, windows };
}

describe("classifyAccountHealth", () => {
  test("no state at all means no_data (still usable)", () => {
    expect(classifyAccountHealth(undefined, {}, NOW).verdict).toBe("no_data");
  });

  test("stale state means no_data", () => {
    const s = state(
      { five_hour: { status: "rejected", seenAt: NOW - 3_600_000 * 7, resetsAt: NOW_S + 60 } },
      NOW - 3_600_000 * 7,
    );
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("no_data");
  });

  test("rejected window with a future reset means exhausted, with resumeAt", () => {
    const s = state({
      five_hour: { status: "rejected", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 },
    });
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).toBe("exhausted");
    expect(h.resumeAt).toBe((NOW_S + 1800) * 1000);
  });

  test("rejected window whose reset already passed is not binding", () => {
    const s = state({
      five_hour: { status: "rejected", resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("utilization at or above the threshold means near_limit", () => {
    const s = state({
      five_hour: { status: "allowed", utilization: 0.9, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });

  test("threshold is configurable", () => {
    const s = state({
      five_hour: { status: "allowed", utilization: 0.6, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, { utilizationThreshold: 0.5 }, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(s, { utilizationThreshold: 0.85 }, NOW).verdict).toBe("ok");
  });

  test("allowed_warning without high utilization stays ok (weekly windows warn early)", () => {
    const s = state({
      seven_day: { status: "allowed_warning", utilization: 0.3, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("worst window wins across windows", () => {
    const s = state({
      seven_day: { status: "allowed", utilization: 0.1, seenAt: NOW - 1000 },
      five_hour: { status: "rejected", resetsAt: NOW_S + 600, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });
});

describe("choosePoolAccount", () => {
  test("keeps the first account while it is healthy", () => {
    const chosen = choosePoolAccount([
      { id: "claw1", verdict: "ok" },
      { id: "claw2", verdict: "ok" },
    ]);
    expect(chosen).toBe("claw1");
  });

  test("rotates past a near-limit first account", () => {
    const chosen = choosePoolAccount([
      { id: "claw1", verdict: "near_limit" },
      { id: "claw2", verdict: "ok" },
    ]);
    expect(chosen).toBe("claw2");
  });

  test("treats no_data like healthy (never rotate on missing data)", () => {
    const chosen = choosePoolAccount([
      { id: "claw1", verdict: "no_data" },
      { id: "claw2", verdict: "ok" },
    ]);
    expect(chosen).toBe("claw1");
  });

  test("prefers a near-limit account over an exhausted one", () => {
    const chosen = choosePoolAccount([
      { id: "claw1", verdict: "exhausted" },
      { id: "claw2", verdict: "near_limit" },
    ]);
    expect(chosen).toBe("claw2");
  });

  test("returns undefined when the whole pool is exhausted (let the chain drop provider)", () => {
    const chosen = choosePoolAccount([
      { id: "claw1", verdict: "exhausted" },
      { id: "claw2", verdict: "exhausted" },
    ]);
    expect(chosen).toBeUndefined();
  });
});

describe("pickPoolAccountForLaunch", () => {
  test("healthy home account serves the launch", () => {
    expect(
      pickPoolAccountForLaunch([
        { id: "claw1", verdict: "ok" },
        { id: "claw2", verdict: "ok" },
      ]),
    ).toBe("claw1");
  });

  test("near-limit home hands the launch to the next account", () => {
    expect(
      pickPoolAccountForLaunch([
        { id: "claw1", verdict: "near_limit" },
        { id: "claw2", verdict: "no_data" },
      ]),
    ).toBe("claw2");
  });

  test("fully exhausted pool still launches on the home account so the failure is real", () => {
    expect(
      pickPoolAccountForLaunch([
        { id: "claw1", verdict: "exhausted" },
        { id: "claw2", verdict: "exhausted" },
      ]),
    ).toBe("claw1");
  });
});
