import { describe, expect, test } from "vitest";
import {
  createLineScanner,
  parseRateLimitEvent,
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
