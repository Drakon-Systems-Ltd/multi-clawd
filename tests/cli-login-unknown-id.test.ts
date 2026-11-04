/**
 * #122: `login <unknown-id>` must say the supplied id is unknown, naming it and
 * the config path, before listing configured accounts. Bare `login` keeps the
 * plain list and exit 0. Fixture HOME/state only; no login is ever attempted.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const CLI = resolve("scripts/cli.mjs");

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "multi-clawd-login-122-"));
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  const cfg = join(state, "openclaw.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      plugins: {
        entries: {
          "multi-clawd": {
            config: { accounts: [{ id: "claw1", label: "One" }, { id: "claw2", label: "Two" }] },
          },
        },
      },
    }),
  );
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: cfg },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("login with an unknown account id (#122)", () => {
  test("names the supplied id and config path, lists accounts, exits 1", () => {
    const r = run(["login", "nosuch"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("login: no account named 'nosuch' in ");
    expect(r.err).toContain("openclaw.json");
    expect(r.out).toContain("claw1");
    expect(r.out).toContain("claw2");
  });

  test("a near-miss id gets a hint", () => {
    const r = run(["login", "claw-2"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("no account named 'claw-2'");
    expect(r.err).toContain("did you mean 'claw2'?");
  });

  test("bare login is unchanged: list, exit 0, no error line", () => {
    const r = run(["login"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("claw1");
    expect(r.err).not.toContain("no account named");
  });
});
