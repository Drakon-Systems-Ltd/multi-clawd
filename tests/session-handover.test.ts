/**
 * Resume handover across pooled accounts (session_expired loop, 22–27 Sep 2026).
 *
 * The pool backend is ONE OpenClaw binding over several Claude config dirs.
 * A session written by claw2 was bound to `clawd`; once the pool returned home
 * to claw1, every `--resume` failed with "No conversation found" and the turn
 * cascaded off the pool — every turn, for days. These tests pin the planner,
 * the prepareExecution wiring that feeds it, and the shim end-to-end against a
 * fake CLI that resolves sessions the way the real one does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { accountConfigDir } from "../src/account-env";
import {
  effectiveConfigDir,
  handoverForLaunch,
  parseSessionDirs,
  planSessionHandover,
  resumeSessionId,
  SESSION_DIRS_ENV,
} from "../src/session-handover";
import { cleanShimEnv } from "./shim-env";

const SID = "e45941b9-adb9-4d98-9efc-a7be24d9ca27";
const SLUG = "-home-ubuntu-clawd";

let root: string;
let claw1: string;
let claw2: string;

/** Write `<configDir>/projects/<slug>/<SID>.jsonl` with an explicit mtime. */
function writeSession(configDir: string, body: string, mtimeS: number, sub = SLUG): string {
  const dir = join(configDir, "projects", sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${SID}.jsonl`);
  writeFileSync(file, body);
  utimesSync(file, mtimeS, mtimeS);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-handover-"));
  claw1 = join(root, "claw1");
  claw2 = join(root, "claw2");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resumeSessionId", () => {
  test("reads the id after --resume, -r, or --resume=", () => {
    expect(resumeSessionId(["-p", "--resume", SID, "--model", "x"])).toBe(SID);
    expect(resumeSessionId(["-r", SID])).toBe(SID);
    expect(resumeSessionId([`--resume=${SID}`])).toBe(SID);
  });

  test("fresh launches resume nothing", () => {
    expect(resumeSessionId(["-p", "--session-id", SID])).toBeUndefined();
  });

  test("an id that could escape the projects dir is refused", () => {
    expect(resumeSessionId(["--resume", "../../etc/passwd"])).toBeUndefined();
    expect(resumeSessionId(["--resume", "a/b"])).toBeUndefined();
    expect(resumeSessionId(["--resume"])).toBeUndefined();
  });
});

describe("config dirs", () => {
  test("native and token-only accounts share the CLI default dir; configDir accounts own theirs", () => {
    const def = join(homedir(), ".claude");
    expect(accountConfigDir({ id: "claw1", native: true })).toBe(def);
    expect(accountConfigDir({ id: "t", oauthTokenFile: "/k" })).toBe(def);
    expect(accountConfigDir({ id: "claw2", configDir: "/x/.claude-icloud" })).toBe("/x/.claude-icloud");
    expect(effectiveConfigDir({})).toBe(def);
    expect(effectiveConfigDir({ CLAUDE_CONFIG_DIR: "/x/.claude-icloud" })).toBe("/x/.claude-icloud");
  });

  test("a malformed dir list disables handover rather than throwing", () => {
    expect(parseSessionDirs(undefined)).toEqual([]);
    expect(parseSessionDirs("{not json")).toEqual([]);
    expect(parseSessionDirs('{"a":1}')).toEqual([]);
    expect(parseSessionDirs('["/a", 5, ""]')).toEqual(["/a"]);
  });
});

describe("planSessionHandover", () => {
  test("the live failure: session only in the other member's dir → copy it in", () => {
    const src = writeSession(claw2, "turns 1-10\n", 1_000);
    const plan = planSessionHandover({ sessionId: SID, targetDir: claw1, memberDirs: [claw1, claw2] });
    expect(plan).toEqual({
      action: "copy",
      from: src,
      to: join(claw1, "projects", SLUG, `${SID}.jsonl`),
      fromDir: claw2,
    });
  });

  test("the launched account already holds the newest copy → nothing to do", () => {
    writeSession(claw1, "turns 1-15\n", 2_000);
    writeSession(claw2, "turns 1-10\n", 1_000);
    expect(planSessionHandover({ sessionId: SID, targetDir: claw1, memberDirs: [claw1, claw2] })).toEqual({
      action: "none",
      reason: "already-local",
    });
  });

  test("a stale local prefix is replaced by the member's newer copy (rotated away and back)", () => {
    writeSession(claw1, "turns 1-10\n", 1_000);
    const newer = writeSession(claw2, "turns 1-15\n", 2_000);
    const plan = planSessionHandover({ sessionId: SID, targetDir: claw1, memberDirs: [claw1, claw2] });
    expect(plan).toMatchObject({ action: "copy", from: newer });
  });

  test("equal mtimes never churn", () => {
    writeSession(claw1, "same\n", 1_000);
    writeSession(claw2, "same\n", 1_000);
    expect(planSessionHandover({ sessionId: SID, targetDir: claw1, memberDirs: [claw2, claw1] })).toMatchObject({
      action: "none",
    });
  });

  test("a session in no member's dir is left for the CLI to report", () => {
    expect(planSessionHandover({ sessionId: SID, targetDir: claw1, memberDirs: [claw1, claw2] })).toEqual({
      action: "none",
      reason: "not-found",
    });
  });
});

describe("handoverForLaunch", () => {
  const env = () => ({ CLAUDE_CONFIG_DIR: claw1, [SESSION_DIRS_ENV]: JSON.stringify([claw1, claw2]) });

  test("copies the transcript byte-for-byte and says so", () => {
    writeSession(claw2, '{"type":"user"}\n{"type":"assistant","signature":"sig"}\n', 1_000);
    const note = handoverForLaunch(["-p", "--resume", SID], env());
    expect(note).toMatch(/copied from .*claw2/);
    expect(readFileSync(join(claw1, "projects", SLUG, `${SID}.jsonl`), "utf8")).toBe(
      '{"type":"user"}\n{"type":"assistant","signature":"sig"}\n',
    );
  });

  test("never throws — a failed copy leaves the launch as it was", () => {
    writeSession(claw2, "x\n", 1_000);
    const note = handoverForLaunch(["--resume", SID], env(), {
      apply: () => {
        throw new Error("EACCES");
      },
    });
    expect(note).toMatch(/handover failed .*EACCES/);
  });

  test("not a pool launch (no dir list) → silent no-op", () => {
    writeSession(claw2, "x\n", 1_000);
    expect(handoverForLaunch(["--resume", SID], { CLAUDE_CONFIG_DIR: claw1 })).toBeUndefined();
    expect(existsSync(join(claw1, "projects"))).toBe(false);
  });

  test("fresh launches are untouched", () => {
    writeSession(claw2, "x\n", 1_000);
    expect(handoverForLaunch(["-p", "--session-id", SID], env())).toBeUndefined();
    expect(existsSync(join(claw1, "projects"))).toBe(false);
  });
});

// ── end-to-end: the built shim in front of a fake CLI that resolves sessions
//    only in its own config dir, exactly like the real one ──────────────────
const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");

describe("shim resume handover (end-to-end)", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
    expect(existsSync(SHIM)).toBe(true);
  });

  function runShim(extraEnv: Record<string, string>) {
    return spawnSync(process.execPath, [SHIM, "-p", "--output-format", "stream-json", "--resume", SID], {
      input: "next turn\n",
      encoding: "utf8",
      env: {
        ...cleanShimEnv(),
        MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
        MULTI_CLAWD_STATE_FILE: join(root, "state", "claw1.json"),
        MULTI_CLAWD_ACCOUNT_ID: "claw1",
        FAKE_CLAUDE_EMULATE_RESUME: "1",
        CLAUDE_CONFIG_DIR: claw1,
        ...extraEnv,
      },
    });
  }

  test("the fake reproduces the live failure when the pool gives no dir list", () => {
    writeSession(claw2, '{"type":"user"}\n', 1_000);
    const res = runShim({});
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`No conversation found with session ID: ${SID}`);
  });

  test("with the pool's dir list, a session written by the other member resumes", () => {
    writeSession(claw2, '{"type":"user"}\n', 1_000);
    const res = runShim({ [SESSION_DIRS_ENV]: JSON.stringify([claw1, claw2]) });
    expect(res.stderr).not.toContain("No conversation found");
    expect(res.stderr).toContain("resume handover");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"type":"assistant"');
  });
});
