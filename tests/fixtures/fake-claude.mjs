import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Stand-in for the claude CLI in shim integration tests.
// Emits stream-json lines (one split across two writes), echoes one stdin
// line into an assistant record, and exits with FAKE_CLAUDE_EXIT.
// Resume emulation (opt-in): the real CLI resolves `--resume <id>` ONLY in its
// own config dir and fails before emitting anything else when it is absent.
let resumedTranscript;
if (process.env.FAKE_CLAUDE_EMULATE_RESUME === "1") {
  const idx = process.argv.indexOf("--resume");
  if (idx >= 0) {
    const id = process.argv[idx + 1];
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const projects = join(configDir, "projects");
    const found = existsSync(projects)
      && readdirSync(projects).some((sub) => existsSync(join(projects, sub, `${id}.jsonl`)));
    if (!found) {
      process.stderr.write(`No conversation found with session ID: ${id}\n`);
      process.exit(1);
    }
    // The real CLI appends the incoming user message to the resumed transcript
    // BEFORE the request is made — so a launch that is then refused has still
    // written to it (captured from live transcripts: the user record, then a
    // `<synthetic>` assistant record carrying the refusal).
    if (process.env.FAKE_CLAUDE_WRITE_TRANSCRIPT === "1") {
      const sub = readdirSync(projects).find((d) => existsSync(join(projects, d, `${id}.jsonl`)));
      resumedTranscript = join(projects, sub, `${id}.jsonl`);
      appendFileSync(
        resumedTranscript,
        JSON.stringify({ type: "user", by: process.env.MULTI_CLAWD_ACCOUNT_ID ?? null }) + "\n",
      );
    }
  }
}

// The refusal wording is the provider's and has changed between CLI versions
// (a version-scoped "Fable 5 limit", a family-wide "Fable limit"); tests that
// care which one they get say so.
const LIMIT_TEXT =
  process.env.FAKE_CLAUDE_LIMIT_TEXT ??
  "You've reached your Fable 5 limit. /model to switch models.";

// Opt-in: how this process was launched, for transport tests.
function launchReport() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--append-system-prompt-file");
  return {
    argv,
    system_prompt: idx >= 0 ? readFileSync(argv[idx + 1], "utf8") : null,
    via_wrapper: process.env.FAKE_VIA_WRAPPER ?? null,
    saw_claude_bin_env: "MULTI_CLAWD_CLAUDE_BIN" in process.env,
  };
}

const lines = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]},"session_id":"s1"}',
];
process.stdout.write(lines[0] + "\n");

// #19 retry path: emit the model-limit error IMMEDIATELY after the init
// record — the real shape of a hard cap, where nothing reaches the user
// before the refusal. Scoped to one account id so a test can prove the retry
// landed somewhere else.
const limitForAccount = process.env.FAKE_CLAUDE_LIMIT_FOR_ACCOUNT;
if (limitForAccount && limitForAccount === process.env.MULTI_CLAWD_ACCOUNT_ID) {
  // Optional stall first, to exercise the shim's hold-window timeout: top-level
  // await keeps the rest of this fixture from running, so the launch really is
  // "init record, then nothing".
  const delayMs = Number(process.env.FAKE_CLAUDE_LIMIT_DELAY_MS ?? "0");
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (resumedTranscript) {
    appendFileSync(
      resumedTranscript,
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT_TEXT }] },
      }) + "\n",
    );
  }
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: LIMIT_TEXT,
      session_id: "s1",
    }) + "\n",
  );
  process.exit(Number(process.env.FAKE_CLAUDE_LIMIT_EXIT ?? "1"));
}

// #68 transient path: a provider-side failure that survived the CLI's own
// retries, in the shape the real CLI's stream-json writer produces (field
// names and wordings taken from the @anthropic-ai/claude-code 2.1.306 build's
// serialiser: top-level `error` kind, `is_api_error_message`,
// `api_error_status`, a `<synthetic>` assistant record, then an `is_error`
// result carrying `api_error_status`). These lines are ASSEMBLED from that
// source, not captured from a live failing request — see the test file.
// Comma-separated account ids, so a test can make the sibling fail too.
const transientForAccounts = (process.env.FAKE_CLAUDE_TRANSIENT_FOR_ACCOUNT ?? "")
  .split(",")
  .filter(Boolean);
if (transientForAccounts.includes(process.env.MULTI_CLAWD_ACCOUNT_ID ?? "")) {
  const kind = process.env.FAKE_CLAUDE_TRANSIENT_KIND ?? "overloaded";
  const shapes = {
    overloaded: {
      error: "server_error",
      status: 529,
      text:
        "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
    },
    server_error: {
      error: "server_error",
      status: 500,
      text:
        "API Error: Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
    },
    rate_limit_transient: {
      error: "rate_limit",
      status: 429,
      text:
        "API Error: Server is temporarily limiting requests (not your usage limit) · this may be a temporary capacity issue.",
    },
  };
  const shape = shapes[kind] ?? shapes.overloaded;
  // Optional: the CLI's own retry notice, then the sleep it announces.
  const retryDelayMs = Number(process.env.FAKE_CLAUDE_TRANSIENT_RETRY_DELAY_MS ?? "0");
  if (retryDelayMs > 0) {
    process.stdout.write(
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: retryDelayMs,
        error_status: shape.status,
        error: shape.status === 529 ? "overloaded" : shape.error,
        session_id: "s1",
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: shape.text }] },
      error: shape.error,
      is_api_error_message: true,
      api_error_status: shape.status,
      session_id: "s1",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: shape.status,
      result: shape.text,
      session_id: "s1",
    }) + "\n",
  );
  process.exit(1);
}

// Tests may override the emitted rate-limit payload to simulate turns that
// carry a different window type (e.g. seven_day with utilization).
const rateLimitInfo = process.env.FAKE_CLAUDE_RATE_LIMIT_INFO
  ? JSON.parse(process.env.FAKE_CLAUDE_RATE_LIMIT_INFO)
  : {
      status: "allowed_warning",
      resetsAt: 1784595600,
      rateLimitType: "five_hour",
      utilization: 0.87,
      isUsingOverage: false,
    };
const rateLimitLine = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: rateLimitInfo,
  uuid: "u1",
  session_id: "s1",
});
// split mid-record to prove the shim's passthrough is not line-buffered
process.stdout.write(rateLimitLine.slice(0, 25));

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  process.stdout.write(rateLimitLine.slice(25) + "\n");
  process.stdout.write(lines[1] + "\n");
  const modelIdx = process.argv.indexOf("--model");
  const emitLimit = process.env.FAKE_CLAUDE_EMIT_LIMIT === "1";
  // The live #8 shape: HTTP 410 session_expired as the CLI reports it.
  const emitAuthFail = process.env.FAKE_CLAUDE_EMIT_AUTH_FAIL === "1";
  // "not_logged_in" replays cli-not-logged-in.jsonl instead — records captured
  // from the real CLI (2.1.224) against an empty config dir, so the reactive
  // auth path is exercised against bytes nobody hand-wrote.
  if (process.env.FAKE_CLAUDE_EMIT_AUTH_FAIL === "not_logged_in") {
    const fixture = new URL("./cli-not-logged-in.jsonl", import.meta.url);
    process.stdout.write(readFileSync(fixture, "utf8"));
    process.stderr.write("fake-claude stderr noise\n");
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
  }
  process.stdout.write(
    JSON.stringify(
      emitAuthFail
        ? {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "Failed to authenticate: OAuth session expired and could not be refreshed",
            received_model: modelIdx >= 0 ? process.argv[modelIdx + 1] : null,
            session_id: "s1",
          }
        : emitLimit
        ? {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: LIMIT_TEXT,
            received_model: modelIdx >= 0 ? process.argv[modelIdx + 1] : null,
            session_id: "s1",
          }
        : (resumedTranscript &&
            appendFileSync(
              resumedTranscript,
              JSON.stringify({ type: "assistant", by: process.env.MULTI_CLAWD_ACCOUNT_ID ?? null }) + "\n",
            ),
          {
            type: "result",
            result: stdin.trim(),
            received_model: modelIdx >= 0 ? process.argv[modelIdx + 1] : null,
            served_by: process.env.MULTI_CLAWD_ACCOUNT_ID ?? null,
            config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
            // Never the value: whether a token arrived, and whether it is the
            // one the test expected.
            has_oauth_token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
            saw_retry_roster: Boolean(process.env.MULTI_CLAWD_RETRY_ACCOUNTS),
            oauth_token_matches: process.env.FAKE_CLAUDE_EXPECT_TOKEN
              ? process.env.CLAUDE_CODE_OAUTH_TOKEN === process.env.FAKE_CLAUDE_EXPECT_TOKEN
              : null,
            session_id: "s1",
            ...(process.env.FAKE_CLAUDE_REPORT_ARGV === "1" ? launchReport() : {}),
          }),
    ) + "\n",
  );
  process.stderr.write("fake-claude stderr noise\n");
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
});
