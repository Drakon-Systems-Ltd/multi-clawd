import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { classifyAccountHealth, isLongQuotaWindow } from "../src/health";
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

  test("only day/week/month quota windows take the weekly threshold", () => {
    for (const window of ["two_minutes", "five_hour", "seven_day_overage_included"]) {
      expect(isLongQuotaWindow(window)).toBe(false);
    }
    for (const window of ["seven_day", "two_weeks", "one_month", "usage:seven_day"]) {
      expect(isLongQuotaWindow(window)).toBe(true);
    }
    expect(classifyAccountHealth(state("two_minutes", 0.9), options, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(state("five_hour", 0.9), options, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(state("seven_day", 0.9), options, NOW).verdict).toBe("ok");
    expect(classifyAccountHealth(state("seven_day_overage_included", 0.9), { ...options, rotateOnOverage: true }, NOW).verdict).toBe("near_limit");
    expect(classifyAccountHealth(state("seven_day", 0.9), { utilizationThreshold: 0.85 }, NOW).verdict).toBe("near_limit");
  });

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
    expect(out).toContain("Thresholds: general 85%, weekly 97%");
    expect(out).toContain("day/week/month quota windows");
    const unset = renderExplanation({ accounts: [], pool: { id: "clawd", accounts: ["claw1"] }, health: [] });
    expect(unset).toContain("Thresholds: general 85%, weekly 85% (follows general)");
  });

  test("doctor reports configured and inherited pool thresholds", () => {
    const home = mkdtempSync(join(tmpdir(), "multi-clawd-doctor-threshold-"));
    const openclaw = join(home, ".openclaw");
    const extension = join(openclaw, "extensions", "multi-clawd");
    const stateDir = join(openclaw, "state", "multi-clawd");
    mkdirSync(extension, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    copyFileSync(resolve("openclaw.plugin.json"), join(extension, "openclaw.plugin.json"));
    // Seed doctor's install-record cache (#85) so it does not launch the real
    // OpenClaw from node_modules/.bin, which is slow on a cold temp HOME.
    writeFileSync(join(stateDir, "install-record.json"), JSON.stringify({ installDir: extension, manifestMtimeMs: statSync(join(extension, "openclaw.plugin.json")).mtimeMs, recordKey: "{}", checkedAt: Date.now(), install: { source: "path" } }));
    writeFileSync(join(stateDir, "registry-check.json"), JSON.stringify({ latest: "2.1.3", checkedAt: Date.now() }));
    const run = (pool: object) => {
      writeFileSync(join(openclaw, "openclaw.json"), JSON.stringify({ plugins: { entries: { "multi-clawd": { enabled: true, config: { accounts: [], pool: { id: "clawd", accounts: [], ...pool } } } } } }));
      const result = spawnSync(process.execPath, [resolve("scripts/doctor.mjs")], {
        env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      return result.stdout + result.stderr;
    };
    expect(run({ utilizationThreshold: 0.85, weeklyUtilizationThreshold: 0.97 })).toContain("thresholds: general 85%, weekly 97%");
    expect(run({})).toContain("thresholds: general 85%, weekly 85% (follows general)");
  });

  test("doctor warns for a pool with one enabled and one benched member", () => {
    const home = mkdtempSync(join(tmpdir(), "multi-clawd-doctor-benched-"));
    const openclaw = join(home, ".openclaw");
    const extension = join(openclaw, "extensions", "multi-clawd");
    const stateDir = join(openclaw, "state", "multi-clawd");
    mkdirSync(extension, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    copyFileSync(resolve("openclaw.plugin.json"), join(extension, "openclaw.plugin.json"));
    // Seed doctor's install-record cache (#85) so it does not launch the real
    // OpenClaw from node_modules/.bin, which is slow on a cold temp HOME.
    writeFileSync(join(stateDir, "install-record.json"), JSON.stringify({ installDir: extension, manifestMtimeMs: statSync(join(extension, "openclaw.plugin.json")).mtimeMs, recordKey: "{}", checkedAt: Date.now(), install: { source: "path" } }));
    writeFileSync(join(stateDir, "registry-check.json"), JSON.stringify({ latest: "2.3.0", checkedAt: Date.now() }));
    const run = (accounts: object[], poolAccounts: string[], degrade?: object) => {
      writeFileSync(join(openclaw, "openclaw.json"), JSON.stringify({
        plugins: { entries: { "multi-clawd": { enabled: true, config: {
          accounts, pool: { id: "clawd", accounts: poolAccounts, degrade },
        } } } },
      }));
      const result = spawnSync(process.execPath, [resolve("scripts/doctor.mjs")], {
        env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      return result.stdout + result.stderr;
    };
    try {
      const claw1 = { id: "claw1", native: true };
      const claw2 = { id: "claw2", configDir: join(home, "claw2"), disabled: true };
      const benched = run([claw1, claw2], ["claw1", "claw2"]);
      expect(benched).toMatch(/⚠️\s+pool "clawd" has 1 valid member\(s\)/);
      expect(benched).not.toMatch(/❌\s+pool "clawd" has 1 valid member\(s\)/);

      const undersized = run([claw1], ["claw1"]);
      expect(undersized).toMatch(/❌\s+pool "clawd" has 1 valid member\(s\); needs ≥ 2/);

      const ladder = run([claw1], ["claw1"], { ladder: ["claude-sonnet-4-5"] });
      expect(ladder).toMatch(/ℹ️\s+pool "clawd" has 1 valid member\(s\) with a degrade ladder/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
