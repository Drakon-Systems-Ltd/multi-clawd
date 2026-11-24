import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { changeAccount, editAccountDisabled } from "../scripts/account-config.mjs";

const temp = mkdtempSync(join(tmpdir(), "mc-account-disabled-"));
const configDir = join(temp, ".openclaw");
const configFile = join(configDir, "openclaw.json");
const cli = join(__dirname, "..", "scripts", "cli.mjs");
const source = `{
  "meta": { "keep": "unrelated   spaces", "nested": [1, {"x": "y"}] },
  "plugins": {
    "entries": {"multi-clawd": {"enabled": true, "config": {
      "accounts": [
        { "id": "work", "label": "Work", "disabled": false, "configDir": "~/work" },
        { "id": "personal", "native": true }
      ],
      "pool": {"id": "clawd", "accounts": ["work", "personal"]}
    }}}
  },
  "agents": {"defaults": {"model": {"primary": "clawd/claude-fable-5"}}}
}
`;

function reset() {
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, source);
}
afterEach(() => {
  vi.useRealTimers();
  reset();
});
reset();

/** Freeze the wall clock so every backup in a test is named from one instant (#197). */
const FIXED = new Date("2026-01-02T03:04:05.678Z");
const fixedBackup = `${configFile}.backup-2026-01-02T03-04-05-678Z`;
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED);
}

describe("account enable/disable config edits", () => {
  test("disable and enable change only the target flag and back up the previous bytes", () => {
    const disable = changeAccount("work", true, false, configFile);
    const disabled = readFileSync(configFile, "utf8");
    expect(disabled).toBe(source.replace('"disabled": false', '"disabled": true'));
    expect(readFileSync(disable.backup!, "utf8")).toBe(source);
    const enable = changeAccount("work", false, false, configFile);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(readFileSync(enable.backup!, "utf8")).toBe(disabled);
  });

  test("two changes in the same millisecond keep distinct, exact backups (#197)", () => {
    freezeClock();
    const disable = changeAccount("work", true, false, configFile);
    const disabled = readFileSync(configFile, "utf8");
    expect(disable.backup).toBe(fixedBackup);
    const enable = changeAccount("work", false, false, configFile);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(enable.backup).toBe(`${fixedBackup}-1`);
    const again = changeAccount("work", true, false, configFile);
    expect(again.backup).toBe(`${fixedBackup}-2`);
    // The earlier backups are never overwritten: each holds the bytes it replaced.
    expect(readFileSync(disable.backup!, "utf8")).toBe(source);
    expect(readFileSync(enable.backup!, "utf8")).toBe(disabled);
    expect(readFileSync(again.backup!, "utf8")).toBe(source);
    expect(readdirSync(configDir).sort()).toEqual(
      ["openclaw.json", disable.backup!, enable.backup!, again.backup!].map((p) => p.split("/").pop()).sort(),
    );
  });

  test("a pre-existing backup at the same instant is preserved byte for byte (#197)", () => {
    freezeClock();
    writeFileSync(fixedBackup, "operator bytes\n");
    const disable = changeAccount("work", true, false, configFile);
    expect(disable.backup).toBe(`${fixedBackup}-1`);
    expect(readFileSync(fixedBackup, "utf8")).toBe("operator bytes\n");
    expect(readFileSync(disable.backup!, "utf8")).toBe(source);
  });

  test("running out of backup names fails closed without touching the config (#197)", () => {
    freezeClock();
    writeFileSync(fixedBackup, "taken\n");
    for (let n = 1; n < 100; n++) writeFileSync(`${fixedBackup}-${n}`, `taken ${n}\n`);
    const before = readdirSync(configDir).sort();
    expect(() => changeAccount("work", true, false, configFile)).toThrow(/could not create a unique backup/);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(readdirSync(configDir).sort()).toEqual(before);
    expect(readFileSync(fixedBackup, "utf8")).toBe("taken\n");
    expect(readFileSync(`${fixedBackup}-99`, "utf8")).toBe("taken 99\n");
  });

  test("a backup that cannot be written fails closed without retrying (#197)", (ctx) => {
    if (process.getuid?.() === 0) ctx.skip("root ignores directory permissions");
    freezeClock();
    chmodSync(configDir, 0o500);
    try {
      expect(() => changeAccount("work", true, false, configFile)).toThrow(/EACCES/);
      expect(readFileSync(configFile, "utf8")).toBe(source);
      expect(readdirSync(configDir)).toEqual(["openclaw.json"]);
    } finally {
      chmodSync(configDir, 0o700);
    }
  });

  test("dry-run writes neither config nor backup", () => {
    expect(changeAccount("work", true, true, configFile)).toMatchObject({ changed: true, dryRun: true });
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(readdirSync(configDir)).toEqual(["openclaw.json"]);
  });

  test("unknown id and unsafe disabled value fail before writing", () => {
    expect(() => changeAccount("unknown", true, false, configFile)).toThrow('unknown account id "unknown"');
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(readdirSync(configDir)).toEqual(["openclaw.json"]);
    expect(() => editAccountDisabled(source.replace('"disabled": false', '"disabled": "false"'), "work", true)).toThrow("disabled must be a boolean");
  });

  test("a missing disabled property is added only to the chosen account", () => {
    const result = editAccountDisabled(source, "personal", true);
    expect(JSON.parse(result.edited).plugins.entries["multi-clawd"].config.accounts[1].disabled).toBe(true);
    expect(result.edited.replace(/, "disabled": true(?=\s*})/, "")).toBe(source);
  });

  test("CLI command round-trip, dry-run, and unknown id exit status", (ctx) => {
    // Select the fixture explicitly, including on Windows where HOME does not
    // determine OpenClaw's default config path.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: temp, OPENCLAW_CONFIG_PATH: configFile };
    for (const name of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]) delete env[name];
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "account", ...args], {
      encoding: "utf8", env,
    });
    const preview = run("disable", "work", "--dry-run");
    if ((preview.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") ctx.skip("sandbox blocks Node child processes");
    expect(preview.status).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(run("disable", "work").status).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(source.replace('"disabled": false', '"disabled": true'));
    expect(run("enable", "work").status).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    const unknown = run("disable", "missing");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown account id");
  });
});
