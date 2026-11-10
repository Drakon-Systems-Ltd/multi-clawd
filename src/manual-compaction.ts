/**
 * Manual `/compact` for Claude Code backends (#159).
 *
 * OpenClaw's public CLI-backend contract has two compaction fields. A backend
 * that sets `ownsNativeCompaction` tells core that the CLI compacts its own
 * transcript; core then refuses an explicit `/compact` unless the backend also
 * declares `manualCompaction` ("owns compaction but does not support manual
 * compaction"). The bundled `claude-cli` backend declares it, and the contract
 * below is a port of that declaration (`extensions/anthropic/cli-backend.ts`):
 * same prompt, same transport, same validator. Keep it in lockstep;
 * tests/issue-159-manual-compaction.test.ts compares the two on the installed
 * OpenClaw.
 *
 * How the host runs it (`compactNativeCliSession` and
 * `resolveCliExecutionTarget`; read from the dist of 2026.8.1, 2026.11.1 and
 * 2026.11.2 and from the tagged source of 2026.10.10):
 *
 *  1. `prepareExecution` is called with the ordinary context. It carries no
 *     session id and nothing that marks the run as a control operation.
 *  2. `resolveExecutionArgs` runs on `resumeArgs`. From 2026.11.2 its context
 *     carries `controlOperation: "compact"`; earlier hosts pass no marker.
 *  3. The host spawns `config.command` itself, as a plain process, resuming
 *     the stored session with the prompt as an argument. A prepared `execute`
 *     transport is NOT used for this run. On a verified launch the command is
 *     claude, so the shim does not run; on a legacy launch the command is node
 *     with the shim as its first argument, so it does.
 *  4. A zero exit counts only if `validateOutput` confirms it: a
 *     `compact_boundary` system event or `compact_result: "success"`.
 *
 * The run is queued like any other launch of that backend. The host derives
 * one lane key per OpenClaw session for a backend with a live-session mode
 * (`resolveCliRunQueueKey`: backend id plus a digest of agent id, session id
 * and session key) and runs both launch targets inside that lane, so a turn
 * and a compaction of the same session do not overlap.
 *
 * Inside the lane, before the control run, the host retires that session's
 * live-session slot (`restartCliLiveSession`, keyed by backend id and the
 * same session digest) and closes it again when the run ends. For these
 * backends the slot only ever holds the per-turn shim process, which the
 * transport registers when a turn starts and removes once the process has
 * exited (shim-transport.ts), and the transport already asks the host for the
 * same restart before every turn. So the slot is empty when a compaction
 * starts: there is no process to stop, and the operation touches no
 * transcript or session binding.
 *
 * That is correct for a single-account backend on a verified launch: the
 * command is claude, the prepared env is that one account's login, and the
 * session can only be in that account's config dir. Nothing is recorded,
 * because nothing of ours runs: no served launch, no sticky entry, no health
 * capture. This rests on the host rules above and a fixture claude; a live
 * `/compact` against a running gateway has not been exercised.
 *
 * It is NOT correct for the pooled backend, which therefore does not declare
 * the contract and keeps the host's refusal:
 *
 *  - A pooled session is resumable only where the newest copy of its
 *    transcript is. The pool gets it there in the shim, which reads the
 *    session id from argv (session-handover.ts) and applies session affinity.
 *    Step 3 skips the shim, and step 1 cannot stand in for it because it is
 *    not told the session.
 *  - So the control run lands on whichever account health and stickiness
 *    select. If that account holds a stale copy from before a rotation, claude
 *    compacts the stale copy and reports success. The rewritten file is then
 *    the newest, and the next turn's handover puts it in place of the real
 *    conversation: the turns after the rotation are gone. If the account holds
 *    no copy, the run just fails.
 *  - The pool's steering variables (retry roster, session dirs, affinity)
 *    would reach a bare claude, which the shim otherwise strips.
 *
 * A legacy launch (node + shim as the command) is left out as well: the host
 * would run the shim for the control run, and the shim records every spawn as
 * a served launch, which feeds spread placement and the history report.
 *
 * What would let the pool declare it: the host passing the resumed session id
 * (or the control-operation marker together with the session) to
 * `prepareExecution`, or routing control operations through the prepared
 * `execute` transport. Neither exists in the public SDK today.
 */

type ManualCompactionVerdict = { ok: true } | { ok: false; reason: string };

/** Structural match for OpenClaw's `CliBackendManualCompaction`. */
export type ClaudeManualCompaction = Readonly<{
  buildPrompt: (customInstructions?: string) => string;
  input: "arg" | "stdin";
  validateOutput: (rawOutput: string) => ManualCompactionVerdict;
}>;

export const CLAUDE_MANUAL_COMPACTION: ClaudeManualCompaction = Object.freeze({
  buildPrompt: (customInstructions?: string): string => {
    const instructions = customInstructions?.trim();
    return instructions ? `/compact ${instructions}` : "/compact";
  },
  input: "arg" as const,
  validateOutput: (rawOutput: string): ManualCompactionVerdict => {
    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line) as { compact_result?: unknown; type?: unknown; subtype?: unknown };
        if (
          event.compact_result === "success" ||
          (event.type === "system" && event.subtype === "compact_boundary")
        ) {
          return { ok: true };
        }
      } catch {
        /* not a JSON record (or not an object): keep looking */
      }
    }
    return { ok: false, reason: "Claude CLI did not confirm that native compaction ran." };
  },
});

/**
 * Whether a backend may declare `manualCompaction`: only a single-account
 * backend on a verified launch (see the file header for why each other case
 * is excluded).
 */
export function declaresManualCompaction(params: {
  launch: { kind: "verified" | "legacy" };
  pooled: boolean;
}): boolean {
  return params.launch.kind === "verified" && !params.pooled;
}
