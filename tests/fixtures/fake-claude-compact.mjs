#!/usr/bin/env node
// Fixture `claude` for #159: a SYNTHETIC model of an account-local compaction.
// It is not Claude Code and does not claim to reproduce what Claude Code writes
// to a transcript or prints under this argv; neither has been observed here.
// It models the one property the tests rely on: a compaction acts on the
// transcript in the process's OWN config dir and nowhere else.
//
//   claude ... --resume <id> ... "/compact [instructions]"
//
// Found:   rewrites <CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl to a boundary
//          record plus one summary record naming how many records it folded,
//          prints a `compact_boundary` system event (one of the two signals the
//          contract's validator accepts), exits 0.
// Missing: prints "No conversation found with session ID", exits 1.
//
// Every invocation is appended to FAKE_CLAUDE_LOG (argv + the env the test
// cares about) so the test can assert exactly what was launched. No network.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    env.FAKE_CLAUDE_LOG,
    JSON.stringify({
      argv,
      configDir: env.CLAUDE_CONFIG_DIR ?? null,
      accountId: env.MULTI_CLAWD_ACCOUNT_ID ?? null,
      envKeys: Object.keys(env).filter((k) => k.startsWith("MULTI_CLAWD_")).sort(),
    }) + "\n",
  );
}

const resumeAt = argv.indexOf("--resume");
const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : undefined;
const prompt = argv[argv.length - 1] ?? "";
if (!sessionId || !prompt.startsWith("/compact")) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "not a compact run" }) + "\n");
  process.exit(0);
}

const projects = join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
let transcript;
try {
  for (const sub of readdirSync(projects)) {
    const candidate = join(projects, sub, `${sessionId}.jsonl`);
    try {
      readFileSync(candidate);
      transcript = candidate;
      break;
    } catch {
      /* not in this project dir */
    }
  }
} catch {
  /* no projects dir at all */
}
if (!transcript) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}

const records = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: sessionId }),
    JSON.stringify({ type: "user", isCompactSummary: true, folded: records.length, last: JSON.parse(records[records.length - 1]) }),
  ].join("\n") + "\n",
);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\n");
process.stdout.write(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: sessionId }) + "\n");
process.exit(0);
