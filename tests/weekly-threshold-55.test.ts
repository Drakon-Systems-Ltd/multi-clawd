import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { classifyAccountHealth } from "../src/health";
import { renderExplanation } from "../src/explain-core";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_784_500_000_000;

function state(window: string, utilization: number): AccountHealthState {
  return {
    accountId: "claw1",
    updatedAt: NOW,
    windows: { [window]: { status: "allowed", utilization, seenAt: NOW - 1_000 } },
  };
}

describe("weekly utilization threshold (#55)", () => {
  const options = { utilizationThreshold: 0.85, weeklyUtilizationThreshold: 0.97 };

  test("weekly quota at 90% stays available while the session at 90% rotates", () => {
    expect(classifyAccountHealth(state("seven_day", 0.9), options, NOW).verdict).toBe("ok");
    expect(classifyAccountHealth(state("five_hour", 0.9), options, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(state("usage:seven_day", 0.9), options, NOW).verdict).toBe("ok");
  });

  test("weekly quota breaches its own threshold", () => {
    expect(classifyAccountHealth(state("seven_day", 0.98), options, NOW).verdict).toBe("near_limit");
  });

  test("unset weekly threshold preserves the general threshold", () => {
    expect(classifyAccountHealth(state("seven_day", 0.9), {}, NOW).verdict).toBe("near_limit");
  });

  test("overage, model-scoped, and unknown windows retain the general threshold", () => {
    expect(classifyAccountHealth(state("seven_day_overage_included", 0.9), options, NOW).verdict).toBe("ok");
    expect(classifyAccountHealth(state("seven_day_overage_included", 0.9), { ...options, rotateOnOverage: true }, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(state("model:seven_day", 0.9), options, NOW).verdict).toBe("ok");
    expect(classifyAccountHealth(state("unknown", 0.9), options, NOW).verdict).toBe("near_limit");
  });

  test("manifest declares the weekly threshold as a fraction", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const pool = manifest.configSchema.properties.pool.properties;
    expect(pool.weeklyUtilizationThreshold.type).toBe(pool.utilizationThreshold.type);
    expect(pool.weeklyUtilizationThreshold.minimum).toBe(0);
    expect(pool.weeklyUtilizationThreshold.maximum).toBe(1);
  });

  test("explain shows both configured thresholds", () => {
    const out = renderExplanation({
      accounts: [],
      pool: { id: "clawd", accounts: ["claw1"], ...options },
      health: [],
    });
    expect(out).toContain("85%");
    expect(out).toMatch(/weekly.*97%/);
  });
});
