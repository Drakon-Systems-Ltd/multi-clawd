/**
 * #121: every command rejects a flag its `--help` does not list, the way
 * `explain` already did. One line names the flag, the next is the command's
 * usage line, exit 1, and nothing else happens. The case that matters most:
 * `setup --dryrun` (typo for `--dry-run`) used to run the wizard in write
 * mode, rewrite `openclaw.json` and leave a `.bak-setup-*` backup.
 *
 * Every spawn uses a scratch HOME plus a scratch `OPENCLAW_CONFIG_PATH`
 * holding a fixture config with two accounts and a pool. PATH is an empty
 * scratch dir (no `openclaw`/`claude`), stdin is empty, and the proxy vars
 * point at a dead port, so a command that slipped past the validator could
 * not reach a provider either.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "scripts", "cli.mjs");

const FIXTURE = JSON.stringify({
  agents: { defaults: { model: { primary: "clawd/claude-sonnet-4-5", fallbacks: ["anthropic/claude-sonnet-4-5"] } } },
  plugins: {
    entries: {
      "multi-clawd": {
        config: {
          accounts: [
            { id: "claw1", claudeDir: "~/.claude-claw1" },
            { id: "claw2", claudeDir: "~/.claude-claw2" },
          ],
          pool: { id: "clawd", accounts: ["claw1", "claw2"] },
        },
      },
    },
  },
}, null, 2);

function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "mc-flags-121-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const confDir = join(root, "openclaw");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  mkdirSync(confDir);
  const config = join(confDir, "openclaw.json");
  writeFileSync(config, FIXTURE);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 20000,
    input: "",
    env: {
      PATH: bin,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_STATE_DIR: join(root, "state"),
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
    },
  });
  const configAfter = readFileSync(config, "utf8");
  const confDirFiles = readdirSync(confDir).sort();
  const homeFiles = readdirSync(home).sort();
  rmSync(root, { recursive: true, force: true });
  return { r, configAfter, confDirFiles, homeFiles };
}

describe("unknown flags are rejected before anything runs (#121)", () => {
  test("setup --dryrun: exit 1, flag named, config byte-identical, no backup", () => {
    const { r, configAfter, confDirFiles, homeFiles } = run(["setup", "--dryrun"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("setup: unknown flag '--dryrun'");
    expect(r.stderr).toContain("usage: multi-clawd setup [--dry-run]");
    expect(r.stdout).toBe("");
    expect(configAfter).toBe(FIXTURE);
    expect(confDirFiles).toEqual(["openclaw.json"]);
    expect(homeFiles).toEqual([]);
    // Nothing of the wizard ran: no preflight, no prompt, no plan.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/preflight|dry run|Which account|claw1|claw2/i);
  });

  test("setup --dry-run --bogus: rejected even with a valid flag present", () => {
    const { r, configAfter, confDirFiles } = run(["setup", "--dry-run", "--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("setup: unknown flag '--bogus'");
    expect(configAfter).toBe(FIXTURE);
    expect(confDirFiles).toEqual(["openclaw.json"]);
  });

  test.each([
    ["chain", "--json", "multi-clawd chain [--raw]"],
    ["chain", "--bogus", "multi-clawd chain [--raw]"],
    ["usage", "--bogus", "multi-clawd usage [--json]"],
    ["doctor", "--bogus", "multi-clawd doctor [--probe]"],
    ["explain", "--bogus", "multi-clawd explain [--json | --history [--since 7d|24h]]"],
    ["direct", "--bogus", "multi-clawd direct [status | sync"],
    ["login", "--bogus", "multi-clawd login [<id>]"],
    ["update", "--bogus", "multi-clawd update"],
    ["version", "--bogus", "multi-clawd version"],
  ])("%s %s: exit 1, flag named, usage line, no report", (cmd, flag, usageLine) => {
    const { r, configAfter } = run([cmd, flag]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${cmd}: unknown flag '${flag}'`);
    expect(r.stderr).toContain(`usage: ${usageLine}`);
    expect(r.stdout).toBe("");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/claw1|claw2/);
    expect(configAfter).toBe(FIXTURE);
  });

  test("account disable claw1 --bogus: rejected with the account usage line", () => {
    const { r, configAfter } = run(["account", "disable", "claw1", "--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("account: unknown flag '--bogus'");
    expect(r.stderr).toContain("usage: multi-clawd account <enable|disable> <id> [--dry-run]");
    expect(configAfter).toBe(FIXTURE);
  });

  test("the first unknown flag is the one named; valid flags are not", () => {
    const { r } = run(["doctor", "--verbose", "--nope", "--raw", "--other"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("doctor: unknown flag '--nope'");
    expect(r.stderr).not.toContain("'--verbose'");
    expect(r.stderr).not.toContain("'--raw'");
  });

  test("a value-taking flag is not confused with its value: explain --history --since 24h passes validation", () => {
    const { r } = run(["explain", "--history", "--since", "24h"]);
    expect(r.stderr).not.toContain("unknown flag");
  });

  test("--flag=value is not a listed flag", () => {
    const { r, configAfter, confDirFiles } = run(["setup", "--dry-run=yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("setup: unknown flag '--dry-run=yes'");
    expect(configAfter).toBe(FIXTURE);
    expect(confDirFiles).toEqual(["openclaw.json"]);
  });

  test("documented flags still pass validation: chain --raw and usage --json run the command", () => {
    for (const args of [["chain", "--raw"], ["usage", "--json"], ["doctor", "--preflight"]]) {
      const { r } = run(args);
      expect(r.stderr, args.join(" ")).not.toContain("unknown flag");
    }
  });

  test("hermes keeps handling its own flags", () => {
    const { r } = run(["hermes", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("unknown flag");
  });

  test("--help still wins over an unknown flag", () => {
    const { r } = run(["setup", "--dryrun", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("multi-clawd setup");
  });
});
