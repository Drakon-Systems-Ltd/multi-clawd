import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const CLI = resolve("scripts/cli.mjs");

function run(args: string[]) {
  // Isolated HOME / OpenClaw state: nothing here may touch real config.
  const home = mkdtempSync(join(tmpdir(), "multi-clawd-cli-ux-"));
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, OPENCLAW_STATE_DIR: join(home, "state") },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("cli top-level help and unknown commands", () => {
  test.each([[[]], [["--help"]], [["-h"]], [["help"]]])("%j prints usage and exits 0", (args) => {
    const r = run(args);
    expect(r.status).toBe(0);
    expect(r.out).toContain("guided setup wizard");
    expect(r.err).toBe("");
  });

  test("unknown command names it on stderr, points at --help, shows usage, exits 1", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("multi-clawd: unknown command 'bogus'");
    expect(r.err).toContain("multi-clawd --help");
    expect(r.out).toContain("guided setup wizard");
  });

  test("-V is the version command, not an unknown command", () => {
    const r = run(["-V"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^cli: v\d+\.\d+\.\d+/);
    expect(r.err).not.toContain("unknown command");
  });
});
