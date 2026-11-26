import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const weekly = { utilization: 46 };

test.each([
  { shape: "missing", body: { seven_day: weekly } },
  { shape: "null", body: { five_hour: null, seven_day: weekly } },
])("usage shows weekly without a 5-hour row when five_hour is $shape", ({ body }) => {
  const home = mkdtempSync(join(tmpdir(), "multi-clawd-usage-"));
  try {
    const config = join(home, "openclaw.json");
    const accounts = [{ id: "claw1", configDir: home }];
    writeFileSync(config, JSON.stringify({ plugins: { entries: { "multi-clawd": { config: { accounts } } } } }));
    writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only" } }));

    // Replace fetch before the real CLI loads. Only the response body varies.
    const preload = join(home, "fixture-fetch.cjs");
    writeFileSync(preload, `globalThis.fetch = async () => ({ status: 200, json: async () => (${JSON.stringify(body)}) });`);
    const run = (...args: string[]) => execFileSync(process.execPath, ["--require", preload, resolve("scripts/cli.mjs"), "usage", ...args], {
      encoding: "utf8",
      env: { HOME: home, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: home },
    });

    const text = run();
    expect(text).toMatch(/^\s*🟢 weekly\s+46%$/m);
    expect(text).not.toContain("5-hour");
    expect(JSON.parse(run("--json")).accounts[0].snapshot.windows).toEqual({ seven_day: { utilization: 0.46 } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
