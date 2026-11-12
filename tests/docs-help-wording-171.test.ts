/** #171: help/README wording matches behaviour. Pure reads: fixture HOME, no provider, no config. */
import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "scripts", "cli.mjs");
function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "mc-171-"));
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, OPENCLAW_STATE_DIR: join(home, "state") },
  });
  return { status: r.status, out: r.stdout };
}

describe("#171 help and README wording", () => {
  test("doctor --help says --raw unmasks emails and session ids, probe costs per account plus pool", () => {
    const r = run(["doctor", "--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/--raw\s+show login emails and session ids unmasked/);
    expect(r.out).toContain("do not paste");
    expect(r.out).toContain("one live turn per account plus one for the pool");
  });
  test("chain --help says --raw unmasks session ids", () => {
    expect(run(["chain", "--help"]).out).toMatch(/--raw\s+show session ids unmasked/);
  });
  test("top-level help points at per-command --help", () => {
    expect(run(["--help"]).out).toContain("multi-clawd <command> --help");
  });
  test("README states probe cost and documents --raw", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("one live turn per account plus one for the pool");
    expect(readme).toContain("DOCTOR_RAW=1");
    expect(readme).toContain("multi-clawd doctor --preflight");
  });
});
