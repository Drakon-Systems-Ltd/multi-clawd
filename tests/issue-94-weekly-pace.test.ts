import { describe, expect, test } from "vitest";
import { computeWeeklyPace, renderExplanation, renderPaceLine } from "../src/explain-core";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const week = (util: number, remainingMs: number, window = "seven_day") => [
  { window, utilization: util, resetsAt: NOW + remainingMs },
];

describe("computeWeeklyPace (#94, display only)", () => {
  test("ahead of pace: projects exhaustion before the reset", () => {
    // 4 of 7 days gone, 80% used -> rate 0.2/day, 1 day to 100%, reset in 3 days
    const p = computeWeeklyPace(week(0.8, 3 * DAY), NOW)!;
    expect(p.expectedPct).toBeCloseTo(4 / 7, 5);
    expect(p.aheadOfPace).toBeCloseTo(0.8 - 4 / 7, 5);
    expect(p.projectedExhaustionAt).toBeCloseTo(NOW + DAY, -2);
    expect(p.willLastToReset).toBe(false);
    expect(p.estimate).toBe(true);
  });

  test("behind pace: lasts to the reset", () => {
    const p = computeWeeklyPace(week(0.2, 3 * DAY), NOW)!;
    expect(p.aheadOfPace).toBeLessThan(0);
    expect(p.willLastToReset).toBe(true);
  });

  test("zero use: no projected exhaustion, will last", () => {
    const p = computeWeeklyPace(week(0, 3 * DAY), NOW)!;
    expect(p.projectedExhaustionAt).toBeUndefined();
    expect(p.willLastToReset).toBe(true);
  });

  test("insufficient sample (under a tenth of the week) is suppressed", () => {
    expect(computeWeeklyPace(week(0.5, 7 * DAY - 3_600_000), NOW)).toBeUndefined();
  });

  test.each([
    ["no reset time", [{ window: "seven_day", utilization: 0.5 }]],
    ["reset already passed", week(0.5, -1000)],
    ["reset further than a week", week(0.5, 9 * DAY)],
    ["NaN utilization", week(NaN, 3 * DAY)],
    ["utilization above 1", week(1.4, 3 * DAY)],
    ["negative utilization", week(-0.1, 3 * DAY)],
    ["non-weekly window only", week(0.5, 3 * DAY, "five_hour")],
  ])("invalid sample suppressed: %s", (_n, usage) => {
    expect(computeWeeklyPace(usage as never, NOW)).toBeUndefined();
  });

  test("live-poll window outranks stream telemetry", () => {
    const usage = [...week(0.1, 3 * DAY), ...week(0.9, 3 * DAY, "usage:seven_day")];
    expect(computeWeeklyPace(usage, NOW)!.window).toBe("usage:seven_day");
  });
});

describe("explain rendering of pace", () => {
  const model = (usage: ReturnType<typeof week>) => ({
    accounts: [{ id: "claw1" }],
    health: [{ id: "claw1", verdict: "ok", usage }],
    nowMs: NOW,
  });

  test("labelled as a rough estimate, with ahead-of-pace and early exhaustion", () => {
    const out = renderExplanation(model(week(0.8, 3 * DAY)));
    expect(out).toMatch(/weekly pace \(rough estimate\)/);
    expect(out).toMatch(/points ahead of pace/);
    expect(out).toMatch(/could run out in ~24h, before the reset in ~3d/);
  });

  test("behind pace wording", () => {
    const line = renderPaceLine(computeWeeklyPace(week(0.1, 3 * DAY), NOW), NOW)!;
    expect(line).toMatch(/points behind pace; should last to the reset/);
  });

  test("no pace line when the sample is insufficient", () => {
    expect(renderExplanation(model(week(0.5, 7 * DAY - 3_600_000)))).not.toMatch(/weekly pace/);
  });
});
