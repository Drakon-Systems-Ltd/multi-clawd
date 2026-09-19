import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_ROSTER_ENV } from "../src/retry-plan";

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  expect(existsSync(SHIM)).toBe(true);
});

function scenario(opts: {
  roster?: Array<{ id: string; stateFile: string; env: Record<string, string> }>;
  args?: string[];
  limitFor?: string;
  emitLimitLate?: boolean;
  limitDelayMs?: number;
  holdMaxMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-retry-"));
  const claw1State = join(dir, "claw1.json");
  const claw2State = join(dir, "claw2.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: claw1State,
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    FAKE_CLAUDE_EXIT: "0",
  };
  if (opts.limitFor) env.FAKE_CLAUDE_LIMIT_FOR_ACCOUNT = opts.limitFor;
  if (opts.limitDelayMs) env.FAKE_CLAUDE_LIMIT_DELAY_MS = String(opts.limitDelayMs);
  if (opts.holdMaxMs) env.MULTI_CLAWD_HOLD_MAX_MS = String(opts.holdMaxMs);
  if (opts.emitLimitLate) env.FAKE_CLAUDE_EMIT_LIMIT = "1";
  if (opts.roster) env[RETRY_ROSTER_ENV] = JSON.stringify(opts.roster);
  const res = spawnSync(process.execPath, [SHIM, ...(opts.args ?? STREAM_ARGS)], {
    input: "the prompt\n",
    encoding: "utf8",
    env,
  });
  return { res, dir, claw1State, claw2State };
}

function rosterFor(claw2State: string, configDir = "/tmp/claude-two") {
  return [{ id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: configDir } }];
}

function records(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("in-turn retry after a reactive model limit (#19)", () => {
  test("the turn is served by the sibling and the limit never reaches the user", () => {
    const { res, claw2State, claw1State } = scenario({
      limitFor: "claw1",
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-s2-")), "claw2.json")),
    });
    expect(res.stdout).not.toContain("reached your");
    const result = records(res.stdout).find((r) => r.type === "result");
    expect(result?.served_by).toBe("claw2");
    // The sibling's credential env decided the retry's identity.
    expect(result?.config_dir).toBe("/tmp/claude-two");
    // The user's prompt was replayed intact, not truncated or dropped.
    expect(result?.result).toBe("the prompt");
    // The failing account's preamble is discarded, so the stream the gateway
    // parses describes exactly one session.
    expect(records(res.stdout).filter((r) => r.type === "system")).toHaveLength(1);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("retrying this turn on claw2");
    // The limit is still recorded against the account that hit it.
    const state = JSON.parse(readFileSync(claw1State, "utf8"));
    expect(state.windows["model:claude-fable-5-1"].status).toBe("rejected");
    expect(claw2State).toBeTruthy();
  });

  test("delete the fix: with no roster the limit is forwarded and the turn dies", () => {
    // This is the bug as filed. If this ever starts passing silently, the
    // retry above is proving nothing.
    const { res } = scenario({ limitFor: "claw1" });
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
  });

  test("a resumed launch is never retried — its session lives in this account's config dir", () => {
    const { res } = scenario({
      limitFor: "claw1",
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-s2-")), "claw2.json")),
      args: [...STREAM_ARGS, "--resume", "sess-1"],
    });
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("resumed session");
  });

  test("once output has been forwarded the invariant holds and nothing is retried", () => {
    // The late-limit fixture emits assistant content first: bytes are on the
    // wire, so the error must pass through exactly as before.
    const { res } = scenario({
      emitLimitLate: true,
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-s2-")), "claw2.json")),
    });
    expect(res.stdout).toContain("reached your");
    expect(records(res.stdout).map((r) => r.type)).toEqual([
      "system",
      "rate_limit_event",
      "assistant",
      "result",
    ]);
    expect(res.stderr).not.toContain("retrying this turn");
  });

  test("a sibling already limited for this model is not retried onto", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-s2-"));
    const claw2State = join(dir, "claw2.json");
    writeFileSync(
      claw2State,
      JSON.stringify({
        accountId: "claw2",
        windows: {
          "model:claude-fable-5-1": { status: "rejected", seenAt: Date.now() },
        },
      }),
    );
    const { res } = scenario({ limitFor: "claw1", roster: rosterFor(claw2State) });
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no healthy sibling");
  });

  test("the hold window closes on time, and a late limit is passed through not swallowed", () => {
    // A CLI that sends its init record and then stalls must not have that
    // record sat on indefinitely. Once the window closes the shim is a plain
    // passthrough again — including for a limit that arrives afterwards.
    const { res } = scenario({
      limitFor: "claw1",
      limitDelayMs: 600,
      holdMaxMs: 150,
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-s2-")), "claw2.json")),
    });
    expect(res.stderr).toContain("retry window closed");
    expect(res.stdout).toContain("reached your");
    expect(res.status).toBe(1);
  });

  test("an armed launch that never hits a limit is byte-identical to an unarmed one", () => {
    // Holding the preamble must cost nothing when the retry never fires:
    // same records, same order, split record reassembled.
    const armed = scenario({ roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-s2-")), "c.json")) });
    const plain = scenario({});
    expect(armed.res.stdout).toBe(plain.res.stdout);
    expect(records(armed.res.stdout).map((r) => r.type)).toEqual([
      "system",
      "rate_limit_event",
      "assistant",
      "result",
    ]);
    expect(armed.res.status).toBe(0);
  });
});
