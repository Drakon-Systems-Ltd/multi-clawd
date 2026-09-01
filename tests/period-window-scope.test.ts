import { describe, expect, test } from "vitest";
import { classifyAccountHealth, resetLessBlockMs, MODEL_REJECTED_TTL_MS } from "../src/health";
import { updateHealthState, type AccountHealthState } from "../src/shim-core";

const NOW = 1_784_500_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function stateWith(windows: AccountHealthState["windows"]): AccountHealthState {
  return { accountId: "claw1", updatedAt: NOW, windows };
}

/**
 * #10 — a reset-less rejection blocks for a guess at "how long until this
 * lifts". One hour is right for a 5-hour window and badly wrong for a weekly
 * one, where un-benching at +1h sends the pool home to a still-limited account.
 */
describe("#10 reset-less block scales with the window's period", () => {
  test("an hour-scoped window keeps the one-hour block", () => {
    expect(resetLessBlockMs("five_hour")).toBe(MODEL_REJECTED_TTL_MS);
  });

  test("day-scoped windows block for materially longer than an hour", () => {
    for (const w of ["seven_day", "seven_day_overage_included"]) {
      expect(resetLessBlockMs(w)).toBeGreaterThan(MODEL_REJECTED_TTL_MS);
    }
  });

  test("but never longer than the revalidation horizon a real weekly reset implies", () => {
    // A blind block must stay far short of the 8-day reset horizon: the cost of
    // over-benching a recovered account is real capacity, so this is bounded.
    expect(resetLessBlockMs("seven_day")).toBeLessThanOrEqual(12 * HOUR);
  });

  test("five_hour: still exhausted inside the hour, released after it", () => {
    const s = stateWith({ five_hour: { status: "rejected", seenAt: NOW - 30 * MIN } });
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
    const later = NOW + 40 * MIN;
    expect(
      classifyAccountHealth({ ...s, updatedAt: later }, {}, later).verdict,
    ).not.toBe("exhausted");
  });

  test("seven_day: STILL exhausted at +2h, where the flat TTL used to release it", () => {
    const seenAt = NOW - 2 * HOUR;
    const s = stateWith({ seven_day_overage_included: { status: "rejected", seenAt } });
    const h = classifyAccountHealth({ ...s, updatedAt: NOW }, {}, NOW);
    expect(h.verdict).toBe("exhausted");
    expect(h.resumeAt).toBe(seenAt + resetLessBlockMs("seven_day_overage_included"));
  });
});

/**
 * #12 — named period windows were keyed by rateLimitType alone, so a rejection
 * produced while serving one model benched the account for every model. Live
 * evidence: an account carrying `seven_day_overage_included: rejected` kept
 * serving a different model fine.
 */
describe("#12 a period rejection is scoped to the model that earned it", () => {
  test("updateHealthState records the model that was running", () => {
    const s = updateHealthState(
      { accountId: "claw1", windows: {} },
      { status: "rejected", rateLimitType: "seven_day_overage_included" },
      NOW,
      "claude-fable-5",
    );
    expect(s.windows.seven_day_overage_included.model).toBe("claude-fable-5");
  });

  test("the window is keyed by type as before — no key migration", () => {
    const s = updateHealthState(
      { accountId: "claw1", windows: {} },
      { status: "rejected", rateLimitType: "seven_day" },
      NOW,
      "claude-fable-5",
    );
    expect(Object.keys(s.windows)).toEqual(["seven_day"]);
  });

  test("exhausts the model it names, and NOT another model on the same account", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        seenAt: NOW - 10 * MIN,
        model: "claude-fable-5",
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).not.toBe("exhausted");
  });

  test("model matching is canonical — provider-prefixed ids still match", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        seenAt: NOW - 10 * MIN,
        model: "claude-fable-5",
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "clawd/claude-fable-5").verdict).toBe("exhausted");
  });

  test("a reset-BEARING period rejection is scoped the same way", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: NOW / 1000 + 3600,
        seenAt: NOW - 10 * MIN,
        model: "claude-fable-5",
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).not.toBe("exhausted");
  });

  test("BACKWARD COMPAT: a legacy record with no model still gates every model", () => {
    const s = stateWith({
      seven_day_overage_included: { status: "rejected", seenAt: NOW - 10 * MIN },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).toBe("exhausted");
    // and with no model requested at all
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });

  test("a model-scoped rejection does not bench the account for an unspecified request", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        seenAt: NOW - 10 * MIN,
        model: "claude-fable-5",
      },
    });
    // No requested model: we cannot say this applies, so it must not exhaust.
    expect(classifyAccountHealth(s, {}, NOW).verdict).not.toBe("exhausted");
  });
});

/**
 * #19 — the #12 scoping was applied to allowance windows too, so a WEEKLY
 * account lockout was honoured for one model only.
 *
 * Live case, claw1 on 2026-09-01: `seven_day: rejected` (resets 20:00Z)
 * stamped `claude-sonnet-5`. The classifier returned `ok` for
 * `claude-opus-5`, the pool kept claw1 as its home account, and every
 * non-interactive lane failed with "You've hit your weekly limit" while the
 * pool's other account sat idle.
 */
describe("#19 an allowance rejection is account-wide, whatever model tripped it", () => {
  test("seven_day rejected while serving sonnet also benches opus", () => {
    const s = stateWith({
      seven_day: {
        status: "rejected",
        resetsAt: NOW / 1000 + 3600,
        seenAt: NOW - 10 * MIN,
        model: "claude-sonnet-5",
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-sonnet-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).toBe("exhausted");
    // and with no model named at all — an allowance window needs no attribution
    expect(classifyAccountHealth(s, {}, NOW).verdict).toBe("exhausted");
  });

  test("five_hour behaves the same way", () => {
    const s = stateWith({
      five_hour: { status: "rejected", seenAt: NOW - 5 * MIN, model: "claude-sonnet-5" },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).toBe("exhausted");
  });

  test("spill-over stays model-scoped — #12 is not reversed", () => {
    const s = stateWith({
      seven_day_overage_included: {
        status: "rejected",
        seenAt: NOW - 10 * MIN,
        model: "claude-fable-5",
      },
    });
    expect(classifyAccountHealth(s, {}, NOW, "claude-opus-5").verdict).not.toBe("exhausted");
  });

  test("the exact live claw1 state benches opus-5", () => {
    const s = {
      accountId: "claw1",
      updatedAt: NOW,
      windows: {
        five_hour: {
          status: "allowed",
          resetsAt: NOW / 1000 - 3600,
          seenAt: NOW - 30 * MIN,
          model: "claude-opus-5",
        },
        seven_day: {
          status: "rejected",
          resetsAt: NOW / 1000 + 6 * 3600,
          seenAt: NOW - 5 * MIN,
          model: "claude-sonnet-5",
        },
      },
    } as Parameters<typeof classifyAccountHealth>[0];
    const h = classifyAccountHealth(s, {}, NOW, "claude-opus-5");
    expect(h.verdict).toBe("exhausted");
    expect(h.reason).toMatch(/seven_day rejected until/);
  });
});
