import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyAccountHealth,
  choosePoolAccount,
  pickPoolAccountForLaunch,
} from "../src/health";
import { modelWindowKey, type AccountHealthState } from "../src/shim-core";

const NOW = 1_784_100_000_000; // ms
const NOW_S = NOW / 1000;

function state(windows: AccountHealthState["windows"], updatedAt = NOW - 1000): AccountHealthState {
  return { accountId: "x", updatedAt, windows };
}

describe("classifyAccountHealth", () => {
  test("no state at all means no_data (still usable)", () => {
    expect(classifyAccountHealth(undefined, {}, NOW).verdict).toBe("no_data");
  });

  test("stale reset-less state means no_data", () => {
    // A window carrying NO reset stamp ages out by staleAfterMs. With nothing
    // else live, the account has no evidence to act on → no_data.
    const s = state(
      { five_hour: { status: "allowed", utilization: 0.2, seenAt: NOW - 3_600_000 * 7 } },
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

describe("per-window aging (post window-merge persistence)", () => {
  test("a stale individual window is ignored while fresh ones count", () => {
    // seven_day observed 7h ago (stale) with high utilization; five_hour fresh
    // and low. Must NOT be near_limit — stale windows are not evidence.
    const s = state({
      seven_day: { status: "allowed_warning", utilization: 0.9, seenAt: NOW - 3_600_000 * 7 },
      five_hour: { status: "allowed", utilization: 0.1, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("a stale RESET-LESS rejected window cannot mark the account exhausted", () => {
    // No reset stamp → aged out by staleAfterMs like any other reset-less
    // window. (A reset-BEARING weekly window instead survives — see the
    // reset-aware suite below.)
    const s = state({
      seven_day: { status: "rejected", seenAt: NOW - 3_600_000 * 7 },
      five_hour: { status: "allowed", seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  // Friday-Mac live case: claw1 held a real `unknown:rejected` window (a
  // Fable-limit 429 that arrived with no recognisable rateLimitType, so no
  // resetsAt). It must age out via the reset-less TTL path, never blackhole.
  test("reset-less `unknown:rejected` window ages out gracefully (Friday-Mac claw1)", () => {
    // Fresh but reset-less: with no reset stamp we cannot know when it lifts,
    // so it must NOT mark the account exhausted (would strand the account).
    const fresh = state({ unknown: { status: "rejected", seenAt: NOW - 1000 } });
    expect(classifyAccountHealth(fresh, {}, NOW).verdict).not.toBe("exhausted");

    // Stale and the only evidence → no positive evidence left → no_data.
    const stale = state({ unknown: { status: "rejected", seenAt: NOW - 3_600_000 * 7 } });
    expect(classifyAccountHealth(stale, {}, NOW).verdict).toBe("no_data");
  });

  test("high utilization whose reset has passed no longer binds", () => {
    // The 0.9 belonged to the previous weekly cycle: reset passed 60s ago.
    const s = state({
      seven_day: { status: "allowed_warning", utilization: 0.9, resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("fresh high utilization with a future reset still rotates", () => {
    const s = state({
      seven_day: { status: "allowed_warning", utilization: 0.9, resetsAt: NOW_S + 86400, seenAt: NOW - 1000 },
      five_hour: { status: "allowed", seenAt: NOW - 500 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });
});

describe("reset-aware staleness (fix A)", () => {
  afterEach(() => vi.restoreAllMocks());

  const DAY = 24 * 60 * 60 * 1000;

  test("a seven_day window at 0.98 with a future reset, seen 10h ago, still rotates", () => {
    // 10h > the 6h blanket TTL, but the window carries a live weekly reset —
    // it must NOT be discarded before its reset actually passes.
    const s = state(
      { seven_day: { status: "allowed_warning", utilization: 0.98, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 3_600_000 * 10 } },
      NOW - 3_600_000 * 10,
    );
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });

  test("a reset-bearing window seen >8 days ago is dropped AND fires the cap alarm", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // resetsAt still 'future' but the observation is 9 days old — the 8-day
    // horizon cap drops it and logs the clock-skew / parse-bug alarm.
    const s = state(
      { seven_day: { status: "rejected", utilization: 0.99, resetsAt: NOW_S + 3600, seenAt: NOW - 9 * DAY } },
      NOW - 9 * DAY,
    );
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).not.toBe("exhausted");
    expect(h.verdict).toBe("no_data");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/exceeded 8d reset-horizon cap/);
    expect(warn.mock.calls[0][0]).toContain("seven_day");
  });

  test("a five_hour window with NO reset, seen >6h ago, ages out (unchanged)", () => {
    const s = state(
      { five_hour: { status: "allowed", utilization: 0.99, seenAt: NOW - 3_600_000 * 7 } },
      NOW - 3_600_000 * 7,
    );
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("no_data");
  });

  test("a model-rejected window with a days-away reset survives an idle >6h account", () => {
    // Account last observed 8h ago; the model cap resets in 2 days. Rotation
    // for that model must still fire — this is the incident class fix A targets.
    const s = state(
      { [modelWindowKey("claude-fable-5")]: { status: "rejected", resetsAt: NOW_S + 2 * 86400, seenAt: NOW - 3_600_000 * 8 } },
      NOW - 3_600_000 * 8,
    );
    expect(classifyAccountHealth(s, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    // ...but only for that model — a different model still sees the account as
    // usable (the live model window is evidence, just not binding for opus).
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-4-8").verdict).toBe("ok");
  });

  test("aggressive pool staleAfterMs does NOT truncate a model window's own TTL", () => {
    // Regression for the freshness-gate ordering bug: a reset-less model window
    // must age by MODEL_REJECTED_TTL_MS (60m), independent of the account-level
    // staleAfterMs. A pool tuned to rotate five_hour aggressively (staleAfterMs
    // 30m) must NOT re-launch into a model the reactive-429 capture says is
    // still limited. A fresh five_hour keeps the account otherwise observed.
    const s = state(
      {
        [modelWindowKey("claude-fable-5")]: { status: "rejected", seenAt: NOW - 45 * 60 * 1000 },
        five_hour: { status: "allowed", seenAt: NOW - 1000 },
      },
      NOW - 1000,
    );
    // 45m old, TTL is 60m → still binding, regardless of the 30m staleAfterMs.
    expect(
      classifyAccountHealth(s, { staleAfterMs: 30 * 60 * 1000 }, NOW, "claude-fable-5").verdict,
    ).toBe("exhausted");
    // Past its own 60m TTL → no longer binding (aged out on its own terms).
    const old = state(
      { [modelWindowKey("claude-fable-5")]: { status: "rejected", seenAt: NOW - 75 * 60 * 1000 } },
      NOW - 75 * 60 * 1000,
    );
    expect(classifyAccountHealth(old, {}, NOW, "claude-fable-5").verdict).toBe("no_data");
  });

  test("a model window seen >8 days ago is dropped AND fires the cap alarm", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reset-bearing model window whose observation is 9 days old: the 8-day
    // horizon cap drops it (clock-skew / parse-bug alarm) exactly as it does
    // for account-level reset-bearing windows.
    const s = state(
      { [modelWindowKey("claude-fable-5")]: { status: "rejected", resetsAt: NOW_S + 3600, seenAt: NOW - 9 * DAY } },
      NOW - 9 * DAY,
    );
    const h = classifyAccountHealth(s, {}, NOW, "claude-fable-5");
    expect(h.verdict).not.toBe("exhausted");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/exceeded 8d reset-horizon cap/);
    expect(warn.mock.calls[0][0]).toContain("model:claude-fable-5");
  });
});

describe("model-id canonicalisation gates across spellings (fix A)", () => {
  const NOW_LOCAL = NOW;
  // Written under one spelling; read requests arrive under others. All name the
  // same cap, so all must be gated.
  const s = state(
    { [modelWindowKey("clawd/claude-fable-5")]: { status: "rejected", resetsAt: NOW_S + 2 * 86400, seenAt: NOW - 1000 } },
    NOW - 1000,
  );

  for (const spelling of [
    "clawd/claude-fable-5",
    "claw2/claude-fable-5",
    "claw3/claude-fable-5",
    "anthropic/claude-fable-5",
    "claude-fable-5",
  ]) {
    test(`request "${spelling}" is gated by the clawd/-written window`, () => {
      expect(classifyAccountHealth(s, {}, NOW_LOCAL, spelling).verdict).toBe("exhausted");
    });
  }

  test("an unknown-prefix spelling is NOT silently canonicalised (conservative)", () => {
    // The window is live evidence (→ ok), but an unknown-prefix request keys a
    // different window, so it is NOT gated as exhausted.
    expect(classifyAccountHealth(s, {}, NOW_LOCAL, "other/claude-fable-5").verdict).toBe("ok");
  });

  test("a LITERAL legacy prefixed disk key still gates (readHealthState bypass path)", () => {
    // The account-selection path (index.ts readHealthState → classify) reads
    // raw disk state WITHOUT mergeHealthStates, so classify must tolerate a
    // stock-v0.3.6 uncanonicalised key written straight to the file. Build it
    // as a literal string, NOT via modelWindowKey (which would canonicalise).
    const legacy = state(
      { "model:clawd/claude-fable-5": { status: "rejected", resetsAt: NOW_S + 2 * 86400, seenAt: NOW - 1000 } },
      NOW - 1000,
    );
    expect(classifyAccountHealth(legacy, {}, NOW_LOCAL, "claude-fable-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(legacy, {}, NOW_LOCAL, "clawd/claude-fable-5").verdict).toBe("exhausted");
  });
});
