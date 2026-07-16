import { describe, expect, test } from "vitest";
import { decideWatchdogAction, type WatchdogState } from "../src/watchdog-core";

const NOW = 1_784_400_000_000;
const TS_NEW = "2026-07-16T14:00:00.000+01:00";
const TS_OLD = "2026-07-16T10:00:00.000+01:00";

function decide(input: {
  evictionTimestamp?: string;
  state?: WatchdogState;
  inFlight?: boolean;
  nowMs?: number;
}) {
  return decideWatchdogAction({
    evictionTimestamp: input.evictionTimestamp,
    state: input.state ?? {},
    inFlight: input.inFlight ?? false,
    nowMs: input.nowMs ?? NOW,
    maxDeferMs: 15 * 60 * 1000,
    restartCooldownMs: 10 * 60 * 1000,
  });
}

describe("decideWatchdogAction", () => {
  test("no eviction, no pending: nothing to do", () => {
    const d = decide({});
    expect(d.action).toBe("none");
  });

  test("eviction already handled: nothing to do", () => {
    const d = decide({ evictionTimestamp: TS_OLD, state: { lastHandled: TS_OLD } });
    expect(d.action).toBe("none");
  });

  test("new eviction, idle, out of cooldown: restart and mark handled", () => {
    const d = decide({ evictionTimestamp: TS_NEW, state: { lastHandled: TS_OLD } });
    expect(d.action).toBe("restart");
    expect(d.nextState.lastHandled).toBe(TS_NEW);
    expect(d.nextState.lastRestartAt).toBe(NOW);
    expect(d.nextState.pendingEviction).toBeUndefined();
  });

  test("new eviction but a turn is in flight: defer and start the clock", () => {
    const d = decide({ evictionTimestamp: TS_NEW, inFlight: true });
    expect(d.action).toBe("defer");
    expect(d.reason).toContain("in-flight");
    expect(d.nextState.pendingEviction).toEqual({
      logTimestamp: TS_NEW,
      firstDeferredAt: NOW,
      defers: 1,
    });
  });

  test("still in flight on a later tick: keep deferring, preserve the first-defer time", () => {
    const pending = { logTimestamp: TS_NEW, firstDeferredAt: NOW - 5 * 60 * 1000, defers: 1 };
    const d = decide({ state: { pendingEviction: pending }, inFlight: true });
    expect(d.action).toBe("defer");
    expect(d.nextState.pendingEviction).toEqual({ ...pending, defers: 2 });
  });

  test("defer cap exceeded: restart anyway even mid-turn, and say so", () => {
    const pending = { logTimestamp: TS_NEW, firstDeferredAt: NOW - 16 * 60 * 1000, defers: 3 };
    const d = decide({ state: { pendingEviction: pending }, inFlight: true });
    expect(d.action).toBe("restart");
    expect(d.reason).toContain("defer cap");
    expect(d.nextState.pendingEviction).toBeUndefined();
    expect(d.nextState.lastHandled).toBe(TS_NEW);
  });

  test("idle but inside the restart cooldown: defer with a cooldown reason", () => {
    const d = decide({
      evictionTimestamp: TS_NEW,
      state: { lastHandled: TS_OLD, lastRestartAt: NOW - 5 * 60 * 1000 },
    });
    expect(d.action).toBe("defer");
    expect(d.reason).toContain("cooldown");
  });

  test("pending eviction survives log rotation: restarts once idle even with no fresh signature", () => {
    const pending = { logTimestamp: TS_NEW, firstDeferredAt: NOW - 60 * 1000, defers: 1 };
    const d = decide({ evictionTimestamp: undefined, state: { pendingEviction: pending } });
    expect(d.action).toBe("restart");
    expect(d.nextState.lastHandled).toBe(TS_NEW);
  });
});
