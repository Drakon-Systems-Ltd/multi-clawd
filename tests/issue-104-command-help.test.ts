/**
 * #104: `<command> --help` / `-h` must print that command's usage and exit 0
 * without side effects. Before the fix, `setup --help` entered the wizard,
 * `doctor --help` ran the health check, and `usage|chain|direct|login --help`
 * read the OpenClaw config.
 *
 * Every spawn uses a fixture-only HOME holding a sentinel config. Help must not
 * read it (no "could not read" / config-derived output), must not write
 * anywhere in HOME, and must not reach a provider: PATH is a scratch dir with
 * no `openclaw`/`claude`, and a trap env var proxy points at a dead port.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "scripts", "cli.mjs");
const COMMANDS = ["setup", "login", "account", "explain", "chain", "direct", "usage", "update", "doctor", "version"];

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      out.push(`${p}:${st.isDirectory() ? "d" : `${st.size}:${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "mc-help-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  mkdirSync(bin);
  const config = join(home, ".openclaw", "openclaw.json");
  // Sentinel: valid JSON naming an account, so a command that reads it would
  // print the account id (login/explain/chain/usage all echo accounts).
  writeFileSync(config, JSON.stringify({
    plugins: { entries: { "multi-clawd": { config: { accounts: [{ id: "sentinel-acct-104" }] } } } },
  }));
  const before = snapshot(home);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 20000,
    input: "",
    env: {
      PATH: bin,
      HOME: home,
      USERPROFILE: home,
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
    },
  });
  const after = snapshot(home);
  const configAfter = readFileSync(config, "utf8");
  rmSync(root, { recursive: true, force: true });
  return { r, before, after, configAfter };
}

describe("per-command help (#104)", () => {
  for (const cmd of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      test(`${cmd} ${flag}: usage, exit 0, no side effects`, () => {
        const { r, before, after } = run([cmd, flag]);
        const out = `${r.stdout}${r.stderr}`;
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`multi-clawd ${cmd}`);
        expect(out).not.toContain("sentinel-acct-104");
        expect(out).not.toMatch(/could not read|preflight|Which account\?|no multi-clawd accounts|✓|✗/i);
        expect(after).toEqual(before);
      });
    }
  }

  test("help wins over operands and still does nothing", () => {
    const { r, before, after } = run(["account", "disable", "sentinel-acct-104", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("multi-clawd account");
    expect(after).toEqual(before);
  });

  test("hermes keeps handling its own help", () => {
    const { r } = run(["hermes", "--help"]);
    expect(r.status).toBe(0);
  });

  test("unknown commands and bare invocation keep their behaviour", () => {
    expect(run([]).r.status).toBe(0);
    expect(run(["nonsense", "--help"]).r.status).toBe(1);
  });

  test("inherited prototype names are not commands: general usage, exit 1", () => {
    const names = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];
    for (const name of names) {
      for (const flag of ["--help", "-h"]) {
        const { r } = run([name, flag]);
        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, `${name} ${flag}`).toBe(1);
        expect(out, `${name} ${flag}`).not.toMatch(/\[native code\]|\[object /);
        expect(out, `${name} ${flag}`).toMatch(/usage/i);
      }
    }
  });

  test("normal invocation is not swallowed: account without args still errors", () => {
    const { r } = run(["account"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage: multi-clawd account");
  });
});
