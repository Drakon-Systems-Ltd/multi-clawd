import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readSessionPin, recordSessionPin, SESSION_AFFINITY_ENV } from "../src/session-affinity.js";
import { cleanShimEnv } from "./shim-env.js";

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const dir = mkdtempSync(join(tmpdir(), "mc-affinity-"));
const pinFile = join(dir, "pool-clawd.sessions.json");
const claw1State = join(dir, "claw1.json");
const claw2State = join(dir, "claw2.json");
const ttlMs = 30 * 24 * 60 * 60 * 1000;
const roster = [
  { id: "claw1", stateFile: claw1State, env: { CLAUDE_CONFIG_DIR: join(dir, "claw1") } },
  { id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: join(dir, "claw2") } },
];

beforeAll(() => {
  expect(existsSync(SHIM)).toBe(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function launch(opts: {
  session?: string;
  resume?: boolean;
  affinity?: boolean;
  claw2Verdict?: string;
  limitFor?: string;
}) {
  const env = cleanShimEnv({
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    MULTI_CLAWD_STATE_FILE: claw1State,
    CLAUDE_CONFIG_DIR: join(dir, "claw1"),
    ...(opts.limitFor ? { FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: opts.limitFor } : {}),
  });
  if (opts.affinity) env[SESSION_AFFINITY_ENV] = JSON.stringify({
    file: pinFile,
    ttlMs,
    verdicts: [
      { id: "claw1", verdict: "ok" },
      { id: "claw2", verdict: opts.claw2Verdict ?? "ok" },
    ],
    roster,
  });
  const args = [SHIM, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];
  if (opts.session) args.push(opts.resume ? "--resume" : "--session-id", opts.session);
  const result = spawnSync(process.execPath, args, { env, input: "hello\n", encoding: "utf8" });
  const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, servedBy: records.find((r) => r.type === "result")?.served_by };
}

describe("CLI session affinity (#56)", () => {
  test("A stays on claw2 after home recovers; a new B goes home", () => {
    recordSessionPin(pinFile, "A", "claw2", Date.now(), ttlMs);
    expect(launch({ session: "A", resume: true, affinity: true }).servedBy).toBe("claw2");
    expect(launch({ session: "B", affinity: true }).servedBy).toBe("claw1");
    expect(readSessionPin(pinFile, "B", Date.now(), ttlMs)?.account).toBe("claw1");
  });

  test("near-limit pinned account yields and successful replacement becomes pin", () => {
    recordSessionPin(pinFile, "A", "claw2", Date.now(), ttlMs);
    expect(launch({ session: "A", affinity: true, claw2Verdict: "near_limit" }).servedBy).toBe("claw1");
    expect(readSessionPin(pinFile, "A", Date.now(), ttlMs)?.account).toBe("claw1");
  });

  test("in-turn retry records the actual serving account", () => {
    recordSessionPin(pinFile, "retryA", "claw2", Date.now(), ttlMs);
    const { result, servedBy } = launch({ session: "retryA", affinity: true, limitFor: "claw2" });
    expect(result.status).toBe(0);
    expect(servedBy).toBe("claw1");
    expect(readSessionPin(pinFile, "retryA", Date.now(), ttlMs)?.account).toBe("claw1");
  });

  test("no session id and feature off keep the prepared home selection", () => {
    recordSessionPin(pinFile, "A", "claw2", Date.now(), ttlMs);
    expect(launch({ affinity: true }).servedBy).toBe("claw1");
    expect(launch({ session: "A" }).servedBy).toBe("claw1");
  });

  test("expired, corrupt, and removed-account pins are ignored", () => {
    recordSessionPin(pinFile, "old", "claw2", Date.now() - ttlMs - 1, ttlMs);
    expect(launch({ session: "old", affinity: true }).servedBy).toBe("claw1");
    writeFileSync(pinFile, "{broken");
    expect(launch({ session: "corrupt", affinity: true }).servedBy).toBe("claw1");
    recordSessionPin(pinFile, "removed", "claw3", Date.now(), ttlMs);
    expect(launch({ session: "removed", affinity: true }).servedBy).toBe("claw1");
  });
});
