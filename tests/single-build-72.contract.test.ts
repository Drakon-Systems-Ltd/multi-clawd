import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// #72: the dist/ build is done once by the vitest globalSetup. A suite that
// rebuilds in its own beforeAll races every other suite reading dist/.
const TESTS = __dirname;
const ROOT = join(__dirname, "..");

describe("#72 single coordinated build", () => {
  test("vitest config registers the global build setup", () => {
    const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(cfg).toMatch(/globalSetup:\s*\[\s*"\.\/tests\/global-setup\.ts"/);
    const setup = readFileSync(join(TESTS, "global-setup.ts"), "utf8");
    expect(setup).toMatch(/"npm",\s*\["run",\s*"build"\]/);
  });

  test("no test file runs its own build", () => {
    const offenders = readdirSync(TESTS)
      .filter((f) => /\.test\.ts$/.test(f) && f !== "single-build-72.contract.test.ts")
      .filter((f) => /\[\s*"run",\s*"build"\s*\]|\btsc\b.*-p/.test(readFileSync(join(TESTS, f), "utf8")))
      // publishing-docs only matches workflow text, not a spawned build
      .filter((f) => !f.startsWith("publishing-docs"));
    expect(offenders).toEqual([]);
  });
});
