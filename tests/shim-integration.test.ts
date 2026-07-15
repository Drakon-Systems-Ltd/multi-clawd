import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");

function runShim(opts: { exit?: string; stateFile: string }) {
  return spawnSync(process.execPath, [SHIM, "-p", "--output-format", "stream-json"], {
    input: "the prompt\n",
    encoding: "utf8",
    env: {
      ...process.env,
      MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
      MULTI_CLAWD_STATE_FILE: opts.stateFile,
      MULTI_CLAWD_ACCOUNT_ID: "claw2",
      FAKE_CLAUDE_EXIT: opts.exit ?? "0",
    },
  });
}

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  expect(existsSync(SHIM)).toBe(true);
});

describe("shim passthrough", () => {
  test("stdout reaches the parent byte-identical, stdin reaches the child", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const res = runShim({ stateFile: join(dir, "claw2.json") });
    expect(res.status).toBe(0);
    const out = res.stdout;
    expect(out).toContain('"type":"system"');
    expect(out).toContain('"type":"rate_limit_event"');
    expect(out).toContain('"type":"assistant"');
    // stdin made it through to the fake CLI's result record
    expect(out).toContain('"result":"the prompt"');
    // exactly the four records, unaltered order
    const types = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).type);
    expect(types).toEqual(["system", "rate_limit_event", "assistant", "result"]);
    expect(res.stderr).toContain("fake-claude stderr noise");
  });

  test("exit code is passed through", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const res = runShim({ exit: "3", stateFile: join(dir, "claw2.json") });
    expect(res.status).toBe(3);
  });
});

describe("shim health capture", () => {
  test("writes the rate-limit window to the state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    runShim({ stateFile });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.accountId).toBe("claw2");
    expect(state.windows.five_hour).toMatchObject({
      status: "allowed_warning",
      utilization: 0.87,
      resetsAt: 1784595600,
    });
    expect(typeof state.updatedAt).toBe("number");
  });

  test("still exits cleanly when the state file is unwritable", () => {
    const res = runShim({ stateFile: "/nonexistent-dir/deep/claw2.json" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"type":"result"');
  });
});
