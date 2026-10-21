import { beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseApiRetryNotice,
  parseModelLimitError,
  parseTransientApiError,
} from "../src/shim-core";
import { chooseRetryAccount, RETRY_ROSTER_ENV } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";

/**
 * #68 — a provider-side TRANSIENT (529 overload, 5xx, throttle 429) is told
 * apart from a spent window and given the same single in-turn hop, without
 * recording anything against the account that met it.
 *
 * Evidence basis for the record shapes (no live calls were made): the
 * stream-json writer of the public @anthropic-ai/claude-code package, 2.1.306
 * build — `assistant` records flagged `is_api_error_message` with a top-level
 * `error` kind ("overloaded" | "server_error" | "rate_limit" | …) and
 * `api_error_status`; `result` records with `is_error` and `api_error_status`;
 * `system`/`api_retry` records with `retry_delay_ms`; and the message
 * wordings "Repeated 529 Overloaded errors", "This is a server-side issue,
 * usually temporary", "Server is temporarily limiting requests (not your usage
 * limit)" and "Request rejected (429)". The fixture lines are assembled from
 * that source, not captured from a failing request.
 */

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

const OVERLOADED_TEXT =
  "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.";
const SERVER_TEXT =
  "API Error: Internal server error. This is a server-side issue, usually temporary — try again in a moment.";
const THROTTLE_TEXT =
  "API Error: Server is temporarily limiting requests (not your usage limit) · this may be a temporary capacity issue.";
const LIMIT_TEXT = "You've reached your Fable 5 limit. /model to switch models.";

function synthetic(extra: Record<string, unknown>, text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
    is_api_error_message: true,
    session_id: "s1",
    ...extra,
  });
}

function errorResult(extra: Record<string, unknown>, text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: text,
    session_id: "s1",
    ...extra,
  });
}

describe("parseTransientApiError (#68)", () => {
  test("529 overload: by status, by CLI kind, and by wording alone", () => {
    expect(parseTransientApiError(synthetic({ api_error_status: 529, error: "server_error" }, OVERLOADED_TEXT)))
      .toMatchObject({ kind: "overloaded", status: 529 });
    expect(parseTransientApiError(synthetic({ error: "overloaded" }, "API Error: 529"))).toMatchObject({
      kind: "overloaded",
    });
    expect(parseTransientApiError(errorResult({}, OVERLOADED_TEXT))).toMatchObject({ kind: "overloaded" });
    expect(parseTransientApiError(errorResult({ api_error_status: 529 }, OVERLOADED_TEXT))).toMatchObject({
      kind: "overloaded",
      status: 529,
    });
  });

  test("5xx server error: by status, by CLI kind, and by wording", () => {
    expect(parseTransientApiError(synthetic({ api_error_status: 500, error: "server_error" }, SERVER_TEXT)))
      .toMatchObject({ kind: "server_error", status: 500 });
    expect(parseTransientApiError(errorResult({ api_error_status: 504 }, "API Error: timeout"))).toMatchObject({
      kind: "server_error",
      status: 504,
    });
    expect(parseTransientApiError(errorResult({}, SERVER_TEXT))).toMatchObject({ kind: "server_error" });
  });

  test("throttle 429 (not a spent window) is transient", () => {
    expect(parseTransientApiError(synthetic({ api_error_status: 429, error: "rate_limit" }, THROTTLE_TEXT)))
      .toMatchObject({ kind: "rate_limit_transient", status: 429 });
    expect(
      parseTransientApiError(errorResult({ api_error_status: 429 }, "API Error: Request rejected (429) · slow down")),
    ).toMatchObject({ kind: "rate_limit_transient" });
    // A bare 429 status with unrecognised text is still a throttle: the
    // spent-window wording is what would have made it a limit.
    expect(parseTransientApiError(errorResult({ api_error_status: 429 }, "API Error: nope"))).toMatchObject({
      kind: "rate_limit_transient",
    });
  });

  test("a spent window is NEVER transient, in any shape", () => {
    expect(parseTransientApiError(errorResult({ api_error_status: 429 }, LIMIT_TEXT))).toBeUndefined();
    expect(
      parseTransientApiError(
        synthetic({ api_error_status: 429, error: "rate_limit", api_error: "usage_limit_reached" }, LIMIT_TEXT),
      ),
    ).toBeUndefined();
    // Typed kind alone (text may change between CLI versions) still wins.
    expect(
      parseTransientApiError(synthetic({ api_error_status: 429, api_error: "usage_limit_reached" }, "API Error: x")),
    ).toBeUndefined();
    // And the limit parser still owns it.
    expect(parseModelLimitError(errorResult({ api_error_status: 429 }, LIMIT_TEXT))).toEqual({ displayName: "Fable 5" });
  });

  test("auth failures and non-error records are never transient", () => {
    expect(
      parseTransientApiError(
        errorResult({ api_error_status: 401 }, "Failed to authenticate: OAuth session expired and could not be refreshed"),
      ),
    ).toBeUndefined();
    expect(
      parseTransientApiError(synthetic({ api_error_status: 401, error: "authentication_failed" }, "Please run /login")),
    ).toBeUndefined();
    // A bare "rate_limit" kind with no status and no recognised wording is
    // left alone — the CLI uses that kind for several unrelated things.
    expect(parseTransientApiError(synthetic({ error: "rate_limit" }, "API Error: something"))).toBeUndefined();
    // A successful result QUOTING transient text must not trigger.
    expect(
      parseTransientApiError(JSON.stringify({ type: "result", is_error: false, result: OVERLOADED_TEXT })),
    ).toBeUndefined();
    // Ordinary assistant content mentioning an overload is model output.
    expect(
      parseTransientApiError(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: OVERLOADED_TEXT }] } }),
      ),
    ).toBeUndefined();
    expect(parseTransientApiError("not json")).toBeUndefined();
    expect(parseTransientApiError('{"type":"system","subtype":"init"}')).toBeUndefined();
  });
});

describe("parseApiRetryNotice (#68)", () => {
  test("reads the CLI's retry sleep and ignores everything else", () => {
    expect(
      parseApiRetryNotice(
        JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2500, error: "overloaded" }),
      ),
    ).toEqual({ retryDelayMs: 2500 });
    expect(parseApiRetryNotice(JSON.stringify({ type: "system", subtype: "api_retry" }))).toEqual({ retryDelayMs: 0 });
    expect(parseApiRetryNotice(JSON.stringify({ type: "system", subtype: "init" }))).toBeUndefined();
    expect(parseApiRetryNotice(JSON.stringify({ type: "assistant", subtype: "api_retry" }))).toBeUndefined();
    expect(parseApiRetryNotice("api_retry")).toBeUndefined();
  });
});

describe("chooseRetryAccount for a transient (#68)", () => {
  const NOW = 1_784_500_000_000;
  // Reset-bearing (so it is still binding, not aged out by the reset-less
  // TTL) and observed long enough ago to be overdue a re-probe.
  const rejectedLongAgo = {
    accountId: "claw2",
    windows: {
      "model:claude-fable-5-1": {
        status: "rejected" as const,
        seenAt: NOW - 48 * 3600 * 1000,
        resetsAt: NOW / 1000 + 4 * 24 * 3600,
      },
    },
  };
  const roster = [{ id: "claw2", stateFile: "/dev/null", env: {} }];

  test("a limit may fall back to an overdue-probe sibling; a transient may not", () => {
    const params = { roster, readState: () => rejectedLongAgo, modelId: "claude-fable-5-1", nowMs: NOW };
    expect(chooseRetryAccount(params)?.id).toBe("claw2");
    expect(chooseRetryAccount({ ...params, allowOverdueProbe: false })).toBeUndefined();
  });

  test("an idle sibling takes the hop either way", () => {
    const params = { roster, readState: () => undefined, modelId: "claude-fable-5-1", nowMs: NOW };
    expect(chooseRetryAccount({ ...params, allowOverdueProbe: false })?.id).toBe("claw2");
  });
});

// ── integration: the compiled shim against the fixture CLI ──────────────────

beforeAll(() => {
  expect(existsSync(SHIM)).toBe(true);
});

function scenario(opts: {
  roster?: Array<{ id: string; stateFile: string; env: Record<string, string> }>;
  kind?: string;
  retryDelayMs?: number;
  holdMaxMs?: number;
  transientFor?: string;
  extraEnv?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-68-"));
  const claw1State = join(dir, "claw1.json");
  const claw2State = join(dir, "claw2.json");
  const env: NodeJS.ProcessEnv = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: claw1State,
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    FAKE_CLAUDE_EXIT: "0",
    FAKE_CLAUDE_TRANSIENT_FOR_ACCOUNT: opts.transientFor ?? "claw1",
  };
  if (opts.kind) env.FAKE_CLAUDE_TRANSIENT_KIND = opts.kind;
  if (opts.retryDelayMs) env.FAKE_CLAUDE_TRANSIENT_RETRY_DELAY_MS = String(opts.retryDelayMs);
  if (opts.holdMaxMs) env.MULTI_CLAWD_HOLD_MAX_MS = String(opts.holdMaxMs);
  if (opts.roster) env[RETRY_ROSTER_ENV] = JSON.stringify(opts.roster);
  Object.assign(env, opts.extraEnv ?? {});
  const res = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], {
    input: "the prompt\n",
    encoding: "utf8",
    env,
  });
  return { res, claw1State, claw2State };
}

function rosterFor(claw2State: string) {
  return [{ id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-two" } }];
}

function records(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("in-turn hop on a transient provider error (#68)", () => {
  for (const kind of ["overloaded", "server_error", "rate_limit_transient"] as const) {
    test(`${kind}: the turn is served by the sibling, nothing is recorded against the first account`, () => {
      const { res, claw1State, claw2State } = scenario({ kind, roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-68s-")), "claw2.json")) });
      expect(res.stdout).not.toContain("API Error");
      const result = records(res.stdout).find((r) => r.type === "result");
      expect(result?.served_by).toBe("claw2");
      expect(result?.config_dir).toBe("/tmp/claude-two");
      expect(result?.result).toBe("the prompt");
      expect(records(res.stdout).filter((r) => r.type === "system")).toHaveLength(1);
      expect(res.status).toBe(0);
      expect(res.stderr).toContain("transient provider error");
      expect(res.stderr).toContain("retrying this turn on claw2");
      // The account that met the transient is NOT benched: no rejected
      // window for the model, and no state write at all for the failure.
      if (existsSync(claw1State)) {
        const state = JSON.parse(readFileSync(claw1State, "utf8"));
        expect(state.windows?.["model:claude-fable-5-1"]).toBeUndefined();
        expect(state.credential?.status).not.toBe("failed");
      }
      expect(claw2State).toBeTruthy();
    });
  }

  test("delete the fix: with no roster the transient is forwarded and the turn dies (the bug as filed)", () => {
    const { res, claw1State } = scenario({ kind: "overloaded" });
    expect(res.stdout).toContain("Repeated 529 Overloaded errors");
    expect(res.status).toBe(1);
    // Even so, nothing was recorded against the account — it is not spent.
    if (existsSync(claw1State)) {
      const state = JSON.parse(readFileSync(claw1State, "utf8"));
      expect(state.windows?.["model:claude-fable-5-1"]).toBeUndefined();
    }
  });

  test("a throttle with no idle sibling is passed through, not hopped onto a spent one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-68s-"));
    const claw2State = join(dir, "claw2.json");
    // Sibling still rejected (reset in the future) but observed long enough
    // ago that a LIMIT would take it as an overdue probe (#26); a transient
    // must not.
    writeFileSync(
      claw2State,
      JSON.stringify({
        accountId: "claw2",
        windows: {
          "model:claude-fable-5-1": {
            status: "rejected",
            seenAt: Date.now() - 48 * 3600 * 1000,
            resetsAt: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
          },
        },
      }),
    );
    const { res } = scenario({ kind: "rate_limit_transient", roster: rosterFor(claw2State) });
    expect(res.stdout).toContain("not your usage limit");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no healthy sibling");
    expect(res.stderr).not.toContain("retrying this turn");
  });

  test("the CLI's own api_retry notice keeps the hop armed past the base hold window", () => {
    // Base hold 300ms; the fixture announces a 900ms retry sleep first. Without
    // the extension the hold releases at 300ms and the error that follows is
    // forwarded; with it the hop still fires.
    const { res } = scenario({
      kind: "overloaded",
      retryDelayMs: 900,
      holdMaxMs: 300,
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-68s-")), "claw2.json")),
    });
    expect(res.stdout).not.toContain("API Error");
    expect(res.stderr).not.toContain("retry window closed");
    expect(records(res.stdout).find((r) => r.type === "result")?.served_by).toBe("claw2");
    // The failed attempt's api_retry notice is discarded with its preamble.
    expect(records(res.stdout).filter((r) => r.subtype === "api_retry")).toHaveLength(0);
  });

  test("the extension is bounded: a retry sleep beyond the ceiling releases the stream", () => {
    // Ceiling 400ms from launch, base hold 200ms, announced sleep 1500ms: the
    // hold may grow to the ceiling and no further, so the init record is
    // released and the error that follows is forwarded as before.
    const { res } = scenario({
      kind: "overloaded",
      retryDelayMs: 1500,
      holdMaxMs: 200,
      extraEnv: { MULTI_CLAWD_HOLD_RETRY_MAX_MS: "400" },
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-68s-")), "claw2.json")),
    });
    expect(res.stderr).toContain("retry window closed");
    expect(res.stdout).toContain("Repeated 529 Overloaded errors");
    expect(res.stderr).not.toContain("retrying this turn");
    expect(res.status).toBe(1);
  });

  test("one hop only: when the sibling meets a transient too, it is passed through", () => {
    // Transient on BOTH accounts: the hop lands on claw2, which fails the same
    // way; the retried child has an empty roster so its failure is forwarded
    // — and neither account is benched for it.
    const dir = mkdtempSync(join(tmpdir(), "mc-68s-"));
    const claw2State = join(dir, "claw2.json");
    const { res, claw1State } = scenario({
      kind: "overloaded",
      transientFor: "claw1,claw2",
      roster: rosterFor(claw2State),
    });
    expect((res.stderr.match(/retrying this turn/g) ?? []).length).toBe(1);
    expect(res.stderr).toContain("retrying this turn on claw2");
    expect(res.stdout).toContain("Repeated 529 Overloaded errors");
    expect(records(res.stdout).filter((r) => r.type === "system")).toHaveLength(1);
    expect(res.status).toBe(1);
    for (const file of [claw1State, claw2State]) {
      if (!existsSync(file)) continue;
      const state = JSON.parse(readFileSync(file, "utf8"));
      expect(state.windows?.["model:claude-fable-5-1"]).toBeUndefined();
    }
  });
});
