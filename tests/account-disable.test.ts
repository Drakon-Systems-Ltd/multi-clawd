import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
afterEach(reset);
reset();

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
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "account", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: temp },
    });
    const preview = run("disable", "work", "--dry-run");
    if ((preview.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") ctx.skip("sandbox blocks Node child processes");
    expect(preview.status).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    expect(run("disable", "work").status).toBe(0);
    expect(run("enable", "work").status).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(source);
    const unknown = run("disable", "missing");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown account id");
  });
});
