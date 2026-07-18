import { describe, expect, test } from "vitest";
import {
  PRUNE_AFTER_MS,
  classifyStateReadFailure,
  createLineScanner,
  mergeHealthStates,
  parseRateLimitEvent,
  parseStoredState,
  updateHealthState,
  type AccountHealthState,
} from "../src/shim-core";

describe("classifyStateReadFailure", () => {
  test("ENOENT is a benign absent file (silent fresh start)", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(classifyStateReadFailure(err)).toBe("absent");
  });

  test("a permission / IO error is exists-but-unreadable", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(classifyStateReadFailure(err)).toBe("unreadable");
  });

  test("a non-errno throw is treated as unreadable, never absent", () => {
    expect(classifyStateReadFailure(new Error("boom"))).toBe("unreadable");
    expect(classifyStateReadFailure("weird")).toBe("unreadable");
  });
});

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

  test("captures rawInfo when rateLimitType is missing (the unknown-window autopsy trail)", () => {
    const ev = parseRateLimitEvent(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", perModelLimit: "opus", overageState: "weird" },
      }),
    );
    expect(ev?.rateLimitType).toBeUndefined();
    expect(ev?.rawInfo).toBe(
      JSON.stringify({ status: "rejected", perModelLimit: "opus", overageState: "weird" }),
    );
  });

  test("captures rawInfo when rateLimitType is present but not a string", () => {
    const ev = parseRateLimitEvent(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: 7 },
      }),
    );
    expect(ev?.rateLimitType).toBeUndefined();
    expect(ev?.rawInfo).toBe(JSON.stringify({ status: "rejected", rateLimitType: 7 }));
  });

  test("does NOT capture rawInfo when rateLimitType is a usable string", () => {
    const ev = parseRateLimitEvent(SAMPLE_EVENT_LINE);
    expect(ev?.rawInfo).toBeUndefined();
  });

  test("truncates rawInfo to 512 chars", () => {
    const ev = parseRateLimitEvent(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", blob: "x".repeat(2000) },
      }),
    );
    expect(ev?.rawInfo?.length).toBe(512);
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

  test("carries rawInfo onto the window entry when present", () => {
    const state = updateHealthState(
      { accountId: "claw2", windows: {} },
      { status: "rejected", rawInfo: '{"status":"rejected"}' },
      1000,
    );
    expect(state.windows.unknown).toMatchObject({ status: "rejected", rawInfo: '{"status":"rejected"}' });
  });

  test("leaves rawInfo absent on the window entry when the event has none", () => {
    const state = updateHealthState(
      { accountId: "claw2", windows: {} },
      { status: "allowed", rateLimitType: "five_hour" },
      1000,
    );
    expect(state.windows.five_hour.rawInfo).toBeUndefined();
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

  test("round-trips rawInfo when it is a string", () => {
    const s: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 5000,
      windows: {
        unknown: { status: "rejected", seenAt: 4000, rawInfo: '{"status":"rejected"}' },
      },
    };
    const parsed = parseStoredState(JSON.stringify(s));
    expect(parsed?.windows.unknown.rawInfo).toBe('{"status":"rejected"}');
  });

  test("drops a non-string rawInfo without failing the window", () => {
    const parsed = parseStoredState(
      JSON.stringify({
        accountId: "claw1",
        windows: {
          unknown: { status: "rejected", seenAt: 4000, rawInfo: { not: "a string" } },
        },
      }),
    );
    expect(parsed?.windows.unknown).toMatchObject({ status: "rejected", seenAt: 4000 });
    expect(parsed?.windows.unknown.rawInfo).toBeUndefined();
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

  test("preserves disk windows absent from the live state (disk-window-loss regression)", () => {
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

  test("migrates legacy prefixed model window key to canonical (upgrade regression guard)", () => {
    // Stock v0.3.6 persisted this key uncanonicalised. Post-fix reads only
    // match `model:claude-fable-5`, so without migration this window silently
    // stops gating on upgrade — the exact class the fix closes.
    const legacyDisk: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 5000,
      windows: {
        "model:clawd/claude-fable-5": { status: "rejected", resetsAt: 9_999_999, seenAt: 5000 },
      },
    };
    const merged = mergeHealthStates(legacyDisk, { accountId: "claw1", windows: {} });
    expect(merged.windows["model:claude-fable-5"]).toMatchObject({ status: "rejected", seenAt: 5000 });
    expect(merged.windows["model:clawd/claude-fable-5"]).toBeUndefined();
  });

  test("legacy + canonical model keys collide to the newer seenAt", () => {
    const collideDisk: AccountHealthState = {
      accountId: "claw1",
      updatedAt: 5000,
      windows: {
        "model:clawd/claude-fable-5": { status: "rejected", seenAt: 5000 },
        "model:claude-fable-5": { status: "rejected", seenAt: 7000 },
      },
    };
    const merged = mergeHealthStates(collideDisk, { accountId: "claw1", windows: {} });
    expect(merged.windows["model:claude-fable-5"]).toMatchObject({ seenAt: 7000 });
    expect(Object.keys(merged.windows).filter((k) => k.startsWith("model:"))).toHaveLength(1);
  });

  test("live accountId wins; empty updatedAt stays undefined", () => {
    const merged = mergeHealthStates(
      { accountId: "old", windows: {} },
      { accountId: "claw2", windows: {} },
    );
    expect(merged.accountId).toBe("claw2");
    expect(merged.updatedAt).toBeUndefined();
  });

  test("no pruning happens without a now reference (existing 2-arg callers unchanged)", () => {
    const day = 24 * 60 * 60 * 1000;
    const ancient: AccountHealthState = {
      accountId: "claw1",
      windows: { five_hour: { status: "allowed", seenAt: 1000 } },
    };
    const merged = mergeHealthStates(ancient, { accountId: "claw1", windows: {} });
    expect(merged.windows.five_hour).toBeDefined();
    // sanity: PRUNE_AFTER_MS is the documented 14-day default
    expect(PRUNE_AFTER_MS).toBe(14 * day);
  });

  test("prunes windows older than the horizon, keeps ones inside it (post-merge)", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const stale: AccountHealthState = {
      accountId: "claw1",
      updatedAt: now - 15 * day,
      windows: {
        old_junk: { status: "rejected", seenAt: now - 15 * day },
        recent: { status: "allowed", seenAt: now - 13 * day },
      },
    };
    const merged = mergeHealthStates(stale, { accountId: "claw1", windows: {} }, now);
    expect(merged.windows.old_junk).toBeUndefined();
    expect(merged.windows.recent).toBeDefined();
  });

  test("prunes against the newest observation, so a fresh live obs rescues a stale disk window", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const disk: AccountHealthState = {
      accountId: "claw1",
      windows: { five_hour: { status: "allowed", seenAt: now - 20 * day } },
    };
    const live: AccountHealthState = {
      accountId: "claw1",
      windows: { five_hour: { status: "allowed", seenAt: now - 1 * day } },
    };
    const merged = mergeHealthStates(disk, live, now);
    expect(merged.windows.five_hour).toMatchObject({ seenAt: now - 1 * day });
  });

  test("existing merge behaviour is unchanged for windows inside the horizon", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const freshDisk: AccountHealthState = {
      accountId: "claw1",
      updatedAt: now - day,
      windows: {
        seven_day: { status: "allowed_warning", utilization: 0.9, seenAt: now - day },
        five_hour: { status: "allowed", utilization: 0.2, seenAt: now - 2 * day },
      },
    };
    const live: AccountHealthState = {
      accountId: "claw1",
      updatedAt: now,
      windows: { five_hour: { status: "allowed", seenAt: now } },
    };
    const merged = mergeHealthStates(freshDisk, live, now);
    expect(merged.windows.seven_day).toMatchObject({ utilization: 0.9, seenAt: now - day });
    expect(merged.windows.five_hour).toMatchObject({ seenAt: now });
    expect(merged.updatedAt).toBe(now);
  });
});
