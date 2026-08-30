import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyAccountHealth,
  choosePoolAccount,
  pickPoolAccountForLaunch,
  summarizeWindowUsage,
  isShortWindow,
  isPeriodWindow,
  MODEL_REJECTED_TTL_MS,
  REJECTION_REVALIDATE_AFTER_MS,
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

  // Live case: an account held a real `unknown:rejected` window (a
  // Fable-limit 429 that arrived with no recognisable rateLimitType, so no
  // resetsAt). It must age out via the reset-less TTL path, never blackhole.
  test("reset-less `unknown:rejected` window ages out gracefully", () => {
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
    // for that model must still fire — this is the failure class fix A targets.
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

describe("summarizeWindowUsage", () => {

  test("no state → empty", () => {
    expect(summarizeWindowUsage(undefined, {}, NOW)).toEqual([]);
  });

  test("live reset-bearing windows surface, longest window first", () => {
    const s = state({
      five_hour: { status: "allowed", utilization: 0.04, resetsAt: NOW_S + 7200, seenAt: NOW - 1000 },
      seven_day: { status: "allowed_warning", utilization: 0.12, resetsAt: NOW_S + 3 * 86400, seenAt: NOW - 1000 },
    });
    const u = summarizeWindowUsage(s, {}, NOW);
    expect(u.map((x) => x.window)).toEqual(["seven_day", "five_hour"]);
    expect(u[0].utilization).toBe(0.12);
    expect(u[0].resetsAt).toBe((NOW_S + 3 * 86400) * 1000);
  });

  test("passed reset voids the utilization (previous cycle)", () => {
    const s = state({
      seven_day: { status: "allowed_warning", utilization: 0.85, resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
    });
    expect(summarizeWindowUsage(s, {}, NOW)).toEqual([]);
  });

  test("reset-less windows count on freshness alone", () => {
    const fresh = state({
      five_hour: { status: "allowed", utilization: 0.3, seenAt: NOW - 1000 },
    });
    expect(summarizeWindowUsage(fresh, {}, NOW)).toHaveLength(1);
    const stale = state({
      five_hour: { status: "allowed", utilization: 0.3, seenAt: NOW - 7 * 3_600_000 },
    });
    expect(summarizeWindowUsage(stale, {}, NOW)).toEqual([]);
  });

  test("model-scoped and utilization-less windows are omitted", () => {
    const s = state({
      "model:claude-fable-5": { status: "rejected", utilization: 0.99, resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
      five_hour: { status: "allowed", resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
    });
    expect(summarizeWindowUsage(s, {}, NOW)).toEqual([]);
  });

  test("windows beyond the 8-day reset horizon are dropped", () => {
    const s = state({
      seven_day: {
        status: "allowed",
        utilization: 0.5,
        resetsAt: NOW_S + 86400,
        seenAt: NOW - 9 * 86400 * 1000,
      },
    });
    expect(summarizeWindowUsage(s, {}, NOW)).toEqual([]);
  });
});

describe("short-window warnings (1.7.2)", () => {
  // Anthropic ships the 5-hour window as a bare status: every observation held
  // across both accounts since 21 Jul 2026 carries a status and a reset time
  // and no utilization. A rule that waits for a percentage never fires on the
  // session limit, so the warning itself has to count.
  test("numberless warning on a short window means near_limit", () => {
    const s = state({
      five_hour: { status: "allowed_warning", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 },
    });
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).toBe("near_limit");
    expect(h.reason).toContain("five_hour");
  });

  test("numberless warning on a LONG window does not rotate", () => {
    // The weekly window warns from ~0.3 utilization — acting on that status
    // alone would rotate almost permanently.
    const s = state({
      seven_day: { status: "allowed_warning", resetsAt: NOW_S + 86_400, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("when a number IS reported, the number wins over the warning", () => {
    const s = state({
      five_hour: {
        status: "allowed_warning",
        utilization: 0.5,
        resetsAt: NOW_S + 1800,
        seenAt: NOW - 1000,
      },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("a warning whose window has already reset is voided", () => {
    const s = state({
      five_hour: { status: "allowed_warning", resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("a reset-less warning counts on freshness alone, and ages out", () => {
    const fresh = state({ five_hour: { status: "allowed_warning", seenAt: NOW - 1000 } });
    expect(classifyAccountHealth(fresh, {}, NOW).verdict).toBe("near_limit");
    const old = state({ five_hour: { status: "allowed_warning", seenAt: NOW - 3_600_000 * 7 } });
    expect(classifyAccountHealth(old, {}, NOW).verdict).toBe("no_data");
  });

  test("unknown *_warning statuses count too (tolerant parsing)", () => {
    const s = state({
      five_hour: { status: "throttled_warning", resetsAt: NOW_S + 600, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });

  test("isShortWindow separates hour-scoped keys from day-scoped ones", () => {
    expect(isShortWindow("five_hour")).toBe(true);
    expect(isShortWindow("one_hour")).toBe(true);
    expect(isShortWindow("hourly_burst")).toBe(false);
    expect(isShortWindow("seven_day")).toBe(false);
    expect(isShortWindow("seven_day_overage_included")).toBe(false);
    expect(isShortWindow("unknown")).toBe(false);
  });

  test("the pool rotates off an account held only by a numberless warning", () => {
    const hot = classifyAccountHealth(
      state({ five_hour: { status: "allowed_warning", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 } }),
      {},
      NOW,
    );
    const spare = classifyAccountHealth(undefined, {}, NOW);
    expect(
      choosePoolAccount([
        { id: "claw1", verdict: hot.verdict },
        { id: "claw2", verdict: spare.verdict },
      ]),
    ).toBe("claw2");
  });
});

describe("rejections with no reset time (1.7.2)", () => {
  // The one record that says "this account just refused a turn" used to fall
  // through every branch when the reset field was absent.
  test("a fresh reset-less rejection exhausts for the TTL", () => {
    const s = state({ five_hour: { status: "rejected", seenAt: NOW - 60_000 } });
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).toBe("exhausted");
    expect(h.resumeAt).toBe(NOW - 60_000 + MODEL_REJECTED_TTL_MS);
  });

  test("it ages out rather than blocking the account forever", () => {
    const s = state({ five_hour: { status: "rejected", seenAt: NOW - 3_600_000 * 7 } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("no_data");
  });

  test("a weekly rejection with no reset binds the same way", () => {
    const s = state({ seven_day: { status: "rejected", seenAt: NOW - 60_000 } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });
});

describe("unknown-window rejections stay non-binding (1.7.2 guard)", () => {
  // Regression guard for the narrowing that the existing `unknown:rejected`
  // test forced: reset-less rejections bind only on NAMED period windows.
  test("a fresh reset-less `unknown` rejection does not exhaust the account", () => {
    const s = state({ unknown: { status: "rejected", seenAt: NOW - 1000 } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).not.toBe("exhausted");
  });

  test("the same record on a named window does exhaust", () => {
    const s = state({ five_hour: { status: "rejected", seenAt: NOW - 1000 } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });

  test("isPeriodWindow names the real provider periods only", () => {
    expect(isPeriodWindow("five_hour")).toBe(true);
    expect(isPeriodWindow("seven_day")).toBe(true);
    expect(isPeriodWindow("seven_day_overage_included")).toBe(true);
    expect(isPeriodWindow("unknown")).toBe(false);
    expect(isPeriodWindow("")).toBe(false);
  });
});

/**
 * Adversarial finding (9 Aug 2026, MEDIUM): 1.7.2 narrowed the RESET-LESS
 * rejection branch to named period windows so a Fable-only 429 (which lands on
 * `unknown`) could not bench an entire account. The reset-BEARING branch above
 * it never got the same guard, so the identical event carrying a reset stamp
 * still stranded every other model on that account. Same event, same rule.
 */
describe("account-level rejections bind symmetrically, reset or no reset", () => {
  test("a reset-bearing `unknown` rejection does not exhaust the account", () => {
    const s = state({ unknown: { status: "rejected", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).not.toBe("exhausted");
  });

  test("a reset-bearing rejection on a named period window still exhausts", () => {
    const s = state({
      seven_day: { status: "rejected", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 },
    });
    const h = classifyAccountHealth(s, {}, NOW);
    expect(h.verdict).toBe("exhausted");
    expect(h.resumeAt).toBe((NOW_S + 1800) * 1000);
  });
});

/**
 * Live incident, 9-10 Aug 2026 (issue #11). claw1 held ONE
 * `seven_day_overage_included: rejected` observation, seen 09 Aug 07:32Z with a
 * reset stamp 11 Aug 20:00Z. Reset-bearing windows were trusted until their own
 * reset regardless of age, so that single record benched a healthy account for
 * 30+ hours — direct probes outside the shim returned opus-5 successfully
 * throughout, all pool traffic piled onto the second account, and the pool alarmed
 * "every account is exhausted" with both accounts serving.
 *
 * The rule the file already applies to credentials (a failure stops binding
 * past its TTL so a fix made out-of-band is retried, and a still-dead login
 * re-records itself on the very next launch) is the right rule here too. A
 * rate limit can lift early — the provider is under no obligation to hold the
 * reset it quoted — so a rejection is a claim with a shelf life, not a fact
 * good until its own expiry date.
 */
describe("reset-bearing rejections re-validate rather than bench for days (#11)", () => {
  test("a fresh reset-bearing rejection still exhausts", () => {
    const s = state({
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: NOW_S + 172_800,
        seenAt: NOW - 60_000,
      },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });

  test("the same rejection stops binding once its observation passes the revalidate window", () => {
    const s = state({
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: NOW_S + 172_800,
        seenAt: NOW - REJECTION_REVALIDATE_AFTER_MS - 1,
      },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).not.toBe("exhausted");
  });

  test("the live claw1 shape: one 30h-old rejection no longer benches the account", () => {
    const s = state(
      {
        seven_day: {
          status: "allowed_warning",
          utilization: 0.84,
          resetsAt: NOW_S + 172_800,
          seenAt: NOW - 1000,
        },
        seven_day_overage_included: {
          status: "rejected",
          resetsAt: NOW_S + 172_800,
          seenAt: NOW - 30 * 3_600_000,
        },
      },
      NOW - 1000,
    );
    // 0.84 is below the 0.85 rotation threshold, so with the stale rejection no
    // longer binding the account is simply usable — which is what the direct
    // probes showed it to be.
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("ok");
  });

  test("model-scoped reset-bearing rejections are deliberately NOT re-validated", () => {
    // Asymmetry on purpose, recorded so nobody 'simplifies' it into symmetry.
    // #11's evidence is account-level only (claw1 and claw2, both on
    // `seven_day_overage_included`). A model-scoped bench costs one rung of the
    // failover chain, not the account, and re-validating it here would reverse
    // fix A's earned rule that a cap resetting in 2 days survives an idle
    // account. If a model-scoped phantom is ever observed, widen it then.
    const key = modelWindowKey("clawd/claude-opus-5");
    const s = state({
      [key]: {
        status: "rejected",
        resetsAt: NOW_S + 172_800,
        seenAt: NOW - REJECTION_REVALIDATE_AFTER_MS - 1,
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "clawd/claude-opus-5").verdict).toBe("exhausted");
  });

  test("re-validation applies to rejections only — a stale warning keeps its reset trust", () => {
    // Non-rejection windows do not bench an account, they only rotate it, so
    // ageing them out early buys nothing and would lose the near-limit signal
    // that reset-aware staleness (fix A) exists to preserve.
    const s = state(
      {
        seven_day: {
          status: "allowed_warning",
          utilization: 0.95,
          resetsAt: NOW_S + 172_800,
          seenAt: NOW - 30 * 3_600_000,
        },
      },
      NOW - 30 * 3_600_000,
    );
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("near_limit");
  });

  test("a rejection that recurs re-records and binds again — the block self-heals loudly", () => {
    // The freshly re-observed record is what makes a genuinely exhausted
    // account cost at most one wasted launch per revalidate window.
    const s = state({
      seven_day: { status: "rejected", resetsAt: NOW_S + 172_800, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });
});
