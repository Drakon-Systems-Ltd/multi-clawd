import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");

function runShim(opts: {
  exit?: string;
  stateFile: string;
  rateLimitInfo?: Record<string, unknown>;
  modelOverride?: string;
  args?: string[];
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: opts.stateFile,
    MULTI_CLAWD_ACCOUNT_ID: "claw2",
    FAKE_CLAUDE_EXIT: opts.exit ?? "0",
  };
  if (opts.rateLimitInfo) {
    env.FAKE_CLAUDE_RATE_LIMIT_INFO = JSON.stringify(opts.rateLimitInfo);
  }
  if (opts.modelOverride) {
    env.MULTI_CLAWD_MODEL_OVERRIDE = opts.modelOverride;
  }
  return spawnSync(process.execPath, [SHIM, ...(opts.args ?? ["-p", "--output-format", "stream-json"])], {
    input: "the prompt\n",
    encoding: "utf8",
    env,
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

describe("shim model override (tier degradation)", () => {
  test("MULTI_CLAWD_MODEL_OVERRIDE rewrites the --model value the CLI receives", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const res = runShim({
      stateFile: join(dir, "claw2.json"),
      args: ["-p", "--model", "claude-fable-5", "--output-format", "stream-json"],
      modelOverride: "claude-opus-4-8",
    });
    const result = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.type === "result");
    expect(result.received_model).toBe("claude-opus-4-8");
    expect(res.stderr).toContain("degrading model");
  });

  test("without the override the requested model passes through untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const res = runShim({
      stateFile: join(dir, "claw2.json"),
      args: ["-p", "--model", "claude-fable-5", "--output-format", "stream-json"],
    });
    const result = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.type === "result");
    expect(result.received_model).toBe("claude-fable-5");
  });
});

describe("shim reactive model-limit capture (v0.3.6)", () => {
  test("a 429 limit error writes a model-scoped rejected window keyed by the argv model", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw1.json");
    const res = spawnSync(
      process.execPath,
      [SHIM, "-p", "--model", "claude-fable-5", "--output-format", "stream-json"],
      {
        input: "the prompt\n",
        encoding: "utf8",
        env: {
          ...process.env,
          MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
          MULTI_CLAWD_STATE_FILE: stateFile,
          MULTI_CLAWD_ACCOUNT_ID: "claw1",
          FAKE_CLAUDE_EXIT: "1",
          FAKE_CLAUDE_EMIT_LIMIT: "1",
        },
      },
    );
    expect(res.status).toBe(1); // exit code passthrough unchanged
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.windows["model:claude-fable-5"]).toMatchObject({ status: "rejected" });
    // the limit error stream still reached the parent untouched
    expect(res.stdout).toContain("reached your Fable 5 limit");
  });

  test("limit capture uses the EFFECTIVE model when degradation rewrote argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw1.json");
    spawnSync(
      process.execPath,
      [SHIM, "-p", "--model", "claude-fable-5", "--output-format", "stream-json"],
      {
        input: "x\n",
        encoding: "utf8",
        env: {
          ...process.env,
          MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
          MULTI_CLAWD_STATE_FILE: stateFile,
          MULTI_CLAWD_ACCOUNT_ID: "claw1",
          FAKE_CLAUDE_EMIT_LIMIT: "1",
          MULTI_CLAWD_MODEL_OVERRIDE: "claude-opus-4-8",
        },
      },
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.windows["model:claude-opus-4-8"]).toMatchObject({ status: "rejected" });
    expect(state.windows["model:claude-fable-5"]).toBeUndefined();
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

  test("windows persist across invocations: a five_hour-only turn keeps seven_day", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    // First invocation: only a seven_day event with high utilization.
    runShim({
      stateFile,
      rateLimitInfo: {
        status: "allowed_warning",
        resetsAt: 1785000000,
        rateLimitType: "seven_day",
        utilization: 0.9,
        isUsingOverage: false,
      },
    });
    // Second invocation: only the default five_hour event.
    runShim({ stateFile });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    // Regression for the wholesale-replace bug: seven_day must survive.
    expect(state.windows.seven_day).toMatchObject({ utilization: 0.9, resetsAt: 1785000000 });
    expect(state.windows.five_hour).toMatchObject({ utilization: 0.87 });
    expect(state.windows.five_hour.seenAt).toBeGreaterThanOrEqual(state.windows.seven_day.seenAt);
  });

  test("newer observation of the same window wins across invocations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    runShim({
      stateFile,
      rateLimitInfo: { status: "allowed", rateLimitType: "seven_day", utilization: 0.5 },
    });
    runShim({
      stateFile,
      rateLimitInfo: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86 },
    });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.windows.seven_day).toMatchObject({
      status: "allowed_warning",
      utilization: 0.86,
    });
  });

  test("a corrupt existing state file is replaced, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    writeFileSync(stateFile, "{not json");
    const res = runShim({ stateFile });
    expect(res.status).toBe(0);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.windows.five_hour).toMatchObject({ utilization: 0.87 });
  });

  test("still exits cleanly when the state file is unwritable", () => {
    const res = runShim({ stateFile: "/nonexistent-dir/deep/claw2.json" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"type":"result"');
  });
});

describe("shim corrupt-state preservation (seven_day disappearance autopsy)", () => {
  test("a corrupt state file is preserved to a .corrupt-* sidecar and noted on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    const badBytes = '{"windows": {"seven_day": {"utilization": 0.95, WRECKED';
    writeFileSync(stateFile, badBytes);

    const res = runShim({ stateFile });
    expect(res.status).toBe(0);

    // Fresh state took over (the live turn was never broken by the bad file).
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.windows.five_hour).toMatchObject({ utilization: 0.87 });

    // The original bytes survive in a sidecar for autopsy.
    const sidecars = readdirSync(dir).filter(
      (f) => f.startsWith("claw2.json.corrupt-"),
    );
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(dir, sidecars[0]), "utf8")).toBe(badBytes);

    // Operator gets a trace instead of a silent erase.
    expect(res.stderr).toContain("state file unreadable/corrupt — starting fresh (preserved copy:");
  });

  test("a missing state file starts fresh silently — no sidecar, no stderr noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-shim-"));
    const stateFile = join(dir, "claw2.json");
    // File genuinely absent (ENOENT), not corrupt.
    const res = runShim({ stateFile });
    expect(res.status).toBe(0);

    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toHaveLength(0);
    expect(res.stderr).not.toContain("unreadable/corrupt");
  });
});
