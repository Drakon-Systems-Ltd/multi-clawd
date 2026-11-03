/**
 * #117: `multi-clawd doctor` on a missing OpenClaw config must stop up front
 * with the same actionable diagnostic as every other command (#106), exit 1,
 * and never print a ✅ derived from a file it never read. Fixture HOME only;
 * PATH is an empty scratch dir and the proxies point at a dead port.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DOCTOR = join(__dirname, "..", "scripts", "doctor.mjs");

function runDoctor(setup?: (home: string, configDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "mc-117-"));
  try {
    const home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "bin"));
    setup?.(home, join(home, ".openclaw"));
    const r = spawnSync(process.execPath, [DOCTOR], {
      encoding: "utf8",
      timeout: 20000,
      input: "",
      env: {
        PATH: join(root, "bin"),
        HOME: home,
        USERPROFILE: home,
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
      },
    });
    return { status: r.status, out: r.stdout, err: r.stderr, config: join(home, ".openclaw", "openclaw.json"), configDir: join(home, ".openclaw") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("doctor with a missing OpenClaw config (#117)", () => {
  test("no ~/.openclaw: resolved path, install-first hint, exit 1, no green checks", () => {
    const r = runDoctor();
    expect(r.status).toBe(1);
    expect(r.err).toContain(`doctor: OpenClaw config not found at ${r.config}`);
    expect(r.err).toContain("Install and start OpenClaw first");
    expect(r.err).toContain("multi-clawd setup");
    expect(r.out).not.toContain("✅");
    expect(r.out).not.toContain("plugins.allow OK");
    expect(r.out).not.toContain("problem(s) found");
  });

  test("~/.openclaw exists without a config: setup step, still no green checks", () => {
    const r = runDoctor((_h, dir) => mkdirSync(dir));
    expect(r.status).toBe(1);
    expect(r.err).toContain(`doctor: OpenClaw config not found at ${r.config}. Run \`multi-clawd setup\` to create it.`);
    expect(r.out).not.toContain("✅");
  });

  test("malformed config: says so, never echoes file content", () => {
    const r = runDoctor((_h, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, "openclaw.json"), '{"secret": "sk-test-NOT-REAL", oops');
    });
    expect(r.status).toBe(1);
    expect(r.err).toContain("is malformed JSON");
    expect(`${r.out}${r.err}`).not.toContain("sk-test-NOT-REAL");
    expect(r.out).not.toContain("✅");
  });

  test("valid config still runs the full checks", () => {
    const r = runDoctor((_h, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, "openclaw.json"), "{}");
    });
    expect(r.out).toContain("install & config");
    expect(r.err).not.toContain("OpenClaw config");
  });
});
