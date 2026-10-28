import { beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createForwardWriter,
  LIMIT_PASSTHROUGH_MARKER,
  markForwardedLimitLine,
} from "../src/shim-core";
import { RETRY_ROSTER_ENV } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";

// #97: a model limit the shim forwards without retrying must classify as a
// rate limit under the host's STOCK failover patterns, so the host moves the
// turn to the next model instead of ending it.

// ── fixture: the host's stock rate-limit patterns ───────────────────────────
// Copied verbatim from OpenClaw 2026.10.8, dist/message-patterns-*.mjs,
// `ERROR_PATTERNS.rateLimit` (source: src/agents/failover/message-patterns.ts).
// Stock only: nothing here matches "reached your … limit", which is the bug.
const STOCK_RATE_LIMIT_PATTERNS: ReadonlyArray<string | RegExp> = [
  /rate[_ ]limit|too many requests/i,
  /^\s*429\b|\b(?:https?|status(?:[ _-]?code)?|response(?:[ _-]?code)?|http(?:[ _-]?status)?)\b[\s:=#"'(]{0,6}429\b|["'](?:status|code)["']\s*:\s*429\b|\b429\b[\s:)\].,-]*(?:rate[_ -]?limit(?:ed|ing)?|too many requests|resource has been exhausted|quota(?:\s+(?:exceeded|exhausted|depleted|reached))?)\b/i,
  /too many (?:concurrent )?requests/i,
  /\bthrottl(?:ing[_]?exception|ing|ed)\b/i,
  /\bconcurrency limit\b.*\b(?:breached|reached)\b/i,
  "model_cooldown",
  "exceeded your current quota",
  /\bresource[_ -]?exhausted\b/i,
  /\bquota[_ -]?exceeded\b/i,
  "usage limit",
  /\btpm\b/i,
  "tokens per minute",
  "tokens per day",
  "请求过于频繁",
  "调用频率",
  "频率限制",
  "配额不足",
  "配额已用尽",
  "额度不足",
  "额度已用尽",
];

/** OpenClaw 2026.10.8 `matchesErrorPatterns`: trim + lowercase, then test/includes. */
function stockIsRateLimit(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return false;
  return STOCK_RATE_LIMIT_PATTERNS.some((p) => (p instanceof RegExp ? p.test(value) : value.includes(p)));
}

/**
 * The text the host classifies for a terminal error result: OpenClaw
 * 2026.10.8 `collectExplicitCliErrorText` field order (first non-diagnostic
 * `errors` entry, else `result`, else the nested error message).
 */
function hostErrorText(record: Record<string, unknown>): string {
  if (Array.isArray(record.errors)) {
    for (const e of record.errors) {
      const t = typeof e === "string" ? e.trim() : "";
      if (t && !t.startsWith("[ede_diagnostic]")) return t;
    }
  }
  if (typeof record.result === "string" && record.result.trim()) return record.result.trim();
  const err = record.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return ((err as { message: string }).message).trim();
  }
  return typeof err === "string" ? err.trim() : "";
}

const LIMIT_TEXT = "You've reached your Fable 5 limit. /model to switch models.";
const limitResult = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    api_error_status: 429,
    result: LIMIT_TEXT,
    session_id: "s1",
    ...extra,
  });

describe("fixture sanity", () => {
  test("the stock patterns do NOT match the CLI's limit wording (the bug as filed)", () => {
    expect(stockIsRateLimit(LIMIT_TEXT)).toBe(false);
    expect(STOCK_RATE_LIMIT_PATTERNS).not.toContain("reached your");
  });

  test("the stock patterns DO match the marked wording", () => {
    expect(stockIsRateLimit(`${LIMIT_TEXT}${LIMIT_PASSTHROUGH_MARKER}`)).toBe(true);
  });
});

describe("markForwardedLimitLine", () => {
  test("marks a terminal limit result and keeps the CLI's wording first", () => {
    const out = markForwardedLimitLine(limitResult());
    const record = JSON.parse(out);
    expect(record.result).toBe(`${LIMIT_TEXT}${LIMIT_PASSTHROUGH_MARKER}`);
    expect(hostErrorText(record).startsWith(LIMIT_TEXT)).toBe(true);
    expect(stockIsRateLimit(hostErrorText(record))).toBe(true);
    // Every other field survives.
    expect({ ...record, result: LIMIT_TEXT }).toEqual(JSON.parse(limitResult()));
  });

  test("marks the errors[] entry the host reads first when there is one", () => {
    const line = limitResult({ errors: ["[ede_diagnostic] trace", LIMIT_TEXT] });
    const record = JSON.parse(markForwardedLimitLine(line));
    expect(record.errors).toEqual(["[ede_diagnostic] trace", `${LIMIT_TEXT}${LIMIT_PASSTHROUGH_MARKER}`]);
    expect(stockIsRateLimit(hostErrorText(record))).toBe(true);
  });

  test("marks a result carrying the typed usage_limit_reached marker whatever its wording", () => {
    const line = limitResult({ result: "Some future limit wording.", api_error: "usage_limit_reached" });
    const record = JSON.parse(markForwardedLimitLine(line));
    expect(stockIsRateLimit(hostErrorText(record))).toBe(true);
    expect(record.result.startsWith("Some future limit wording.")).toBe(true);
  });

  test("is idempotent", () => {
    const once = markForwardedLimitLine(limitResult());
    expect(markForwardedLimitLine(once)).toBe(once);
  });

  test("non-limit errors come back as the very same string", () => {
    for (const line of [
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 529,
        result: "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.",
      }),
      "not json at all",
      "",
    ]) {
      expect(markForwardedLimitLine(line)).toBe(line);
    }
  });

  test("successful results quoting limit text, and the synthetic notice, are untouched", () => {
    const quoting = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: LIMIT_TEXT });
    expect(markForwardedLimitLine(quoting)).toBe(quoting);
    // The CLI's <synthetic> assistant notice IS a limit to parseModelLimitError,
    // but it is not the terminal record the host classifies: never rewritten.
    const synthetic = JSON.stringify({
      type: "assistant",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: LIMIT_TEXT }] },
      error: "rate_limit",
      is_api_error_message: true,
      api_error_status: 429,
      api_error: "usage_limit_reached",
    });
    expect(markForwardedLimitLine(synthetic)).toBe(synthetic);
    // A `type: "error"` record is not a terminal result either.
    const errorRecord = JSON.stringify({ type: "error", error: { message: LIMIT_TEXT } });
    expect(markForwardedLimitLine(errorRecord)).toBe(errorRecord);
  });
});

describe("createForwardWriter", () => {
  function run(chunks: Buffer[]): { out: Buffer; writes: Buffer[]; marks: number } {
    const writes: Buffer[] = [];
    let marks = 0;
    const w = createForwardWriter((b) => writes.push(Buffer.from(b)), () => marks++);
    for (const c of chunks) w.push(c);
    w.flush();
    return { out: Buffer.concat(writes), writes, marks };
  }

  /** Every way of cutting `bytes` into two chunks, plus one-byte chunks. */
  function chunkings(bytes: Buffer): Buffer[][] {
    const all: Buffer[][] = [[bytes]];
    for (let i = 1; i < bytes.length; i++) all.push([bytes.subarray(0, i), bytes.subarray(i)]);
    all.push([...bytes].map((b) => Buffer.from([b])));
    return all;
  }

  const SUCCESS_STREAM = Buffer.from(
    [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: "s1" }),
      // Multi-byte UTF-8 so cuts land inside characters.
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "héllo — 🐾 " + LIMIT_TEXT }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done 🐾 " + LIMIT_TEXT }),
    ].join("\n") + "\n",
    "utf8",
  );

  test("a successful stream is byte-identical however it is chunked", () => {
    for (const chunks of chunkings(SUCCESS_STREAM)) {
      const { out, marks } = run(chunks);
      expect(out.equals(SUCCESS_STREAM)).toBe(true);
      expect(marks).toBe(0);
    }
  });

  test("a non-limit error stream is byte-identical however it is chunked", () => {
    const stream = Buffer.from(
      '{"type":"system","subtype":"init"}\n' +
        JSON.stringify({ type: "result", is_error: true, result: "boom — not a limit" }) +
        "\n",
      "utf8",
    );
    for (const chunks of chunkings(stream)) {
      const { out, marks } = run(chunks);
      expect(out.equals(stream)).toBe(true);
      expect(marks).toBe(0);
    }
  });

  test("non-result lines are forwarded as they arrive, before their newline", () => {
    const writes: Buffer[] = [];
    const w = createForwardWriter((b) => writes.push(Buffer.from(b)));
    const assistant = '{"type":"assistant","message":{"content":[{"type":"text","text":"partial';
    w.push(Buffer.from(assistant, "utf8"));
    expect(Buffer.concat(writes).toString("utf8")).toBe(assistant);
  });

  test("a terminal limit result is marked however it is chunked", () => {
    const stream = Buffer.from('{"type":"system","subtype":"init"}\n' + limitResult() + "\n", "utf8");
    for (const chunks of chunkings(stream)) {
      const { out, marks } = run(chunks);
      const lines = out.toString("utf8").split("\n");
      expect(lines[0]).toBe('{"type":"system","subtype":"init"}');
      const record = JSON.parse(lines[1]);
      expect(stockIsRateLimit(hostErrorText(record))).toBe(true);
      expect(lines[2]).toBe("");
      expect(marks).toBe(1);
    }
  });

  test("an unterminated final limit result is marked on flush", () => {
    const { out, marks } = run([Buffer.from(limitResult(), "utf8")]);
    expect(stockIsRateLimit(hostErrorText(JSON.parse(out.toString("utf8"))))).toBe(true);
    expect(marks).toBe(1);
  });
});

// ── the compiled shim, end to end ──────────────────────────────────────────
const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

beforeAll(() => {
  expect(existsSync(SHIM)).toBe(true);
});

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "mc-97-"));
  return {
    ...cleanShimEnv(),
    MULTI_CLAWD_STATE_FILE: join(dir, "claw1.json"),
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    FAKE_CLAUDE_EXIT: "0",
    ...extra,
  };
}

function viaShim(env: NodeJS.ProcessEnv, input = "the prompt\n") {
  return spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], {
    input,
    env: { ...env, MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]) },
  });
}

/** The same fake CLI with no shim in front: the bytes the host would get today. */
function direct(env: NodeJS.ProcessEnv, input = "the prompt\n") {
  return spawnSync(process.execPath, [FAKE, ...STREAM_ARGS], { input, env });
}

function resultRecord(stdout: Buffer): Record<string, unknown> {
  const lines = stdout.toString("utf8").trim().split("\n");
  const record = lines.map((l) => JSON.parse(l)).find((r) => r.type === "result");
  expect(record).toBeTruthy();
  return record as Record<string, unknown>;
}

function limitedSiblingRoster(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-97-s2-"));
  const claw2State = join(dir, "claw2.json");
  writeFileSync(
    claw2State,
    JSON.stringify({
      accountId: "claw2",
      windows: { "model:claude-fable-5-1": { status: "rejected", seenAt: Date.now() } },
    }),
  );
  return JSON.stringify([{ id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-two" } }]);
}

function idleSiblingRoster(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-97-s2-"));
  return JSON.stringify([
    { id: "claw2", stateFile: join(dir, "claw2.json"), env: { CLAUDE_CONFIG_DIR: "/tmp/claude-two" } },
  ]);
}

describe("shim: a forwarded model limit classifies as a rate limit (#97)", () => {
  test("no healthy sibling: the forwarded limit matches the stock patterns, wording kept", () => {
    const env = baseEnv({ FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1", [RETRY_ROSTER_ENV]: limitedSiblingRoster() });
    const res = viaShim(env);
    expect(res.stderr.toString()).toContain("no healthy sibling");
    expect(res.stderr.toString()).toContain("forwarded to the host marked as a rate limit");
    const text = hostErrorText(resultRecord(res.stdout));
    expect(text.startsWith(LIMIT_TEXT)).toBe(true);
    expect(stockIsRateLimit(text)).toBe(true);
    expect(res.status).toBe(1); // the exit code still passes through
    // Only the result record differs from what the CLI wrote.
    const plain = direct(env);
    const shimLines = res.stdout.toString("utf8").split("\n");
    const plainLines = plain.stdout.toString("utf8").split("\n");
    expect(shimLines).toHaveLength(plainLines.length);
    const differing = shimLines.flatMap((l, i) => (l === plainLines[i] ? [] : [i]));
    expect(differing).toHaveLength(1);
    expect(JSON.parse(plainLines[differing[0]]).type).toBe("result");
    expect(stockIsRateLimit(hostErrorText(JSON.parse(plainLines[differing[0]])))).toBe(false);
  });

  test("no healthy sibling, typed CLI shape: the result is marked, the synthetic notice is not", () => {
    const env = baseEnv({
      FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
      FAKE_CLAUDE_LIMIT_SHAPE: "typed",
      [RETRY_ROSTER_ENV]: limitedSiblingRoster(),
    });
    const res = viaShim(env);
    const plain = direct(env);
    const shimLines = res.stdout.toString("utf8").trim().split("\n");
    const plainLines = plain.stdout.toString("utf8").trim().split("\n");
    const syntheticIdx = plainLines.findIndex((l) => l.includes("<synthetic>"));
    expect(syntheticIdx).toBeGreaterThanOrEqual(0);
    expect(shimLines[syntheticIdx]).toBe(plainLines[syntheticIdx]);
    expect(stockIsRateLimit(hostErrorText(resultRecord(res.stdout)))).toBe(true);
  });

  test("no roster at all (never retry-eligible): the forwarded limit is marked", () => {
    const res = viaShim(baseEnv({ FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1" }));
    expect(stockIsRateLimit(hostErrorText(resultRecord(res.stdout)))).toBe(true);
    expect(res.status).toBe(1);
  });

  test("retry window closed: a limit arriving after the window is marked", () => {
    const res = viaShim(
      baseEnv({
        FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
        FAKE_CLAUDE_LIMIT_DELAY_MS: "600",
        MULTI_CLAWD_HOLD_MAX_MS: "150",
        [RETRY_ROSTER_ENV]: idleSiblingRoster(),
      }),
    );
    expect(res.stderr.toString()).toContain("retry window closed");
    expect(res.stderr.toString()).not.toContain("retrying this turn");
    const text = hostErrorText(resultRecord(res.stdout));
    expect(text.startsWith(LIMIT_TEXT)).toBe(true);
    expect(stockIsRateLimit(text)).toBe(true);
    expect(res.status).toBe(1);
  });

  test("a limit after content was forwarded (late limit) is marked", () => {
    const res = viaShim(baseEnv({ FAKE_CLAUDE_EMIT_LIMIT: "1", [RETRY_ROSTER_ENV]: idleSiblingRoster() }));
    expect(res.stderr.toString()).not.toContain("retrying this turn");
    expect(stockIsRateLimit(hostErrorText(resultRecord(res.stdout)))).toBe(true);
  });

  test("non-limit errors are byte-identical to the CLI's own output", () => {
    for (const extra of [
      { FAKE_CLAUDE_EMIT_AUTH_FAIL: "1" },
      { FAKE_CLAUDE_TRANSIENT_FOR_ACCOUNT: "claw1" },
      { FAKE_CLAUDE_TRANSIENT_FOR_ACCOUNT: "claw1", FAKE_CLAUDE_TRANSIENT_KIND: "rate_limit_transient" },
    ]) {
      const env = baseEnv(extra);
      const res = viaShim(env);
      const plain = direct(env);
      expect(res.stdout.equals(plain.stdout)).toBe(true);
      expect(res.status).toBe(plain.status);
      expect(res.stderr.toString()).not.toContain("marked as a rate limit");
    }
  });

  test("a successful result quoting limit text is byte-identical", () => {
    const env = baseEnv({});
    const prompt = `${LIMIT_TEXT} — 🐾 quoted, not hit\n`;
    const res = viaShim(env, prompt);
    const plain = direct(env, prompt);
    expect(res.stdout.equals(plain.stdout)).toBe(true);
    expect(resultRecord(res.stdout).result).toBe(prompt.trim());
    expect(res.status).toBe(0);
  });

  test("retry path unchanged: the retried limit never reaches the host and nothing is marked", () => {
    const res = viaShim(baseEnv({ FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1", [RETRY_ROSTER_ENV]: idleSiblingRoster() }));
    expect(res.stderr.toString()).toContain("retrying this turn on claw2");
    expect(res.stderr.toString()).not.toContain("marked as a rate limit");
    const out = res.stdout.toString("utf8");
    expect(out).not.toContain("reached your");
    expect(out).not.toContain(LIMIT_PASSTHROUGH_MARKER);
    const result = resultRecord(res.stdout);
    expect(result.served_by).toBe("claw2");
    expect(result.result).toBe("the prompt");
    expect(res.status).toBe(0);
  });

  test("the sibling a retry moved to refuses too: its forwarded limit is marked", () => {
    const res = viaShim(
      baseEnv({ FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1,claw2", [RETRY_ROSTER_ENV]: idleSiblingRoster() }),
    );
    expect(res.stderr.toString()).toContain("retrying this turn on claw2");
    const text = hostErrorText(resultRecord(res.stdout));
    expect(text.startsWith(LIMIT_TEXT)).toBe(true);
    expect(stockIsRateLimit(text)).toBe(true);
    expect(res.status).toBe(1);
  });
});
