// Stand-in for the claude CLI in shim integration tests.
// Emits stream-json lines (one split across two writes), echoes one stdin
// line into an assistant record, and exits with FAKE_CLAUDE_EXIT.
const lines = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]},"session_id":"s1"}',
];
process.stdout.write(lines[0] + "\n");

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
  process.stdout.write(
    JSON.stringify(
      emitLimit
        ? {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "You've reached your Fable 5 limit. /model to switch models.",
            received_model: modelIdx >= 0 ? process.argv[modelIdx + 1] : null,
            session_id: "s1",
          }
        : {
            type: "result",
            result: stdin.trim(),
            received_model: modelIdx >= 0 ? process.argv[modelIdx + 1] : null,
            session_id: "s1",
          },
    ) + "\n",
  );
  process.stderr.write("fake-claude stderr noise\n");
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
});
