import { describe, expect, test } from "vitest";
import {
  createLineScanner,
  mergeHealthStates,
  parseRateLimitEvent,
  parseStoredState,
  updateHealthState,
  type AccountHealthState,
} from "../src/shim-core";

const SAMPLE_EVENT_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1784595600,
    rateLimitType: "seven_day",
    utilization: 0.3,
    isUsingOverage: false,
  },
  uuid: "u",
  session_id: "s",
});

describe("createLineScanner", () => {
  test("emits complete lines, including ones split across chunks", () => {
    const lines: string[] = [];
    const scanner = createLineScanner((l) => lines.push(l));
    scanner.push('{"a":1}\n{"b"');
    scanner.push(':2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("flush emits a trailing line without a newline", () => {
    const lines: string[] = [];
    const scanner = createLineScanner((l) => lines.push(l));
    scanner.push('{"a":1}');
    scanner.flush();
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe("parseRateLimitEvent", () => {
  test("parses a real rate_limit_event line", () => {
    const ev = parseRateLimitEvent(SAMPLE_EVENT_LINE);
    expect(ev).toEqual({
      status: "allowed_warning",
      resetsAt: 1784595600,
      rateLimitType: "seven_day",
      utilization: 0.3,
      isUsingOverage: false,
    });
  });

  test("returns undefined for non-events and junk without throwing", () => {
    expect(parseRateLimitEvent('{"type":"assistant"}')).toBeUndefined();
    expect(parseRateLimitEvent("not json at all")).toBeUndefined();
    expect(parseRateLimitEvent("")).toBeUndefined();
    expect(
      parseRateLimitEvent('{"type":"rate_limit_event"}'),
    ).toBeUndefined();
  });

  test("tolerates unknown statuses/windows and missing optional fields", () => {
    const ev = parseRateLimitEvent(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "some_future_status", rateLimitType: "lunar_month" },
      }),
    );
    expect(ev).toEqual({
      status: "some_future_status",
      rateLimitType: "lunar_month",
      resetsAt: undefined,
      utilization: undefined,
      isUsingOverage: undefined,
    });
  });
});

describe("updateHealthState", () => {
  test("records each rate-limit window separately", () => {
    let state: AccountHealthState = { accountId: "claw2", windows: {} };
    state = updateHealthState(
      state,
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 },
      1000,
    );
    state = updateHealthState(
      state,
      { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 },
      2000,
    );
    expect(state.windows.five_hour).toMatchObject({ status: "allowed", utilization: 0.5, seenAt: 1000 });
    expect(state.windows.seven_day).toMatchObject({ status: "allowed_warning", utilization: 0.9, seenAt: 2000 });
    expect(state.updatedAt).toBe(2000);
  });

  test("later events overwrite the same window", () => {
    let state: AccountHealthState = { accountId: "claw2", windows: {} };
    state = updateHealthState(state, { status: "allowed", rateLimitType: "five_hour" }, 1000);
    state = updateHealthState(state, { status: "rejected", rateLimitType: "five_hour", resetsAt: 99 }, 2000);
    expect(state.windows.five_hour).toMatchObject({ status: "rejected", resetsAt: 99, seenAt: 2000 });
  });

  test("events with no window type land in a default bucket", () => {
    const state = updateHealthState(
      { accountId: "claw2", windows: {} },
      { status: "allowed" },
      1000,
    );
    expect(state.windows.unknown).toMatchObject({ status: "allowed" });
  });
});

describe("parseStoredState", () => {
  test("round-trips a persisted state file", () => {
    const s: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 5000,
      windows: {
        seven_day: { status: "allowed_warning", utilization: 0.9, resetsAt: 99, seenAt: 4000 },
      },
    };
    expect(parseStoredState(JSON.stringify(s))).toEqual(s);
  });

  test("returns undefined for garbage or shapeless JSON", () => {
    expect(parseStoredState("{not json")).toBeUndefined();
    expect(parseStoredState("null")).toBeUndefined();
    expect(parseStoredState('{"accountId":"x"}')).toBeUndefined();
  });

  test("drops malformed windows but keeps good ones", () => {
    const parsed = parseStoredState(
      JSON.stringify({
        accountId: "claw1",
        windows: {
          five_hour: { status: "allowed", seenAt: 1000 },
          bad: { status: "allowed" }, // no seenAt
          worse: "nope",
        },
      }),
    );
    expect(parsed?.windows).toEqual({ five_hour: { status: "allowed", seenAt: 1000, resetsAt: undefined, utilization: undefined, isUsingOverage: undefined } });
  });
});

describe("mergeHealthStates", () => {
  const disk: AccountHealthState = {
    accountId: "claw1",
    updatedAt: 4000,
    windows: {
      seven_day: { status: "allowed_warning", utilization: 0.9, seenAt: 4000 },
      five_hour: { status: "allowed", utilization: 0.2, seenAt: 3000 },
    },
  };

  test("preserves disk windows absent from the live state (the Friday bug)", () => {
    const live: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 6000,
      windows: { five_hour: { status: "allowed", seenAt: 6000 } },
    };
    const merged = mergeHealthStates(disk, live);
    expect(merged.windows.seven_day).toMatchObject({ utilization: 0.9, seenAt: 4000 });
    expect(merged.windows.five_hour).toMatchObject({ seenAt: 6000 });
    expect(merged.updatedAt).toBe(6000);
  });

  test("newer seenAt wins per window, regardless of side", () => {
    const live: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 3500,
      windows: { seven_day: { status: "allowed", utilization: 0.5, seenAt: 3500 } },
    };
    const merged = mergeHealthStates(disk, live);
    // disk's seven_day (seenAt 4000) beats live's older observation (3500)
    expect(merged.windows.seven_day).toMatchObject({ utilization: 0.9, seenAt: 4000 });
    expect(merged.updatedAt).toBe(4000);
  });

  test("live accountId wins; empty updatedAt stays undefined", () => {
    const merged = mergeHealthStates(
      { accountId: "old", windows: {} },
      { accountId: "claw2", windows: {} },
    );
    expect(merged.accountId).toBe("claw2");
    expect(merged.updatedAt).toBeUndefined();
  });
});
