/**
 * #24 — the in-turn retry now covers resumed launches.
 *
 * #19 bounded the retry to fresh launches because a resumed session lived in
 * the refusing account's config dir. The resume handover removed that reason:
 * the transcript can be made present wherever the turn is launched. What is
 * left is one subtlety this file exists to pin — the refused attempt has
 * ALREADY WRITTEN to the transcript (the user's message, then the refusal), so
 * the sibling must be handed the conversation as it stood BEFORE the attempt,
 * or it resumes a history that contains the refusal and the message twice.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_ROSTER_ENV, retryArming } from "../src/retry-plan";
import {
  handoverSnapshotTo,
  SESSION_DIRS_ENV,
  snapshotResumeTranscript,
} from "../src/session-handover";
import { cleanShimEnv } from "./shim-env";

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const SESSION = "0f3c1a52-7d7e-4b8e-9a51-2f6f0c9d1e11";
const SLUG = "-tmp-ws";
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];
const HISTORY =
  [
    JSON.stringify({ type: "user", text: "first question" }),
    JSON.stringify({ type: "assistant", text: "first answer" }),
  ].join("\n") + "\n";

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  expect(existsSync(SHIM)).toBe(true);
});

interface Box {
  dir: string;
  claw1Dir: string;
  claw2Dir: string;
  claw1State: string;
  claw2State: string;
  claw1Transcript: string;
  claw2Transcript: string;
}

/** Two accounts; the conversation so far lives in claw1's config dir only. */
function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), "mc-24-"));
  const claw1Dir = join(dir, "claw1-login");
  const claw2Dir = join(dir, "claw2-login");
  mkdirSync(join(claw1Dir, "projects", SLUG), { recursive: true });
  mkdirSync(claw2Dir, { recursive: true });
  const claw1Transcript = join(claw1Dir, "projects", SLUG, `${SESSION}.jsonl`);
  writeFileSync(claw1Transcript, HISTORY);
  return {
    dir,
    claw1Dir,
    claw2Dir,
    claw1State: join(dir, "claw1.json"),
    claw2State: join(dir, "claw2.json"),
    claw1Transcript,
    claw2Transcript: join(claw2Dir, "projects", SLUG, `${SESSION}.jsonl`),
  };
}

function run(
  b: Box,
  opts: { limitFor?: string; roster?: boolean; sessionDirs?: boolean; args?: string[] } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: b.claw1State,
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    CLAUDE_CONFIG_DIR: b.claw1Dir,
    FAKE_CLAUDE_EXIT: "0",
    FAKE_CLAUDE_EMULATE_RESUME: "1",
    FAKE_CLAUDE_WRITE_TRANSCRIPT: "1",
    FAKE_CLAUDE_LIMIT_TEXT:
      "You've reached your Fable limit. Switch to another model, or manage usage credits.",
  };
  if (opts.limitFor) env.FAKE_CLAUDE_LIMIT_FOR_ACCOUNT = opts.limitFor;
  if (opts.roster !== false) {
    env[RETRY_ROSTER_ENV] = JSON.stringify([
      { id: "claw2", stateFile: b.claw2State, env: { CLAUDE_CONFIG_DIR: b.claw2Dir } },
    ]);
  }
  if (opts.sessionDirs !== false) {
    env[SESSION_DIRS_ENV] = JSON.stringify([b.claw1Dir, b.claw2Dir]);
  }
  return spawnSync(
    process.execPath,
    [SHIM, ...(opts.args ?? [...STREAM_ARGS, "--resume", SESSION])],
    { input: "the second question\n", encoding: "utf8", env },
  );
}

function records(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("#24 a resumed launch refused on a model limit is served by the sibling", () => {
  test("the turn completes on the sibling and the refusal never reaches the user", () => {
    const b = box();
    const res = run(b, { limitFor: "claw1" });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("reached your");
    const out = records(res.stdout);
    expect(out.filter((r) => r.type === "system")).toHaveLength(1);
    const result = out.find((r) => r.type === "result");
    expect(result?.served_by).toBe("claw2");
    expect(result?.config_dir).toBe(b.claw2Dir);
    expect(result?.result).toBe("the second question");
    expect(res.stderr).toContain("retrying this turn on claw2");
  });

  test("the sibling resumes the conversation as it stood BEFORE the refused attempt", () => {
    const b = box();
    run(b, { limitFor: "claw1" });
    const handed = readFileSync(b.claw2Transcript, "utf8");
    // The history, then exactly what the sibling's own turn wrote.
    expect(handed.startsWith(HISTORY)).toBe(true);
    const tail = handed
      .slice(HISTORY.length)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(tail).toEqual([
      { type: "user", by: "claw2" },
      { type: "assistant", by: "claw2" },
    ]);
    // Nothing of the refused attempt crossed over.
    expect(handed).not.toContain("<synthetic>");
    expect(handed).not.toContain('"by":"claw1"');
  });

  test("the refusing account is recorded as limited, the sibling is not", () => {
    const b = box();
    run(b, { limitFor: "claw1" });
    const claw1 = JSON.parse(readFileSync(b.claw1State, "utf8")) as {
      windows: Record<string, { status: string; family?: string }>;
    };
    expect(claw1.windows["model:claude-fable-5-1"].status).toBe("rejected");
    expect(claw1.windows["model:claude-fable-5-1"].family).toBe("fable");
    const claw2 = JSON.parse(readFileSync(b.claw2State, "utf8")) as {
      windows: Record<string, { status: string }>;
    };
    expect(claw2.windows["model:claude-fable-5-1"]).toBeUndefined();
  });

  test("the next turn's ordinary handover sees the sibling's copy as the newest", () => {
    const b = box();
    run(b, { limitFor: "claw1" });
    // Same launch again, nothing refusing: claw1 is handed the sibling's copy,
    // which replaces the one carrying the refused attempt.
    const res = run(b, {});
    expect(res.status).toBe(0);
    const claw1 = readFileSync(b.claw1Transcript, "utf8");
    expect(claw1).not.toContain("<synthetic>");
    expect(claw1.startsWith(HISTORY)).toBe(true);
  });
});

describe("#24 every existing bound still holds", () => {
  test("delete the fix: with no roster the refusal is forwarded and the turn dies", () => {
    const b = box();
    const res = run(b, { limitFor: "claw1", roster: false });
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
    expect(existsSync(b.claw2Transcript)).toBe(false);
  });

  test("the handover cannot be written: the refusal is forwarded untouched", () => {
    const b = box();
    // The sibling's projects dir exists but refuses writes.
    mkdirSync(join(b.claw2Dir, "projects"), { recursive: true });
    chmodSync(join(b.claw2Dir, "projects"), 0o500);
    try {
      const res = run(b, { limitFor: "claw1" });
      expect(res.stdout).toContain("reached your");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("could not be handed to claw2");
      expect(res.stderr).not.toContain("retrying this turn");
      expect(records(res.stdout).filter((r) => r.type === "system")).toHaveLength(1);
    } finally {
      chmodSync(join(b.claw2Dir, "projects"), 0o700);
    }
  });

  test("a resumed session with no transcript here is not armed, and says why", () => {
    const b = box();
    // Not a pool launch as far as the shim can tell: no member dirs were named.
    const res = run(b, { limitFor: "claw1", sessionDirs: false });
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("in-turn retry unavailable");
    expect(res.stderr).toContain("resumed session");
  });

  test("still one retry: a sibling that also refuses ends the turn with its refusal", () => {
    const b = box();
    const env: NodeJS.ProcessEnv = {
      ...cleanShimEnv(),
      MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
      MULTI_CLAWD_STATE_FILE: b.claw1State,
      MULTI_CLAWD_ACCOUNT_ID: "claw1",
      CLAUDE_CONFIG_DIR: b.claw1Dir,
      FAKE_CLAUDE_EMULATE_RESUME: "1",
      FAKE_CLAUDE_WRITE_TRANSCRIPT: "1",
      FAKE_CLAUDE_EMIT_LIMIT: "1",
      FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
      FAKE_CLAUDE_EXIT: "1",
      [RETRY_ROSTER_ENV]: JSON.stringify([
        { id: "claw2", stateFile: b.claw2State, env: { CLAUDE_CONFIG_DIR: b.claw2Dir } },
      ]),
      [SESSION_DIRS_ENV]: JSON.stringify([b.claw1Dir, b.claw2Dir]),
    };
    const res = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS, "--resume", SESSION], {
      input: "the second question\n",
      encoding: "utf8",
      env,
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("reached your");
    expect((res.stderr.match(/retrying this turn/g) ?? []).length).toBe(1);
  });

  test("a fresh launch retries exactly as before", () => {
    const b = box();
    const res = run(b, { limitFor: "claw1", args: STREAM_ARGS });
    expect(res.status).toBe(0);
    expect(records(res.stdout).find((r) => r.type === "result")?.served_by).toBe("claw2");
    expect(existsSync(b.claw2Transcript)).toBe(false);
  });
});

describe("#24 arming", () => {
  const roster = [{ id: "claw2", stateFile: "claw2.json", env: {} }];

  test("a resumed launch is armed only when its transcript can be handed over", () => {
    const argv = [...STREAM_ARGS, "--resume", SESSION];
    expect(retryArming(argv, roster, { resumeReady: true }).armed).toBe(true);
    const unready = retryArming(argv, roster, { resumeReady: false });
    expect(unready.armed).toBe(false);
    expect(unready.reason).toContain("resumed session");
    // Callers that say nothing keep the old, safe answer.
    expect(retryArming(argv, roster).armed).toBe(false);
  });

  test("every spelling of resume is recognised", () => {
    for (const argv of [
      [...STREAM_ARGS, "--resume", SESSION],
      [...STREAM_ARGS, `--resume=${SESSION}`],
      [...STREAM_ARGS, "-r", SESSION],
    ]) {
      expect(retryArming(argv, roster).armed).toBe(false);
      expect(retryArming(argv, roster, { resumeReady: true }).armed).toBe(true);
    }
  });
});

describe("#24 snapshot and prefix handover", () => {
  test("the snapshot pins the transcript's length at the moment it is taken", () => {
    const b = box();
    const snap = snapshotResumeTranscript(["--resume", SESSION], { CLAUDE_CONFIG_DIR: b.claw1Dir });
    expect(snap?.bytes).toBe(Buffer.byteLength(HISTORY));
    expect(snap?.sub).toBe(SLUG);
  });

  test("a fresh launch, an absent transcript, or a hostile id yields no snapshot", () => {
    const b = box();
    const env = { CLAUDE_CONFIG_DIR: b.claw1Dir };
    expect(snapshotResumeTranscript(STREAM_ARGS, env)).toBeUndefined();
    expect(snapshotResumeTranscript(["--resume", "11111111-0000-0000-0000-000000000000"], env)).toBeUndefined();
    expect(snapshotResumeTranscript(["--resume", "../../etc/passwd"], env)).toBeUndefined();
  });

  test("only the snapshotted prefix is copied, however much was appended since", () => {
    const b = box();
    const snap = snapshotResumeTranscript(["--resume", SESSION], { CLAUDE_CONFIG_DIR: b.claw1Dir })!;
    writeFileSync(b.claw1Transcript, HISTORY + '{"type":"user","late":true}\n');
    handoverSnapshotTo(snap, b.claw2Dir);
    expect(readFileSync(b.claw2Transcript, "utf8")).toBe(HISTORY);
  });

  test("a transcript that shrank or no longer ends on a record boundary is refused", () => {
    const b = box();
    const snap = snapshotResumeTranscript(["--resume", SESSION], { CLAUDE_CONFIG_DIR: b.claw1Dir })!;
    writeFileSync(b.claw1Transcript, HISTORY.slice(0, 10));
    expect(() => handoverSnapshotTo(snap, b.claw2Dir)).toThrow();
    expect(existsSync(b.claw2Transcript)).toBe(false);
    // Rewritten in place to the same length, but the boundary has moved.
    writeFileSync(b.claw1Transcript, "x".repeat(Buffer.byteLength(HISTORY)));
    expect(() => handoverSnapshotTo(snap, b.claw2Dir)).toThrow();
    expect(existsSync(b.claw2Transcript)).toBe(false);
  });

  test("a snapshot that does not end on a record boundary is never taken", () => {
    const b = box();
    writeFileSync(b.claw1Transcript, '{"type":"user"');
    expect(
      snapshotResumeTranscript(["--resume", SESSION], { CLAUDE_CONFIG_DIR: b.claw1Dir }),
    ).toBeUndefined();
  });
});
