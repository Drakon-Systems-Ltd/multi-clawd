import { beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_ROSTER_ENV } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";

/**
 * #147 — the shim forwards its stdin into `child.stdin` with no error listener
 * on that socket. A CLI that gives up stdin before reading the prompt (a
 * refusal, a failed `--resume`, a startup crash) leaves the next forwarded
 * chunk to fail with EPIPE, and Node turns the unlistened 'error' into an
 * uncaught exception: the SHIM dies with a stack trace before its close
 * handler can hop the turn to a sibling or hand the CLI's exit code on.
 *
 * Under CI load this is the race behind the Node 22 red on PR #143 (run
 * 42499876336): the billing fixture refused and exited before the shim's event
 * loop forwarded "the prompt". These specs remove the scheduler from the
 * picture: the fixture closes its fd 0 BEFORE its notice and lingers after it,
 * and the prompt is written only once the shim has reported the notice. The
 * forward therefore meets a closed read end every time.
 */

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];
const MARKER = "billing refusal recorded for claw1";

beforeAll(() => {
  expect(existsSync(SHIM)).toBe(true);
});

function baseEnv(opts: { roster: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "mc-147-"));
  const claw1State = join(dir, "claw1.json");
  const claw2State = join(dir, "claw2.json");
  const env: NodeJS.ProcessEnv = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: claw1State,
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    FAKE_CLAUDE_EXIT: "0",
    FAKE_CLAUDE_BILLING_FOR_ACCOUNT: "claw1",
    FAKE_CLAUDE_CLOSE_STDIN_EARLY: "1",
  };
  if (opts.roster) {
    env[RETRY_ROSTER_ENV] = JSON.stringify([
      { id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: join(dir, "claude-two") } },
    ]);
  }
  return env;
}

/**
 * Run the shim, hand it the prompt only after it has reported the refusal
 * (so the child has already closed its stdin), and collect the outcome.
 */
function runLatePrompt(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const shim = spawn(process.execPath, [SHIM, ...STREAM_ARGS], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let sent = false;
    const timer = setTimeout(() => {
      shim.kill("SIGKILL");
      reject(new Error(`shim did not finish; stderr so far:\n${stderr}`));
    }, 15_000);
    shim.stdout.setEncoding("utf8");
    shim.stderr.setEncoding("utf8");
    shim.stdout.on("data", (chunk: string) => (stdout += chunk));
    shim.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (!sent && stderr.includes(MARKER)) {
        sent = true;
        // The child has written its notice, so its fd 0 is already closed:
        // this forward cannot be delivered to it.
        shim.stdin.write("the prompt\n");
        shim.stdin.end();
      }
    });
    shim.on("error", reject);
    shim.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function records(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("stdin to a child that stopped reading never kills the shim (#147)", () => {
  test("armed: the refusal still hops to the sibling and the prompt is replayed there", async () => {
    const env = baseEnv({ roster: true });
    const out = await runLatePrompt(env);
    expect(out.stderr).toContain(MARKER);
    // The crash signature from CI run 42499876336.
    expect(out.stderr).not.toContain("EPIPE");
    expect(out.stderr).not.toContain("Unhandled 'error' event");
    expect(out.stderr).toContain("retrying this turn on claw2");
    const result = records(out.stdout).find((r) => r.type === "result");
    expect(result?.served_by).toBe("claw2");
    // The bytes the dead child never read reached the sibling intact.
    expect(result?.result).toBe("the prompt");
    expect(out.code).toBe(0);
  }, 20_000);

  test("not armed: the refusal is forwarded unchanged and the CLI's exit code is handed on", async () => {
    const env = baseEnv({ roster: false });
    const out = await runLatePrompt(env);
    expect(out.stderr).toContain(MARKER);
    expect(out.stderr).not.toContain("EPIPE");
    expect(out.stderr).not.toContain("Unhandled 'error' event");
    expect(out.stderr).not.toContain("retrying this turn");
    // Byte-for-byte what the fixture emits on its own: nothing swallowed.
    const direct = spawnSync(process.execPath, [FAKE, ...STREAM_ARGS], {
      input: "the prompt\n",
      encoding: "utf8",
      env: { ...env, FAKE_CLAUDE_CLOSE_STDIN_LINGER_MS: "0" },
    });
    expect(out.stdout).toBe(direct.stdout);
    expect(out.code).toBe(1);
  }, 20_000);
});
