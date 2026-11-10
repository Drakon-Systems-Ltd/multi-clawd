/**
 * #159: manual `/compact` on a multi-clawd backend.
 *
 * OpenClaw's public `manualCompaction` contract (`CliBackendManualCompaction`)
 * lets a backend that owns native compaction serve an explicit `/compact`. What
 * the host does with a backend that declares it was read from the dist of
 * 2026.8.1, 2026.11.1 and 2026.11.2 and from the tagged source of 2026.10.10,
 * and is the same in all four:
 *
 *  - it resumes the stored native session with the backend's `resumeArgs` and
 *    passes `manualCompaction.buildPrompt(...)` as an argv prompt;
 *  - it runs the backend's `config.command` ITSELF, as a plain process. A
 *    prepared `execute` transport is ignored for this run
 *    (`resolveCliExecutionTarget`: `controlOperation !== "compact"`), so the
 *    shim does not run on a verified launch;
 *  - `prepareExecution` is called first, with the ordinary context: no session
 *    id, and nothing that says the run is a control operation.
 *
 * A single-account backend is correct under exactly those rules: one account,
 * one config dir, and the session can only be there. So a verified
 * single-account backend declares the contract.
 *
 * The pooled backend is not: the session is resumable only on the account
 * whose config dir holds the newest copy, the pool finds that copy in the shim
 * (which does not run), and `prepareExecution` cannot know which session is
 * being compacted. The last suite here runs the host's launch against the pool
 * and shows what a declaration would do after a rotation: the stale copy on the
 * selected account is compacted, becomes the newest file, and replaces the real
 * conversation on the next turn. So the pool keeps the host's refusal.
 *
 * What this suite is. FIXTURE throughout: the host's launch is REPRODUCED from
 * the rules above (prepareExecution, then resolveExecutionArgs on resumeArgs,
 * then `config.command` spawned directly with the prepared env), against a
 * fixture `claude`. It does not call the host's `compactNativeCliSession`, and
 * a refusal here is this file's own helper declining to launch, not the host.
 * Host facts are checked elsewhere: the refusal gate in
 * tests/issue-146-manual-compaction-contract.test.ts, and the target selection
 * for a compact run in tests/host-execute-target.test.ts (which loads the
 * host's own function on dists that export it). The pool suite shows a
 * transcript rewrite and what the handover planner would then do; it is not a
 * run of the host or of Claude Code. Tests that change with this PR: the
 * verified single-account declaration, the single-account control run and the
 * control-run argv. The pool and legacy "undeclared" tests pin behaviour that
 * was already there. Nothing here starts a gateway, reads a credential or
 * contacts a provider.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildBackend, registerPoolBackend, resolveBackendLaunch, type BackendLaunch } from "../src/index.js";
import { CLAUDE_MANUAL_COMPACTION, declaresManualCompaction } from "../src/manual-compaction.js";
import { planSessionHandover } from "../src/session-handover.js";
import { resolvePoolExecutionArgs } from "../src/tool-cap.js";

const FIXTURE = join(__dirname, "fixtures", "fake-claude-compact.mjs");
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MODEL = "claude-sonnet-5";

type Backend = ReturnType<typeof buildBackend>;
type Manual = {
  buildPrompt: (instructions?: string) => string;
  input: string;
  validateOutput: (raw: string) => { ok: boolean; reason?: string };
};
const manualOf = (backend: Backend) => (backend as { manualCompaction?: Manual }).manualCompaction;

let scratch = "";
let stateDir = "";
let log = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mc-159-"));
  stateDir = join(scratch, "openclaw-state");
  log = join(scratch, "claude.log");
  mkdirSync(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_HOME", scratch);
  vi.stubEnv("FAKE_CLAUDE_LOG", log);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function verifiedLaunch(): BackendLaunch {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(FIXTURE, join(bin, "claude"));
  chmodSync(join(bin, "claude"), 0o755);
  const launch = resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: bin }, platform: "linux" });
  expect(launch.kind).toBe("verified");
  return launch;
}

const legacyLaunch = (): BackendLaunch => resolveBackendLaunch({ hostSupportsExecute: false });

function configDir(id: string): string {
  return join(scratch, `${id}-login`);
}

function transcriptPath(id: string): string {
  return join(configDir(id), "projects", "-tmp-ws", `${SESSION}.jsonl`);
}

/** Write `turns` user records as account `id`'s copy of the session, last modified `ageMs` ago. */
function writeTranscript(id: string, turns: number, ageMs: number): void {
  const file = transcriptPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) => JSON.stringify({ type: "user", turn: i + 1 }));
  writeFileSync(file, lines.join("\n") + "\n");
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}

function readTranscript(id: string): Array<Record<string, unknown>> {
  return readFileSync(transcriptPath(id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Every file under the multi-clawd state dir, with its content: the pool's whole accounting surface. */
function stateSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(stateDir.length)] = readFileSync(path, "utf8");
    }
  };
  walk(stateDir);
  return out;
}

/**
 * The host's manual-compaction launch, reproduced: prepare, resolve argv on
 * `resumeArgs`, then spawn `config.command` directly with the prepared env.
 * `prepared.execute` is deliberately unused, as the host does not use it here.
 */
async function hostCompactLaunch(
  backend: Backend,
  options: { controlOperation?: "compact"; instructions?: string } = { controlOperation: "compact" },
): Promise<{ status: number | null; stdout: string; stderr: string; argv: string[]; prepared: { env?: Record<string, string>; execute?: unknown } }> {
  const manual = manualOf(backend);
  if (!manual) throw new Error(`backend ${backend.id} declares no manualCompaction: the host refuses before launching`);
  const prepared = (await backend.prepareExecution!({
    workspaceDir: "/tmp/ws",
    provider: backend.id,
    modelId: MODEL,
    executionMode: "agent",
  } as never)) as { env?: Record<string, string>; execute?: unknown };
  const resolved = backend.resolveExecutionArgs!({
    workspaceDir: "/tmp/ws",
    provider: backend.id,
    modelId: MODEL,
    executionMode: "agent",
    hostOwnedTools: ["exec", "process"],
    useResume: true,
    ...(options.controlOperation ? { controlOperation: options.controlOperation } : {}),
    baseArgs: backend.config.resumeArgs!,
  } as never)!;
  const argv = [
    ...resolved.map((a) => a.replaceAll("{sessionId}", SESSION)),
    "--model",
    MODEL,
    manual.buildPrompt(options.instructions),
  ];
  const run = spawnSync(backend.config.command, argv, {
    cwd: scratch,
    env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_LOG: log, ...(prepared.env ?? {}) },
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, argv, prepared };
}

const launches = () =>
  (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []).map(
    (l) => JSON.parse(l) as { argv: string[]; configDir: string | null; accountId: string | null; envKeys: string[] },
  );

describe("the contract is a faithful port of the bundled claude-cli backend's (#159)", () => {
  test("prompt, transport and validator", () => {
    expect(CLAUDE_MANUAL_COMPACTION.buildPrompt()).toBe("/compact");
    expect(CLAUDE_MANUAL_COMPACTION.buildPrompt("   ")).toBe("/compact");
    expect(CLAUDE_MANUAL_COMPACTION.buildPrompt("  keep the plan  ")).toBe("/compact keep the plan");
    expect(CLAUDE_MANUAL_COMPACTION.input).toBe("arg");
    expect(CLAUDE_MANUAL_COMPACTION.validateOutput('{"type":"system","subtype":"compact_boundary"}')).toEqual({ ok: true });
    expect(CLAUDE_MANUAL_COMPACTION.validateOutput('noise\n{"compact_result":"success"}\n')).toEqual({ ok: true });
  });

  test("a successful exit that never confirms compaction is rejected, with a reason", () => {
    for (const raw of [
      "",
      '{"type":"result","subtype":"success"}',
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","subtype":"compact_boundary"}',
      '{"compact_result":"failed"}',
      "compact_boundary",
      "null\n42\n[]",
    ]) {
      const verdict = CLAUDE_MANUAL_COMPACTION.validateOutput(raw);
      expect(verdict.ok, raw).toBe(false);
      expect((verdict as { reason: string }).reason).toMatch(/did not confirm/);
    }
  });

  test("the installed OpenClaw's bundled contract answers every probe identically", async () => {
    const dist = process.env.MULTI_CLAWD_OPENCLAW_DIST ?? dirname(createRequire(import.meta.url).resolve("openclaw"));
    const mod = (await import(pathToFileURL(join(dist, "extensions", "anthropic", "cli-backend.js")).href)) as {
      buildAnthropicCliBackend: () => { manualCompaction?: Manual };
    };
    const bundled = mod.buildAnthropicCliBackend().manualCompaction!;
    expect(bundled).toBeDefined();
    expect(CLAUDE_MANUAL_COMPACTION.input).toBe(bundled.input);
    for (const instructions of [undefined, "", "  ", "keep the plan", "  two  words ", "/compact"]) {
      expect(CLAUDE_MANUAL_COMPACTION.buildPrompt(instructions)).toBe(bundled.buildPrompt(instructions));
    }
    for (const raw of [
      "",
      "not json",
      '{"type":"system","subtype":"compact_boundary"}',
      '{"compact_result":"success"}',
      '{"compact_result":"failed"}',
      '{"type":"result","subtype":"success"}',
      '{"type":"system","subtype":"init"}\n{"type":"system","subtype":"compact_boundary"}\n',
      '{"type":"user","subtype":"compact_boundary"}',
      "null",
      "[1,2]",
    ]) {
      expect(CLAUDE_MANUAL_COMPACTION.validateOutput(raw), raw).toEqual(bundled.validateOutput(raw));
    }
  });
});

describe("who declares it (#159)", () => {
  test("a verified single-account backend declares the contract", () => {
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, verifiedLaunch());
    expect(backend.ownsNativeCompaction).toBe(true);
    expect(manualOf(backend)).toBe(CLAUDE_MANUAL_COMPACTION);
  });

  test("a legacy single-account backend does not: there the host would run the shim, which records a served launch", () => {
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, legacyLaunch());
    expect(backend.ownsNativeCompaction).toBe(true);
    expect(manualOf(backend)).toBeUndefined();
  });

  test.each([
    ["verified", verifiedLaunch],
    ["legacy", legacyLaunch],
  ] as const)("the pooled backend never declares it (%s launch)", (_name, launch) => {
    const pool = registerPool(launch());
    expect(pool.ownsNativeCompaction).toBe(true);
    expect(manualOf(pool)).toBeUndefined();
  });

  test("the rule itself: verified and single-account, nothing else", () => {
    const verified = verifiedLaunch();
    expect(declaresManualCompaction({ launch: verified, pooled: false })).toBe(true);
    expect(declaresManualCompaction({ launch: verified, pooled: true })).toBe(false);
    expect(declaresManualCompaction({ launch: legacyLaunch(), pooled: false })).toBe(false);
    expect(declaresManualCompaction({ launch: legacyLaunch(), pooled: true })).toBe(false);
  });
});

function registerPool(launch: BackendLaunch, poolOverrides: Record<string, unknown> = {}): Backend {
  let backend: Backend | undefined;
  const api = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerCliBackend: (b: Backend) => {
      backend = b;
    },
    registerProvider: () => {},
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"], ...poolOverrides },
    [
      { id: "claw1", configDir: configDir("claw1") },
      { id: "claw2", configDir: configDir("claw2") },
    ],
    new Set(["claw1", "claw2"]),
    undefined,
    { launch },
  );
  if (!backend) throw new Error("pool backend did not register");
  return backend;
}

describe("a manual /compact on a verified single-account backend (#159)", () => {
  test("compacts the session in that account's own config dir and is confirmed", async () => {
    writeTranscript("claw1", 10, 60_000);
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, verifiedLaunch());
    const run = await hostCompactLaunch(backend, { controlOperation: "compact", instructions: " keep the plan " });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(manualOf(backend)!.validateOutput(run.stdout)).toEqual({ ok: true });
    const after = readTranscript("claw1");
    expect(after[0]).toMatchObject({ type: "system", subtype: "compact_boundary" });
    expect(after[1]).toMatchObject({ isCompactSummary: true, folded: 10, last: { turn: 10 } });
  });

  test("launches claude itself, once, on that account, resuming that session with the /compact prompt last", async () => {
    writeTranscript("claw1", 3, 60_000);
    const launch = verifiedLaunch();
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, launch);
    const run = await hostCompactLaunch(backend, { controlOperation: "compact", instructions: "keep the plan" });

    expect(backend.config.command).toBe((launch as { claudeCommand: string }).claudeCommand);
    const seen = launches();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.accountId).toBe("claw1");
    expect(seen[0]!.configDir).toBe(configDir("claw1"));
    expect(seen[0]!.argv).toEqual(run.argv);
    expect(run.argv.slice(run.argv.indexOf("--resume"), run.argv.indexOf("--resume") + 2)).toEqual(["--resume", SESSION]);
    expect(run.argv.at(-1)).toBe("/compact keep the plan");
    // What the backend PREPARES carries no pool steering: there is no roster, session-dir list or
    // affinity for one account. (How the host merges a prepared env into the child is the host's;
    // this reproduction passes the prepared env and nothing else of ours.)
    expect(Object.keys(run.prepared.env ?? {}).filter((k) => k.startsWith("MULTI_CLAWD_")).sort()).toEqual([
      "MULTI_CLAWD_ACCOUNT_ID",
      "MULTI_CLAWD_STATE_FILE",
    ]);
    expect(seen[0]!.envKeys).toEqual(["MULTI_CLAWD_ACCOUNT_ID", "MULTI_CLAWD_STATE_FILE"]);
  });

  test("full exec mode, through the registered hook: the marked run is launched without bypassPermissions, an unmarked one keeps it", async () => {
    writeTranscript("claw1", 3, 60_000);
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, "full", verifiedLaunch());
    expect(backend.config.resumeArgs).toContain("bypassPermissions");

    const marked = await hostCompactLaunch(backend, { controlOperation: "compact" });
    expect(marked.status).toBe(0);
    expect(launches().at(-1)!.argv).not.toContain("--permission-mode");
    expect(launches().at(-1)!.argv).not.toContain("bypassPermissions");

    // A host before 2026.11.2 passes no marker; the bundled backend keeps the mode there as well.
    writeTranscript("claw1", 3, 60_000);
    const unmarked = await hostCompactLaunch(backend, {});
    expect(unmarked.status).toBe(0);
    const argv = launches().at(-1)!.argv;
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("writes nothing to the multi-clawd state dir: no served launch, no sticky entry, no health record", async () => {
    writeTranscript("claw1", 4, 60_000);
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, verifiedLaunch());
    const before = stateSnapshot();
    const run = await hostCompactLaunch(backend);
    expect(run.status).toBe(0);
    expect(stateSnapshot()).toEqual(before);
  });

  test("a session this account does not hold fails without touching any transcript, and is not confirmed", async () => {
    writeTranscript("claw2", 6, 60_000);
    const backend = buildBackend({ id: "claw1", configDir: configDir("claw1") }, undefined, verifiedLaunch());
    const run = await hostCompactLaunch(backend);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/No conversation found with session ID/);
    expect(manualOf(backend)!.validateOutput(run.stdout).ok).toBe(false);
    expect(existsSync(transcriptPath("claw1"))).toBe(false);
    expect(readTranscript("claw2")).toHaveLength(6);
    expect(readTranscript("claw2").at(-1)).toEqual({ type: "user", turn: 6 });
  });
});

describe("argv for the control run mirrors the bundled resolver (#159)", () => {
  const RESUME = (permission: string[]) => [
    "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--setting-sources", "user",
    "--allowedTools", "mcp__openclaw__*",
    "--disallowedTools", "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
    ...permission,
    "--resume", "{sessionId}",
  ];
  const BYPASS = ["--permission-mode", "bypassPermissions"];

  test("OpenClaw 2026.11.2 marks the run: a compaction never runs under bypassPermissions", () => {
    const args = resolvePoolExecutionArgs({ baseArgs: RESUME(BYPASS), executionMode: "agent", controlOperation: "compact" });
    expect(args).toEqual(RESUME([]));
    expect(args).not.toContain("--permission-mode");
  });

  test("the equals form is dropped as well, and the resume pair is untouched", () => {
    const args = resolvePoolExecutionArgs({
      baseArgs: [...RESUME([]).slice(0, -2), "--permission-mode=bypassPermissions", "--resume", "{sessionId}"],
      controlOperation: "compact",
    });
    expect(args).toEqual(RESUME([]));
  });

  test("host-owned Bash is still denied on the control run, exactly as on a chat turn", () => {
    const args = resolvePoolExecutionArgs({
      baseArgs: RESUME(BYPASS),
      executionMode: "agent",
      hostOwnedTools: ["exec", "process"],
      controlOperation: "compact",
    });
    expect(args).toEqual([
      "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--setting-sources", "user",
      "--allowedTools", "mcp__openclaw__*",
      "--resume", "{sessionId}",
      "--disallowedTools", "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor,Bash",
    ]);
  });

  test.each(["plan", "default", "acceptEdits"])("an explicit %s mode is kept on the control run, in both spellings: only the injected bypass goes", (mode) => {
    const spaced = RESUME(["--permission-mode", mode]);
    expect(resolvePoolExecutionArgs({ baseArgs: spaced, controlOperation: "compact" })).toEqual(spaced);
    const equals = [...RESUME([]).slice(0, -2), `--permission-mode=${mode}`, "--resume", "{sessionId}"];
    expect(resolvePoolExecutionArgs({ baseArgs: equals, controlOperation: "compact" })).toEqual(equals);
  });

  test("a trailing --permission-mode with no value is not treated as the bypass pair", () => {
    const dangling = [...RESUME([]), "--permission-mode"];
    expect(resolvePoolExecutionArgs({ baseArgs: dangling, controlOperation: "compact" })).toEqual(dangling);
  });

  test("an ordinary turn keeps bypassPermissions: the strip is the control run's alone", () => {
    expect(resolvePoolExecutionArgs({ baseArgs: RESUME(BYPASS), executionMode: "agent" })).toEqual(RESUME(BYPASS));
  });

  test("an older host (2026.8.1 to 2026.11.1) passes no marker, so the run keeps the argv the bundled backend also keeps there", () => {
    const backend = buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" }, "full", { kind: "legacy", shimPath: "/x/shim.js" });
    const resume = backend.config.resumeArgs!.slice(1);
    expect(resume).toEqual(RESUME(BYPASS));
    expect(resolvePoolExecutionArgs({ baseArgs: resume, executionMode: "agent" })).toEqual(RESUME(BYPASS));
  });
});

describe("why the pooled backend keeps the host's refusal (#159)", () => {
  /**
   * The conversation: turns 1 to 5 on claw1, a rotation, the shim's handover
   * copies it to claw2, turns 6 to 10 there. claw1's copy is now a stale
   * prefix. Nothing on disk says the pool should leave home, so the next
   * launch is prepared on claw1, as any launch would be.
   */
  function rotatedConversation(): void {
    writeTranscript("claw1", 5, 3_600_000);
    writeTranscript("claw2", 10, 60_000);
  }

  test("prepareExecution is given no session, so it selects on health and stickiness alone: here, the account holding the stale copy", async () => {
    rotatedConversation();
    const pool = registerPool(verifiedLaunch());
    const prepared = (await pool.prepareExecution!({
      workspaceDir: "/tmp/ws", provider: "clawd", modelId: MODEL, executionMode: "agent",
    } as never)) as { env: Record<string, string>; execute?: unknown };
    expect(prepared.env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(configDir("claw1"));
    // The shim, which is what finds the newest copy, is only reachable through the transport the host ignores.
    expect(typeof prepared.execute).toBe("function");
    // Before any launch, the handover planner still knows where the conversation is.
    expect(
      planSessionHandover({ sessionId: SESSION, targetDir: configDir("claw1"), memberDirs: [configDir("claw1"), configDir("claw2")] }),
    ).toMatchObject({ action: "copy", fromDir: configDir("claw2") });
  });

  test("reproduction: with the contract attached to a copy of the pool backend, the launch rules compact the stale copy, the validator confirms it, and the handover planner then prefers it", async () => {
    rotatedConversation();
    const pool = registerPool(verifiedLaunch());
    expect(manualOf(pool)).toBeUndefined();
    // Hypothetical, on a copy of the backend object only: what a declaration would start.
    const declared = Object.assign(Object.create(Object.getPrototypeOf(pool)), pool, {
      manualCompaction: CLAUDE_MANUAL_COMPACTION,
    }) as Backend;

    const run = await hostCompactLaunch(declared);

    // Exit 0 and a confirming validator: the two things the host requires before reporting a completed compaction.
    expect(run.status).toBe(0);
    expect(CLAUDE_MANUAL_COMPACTION.validateOutput(run.stdout)).toEqual({ ok: true });
    // It compacted claw1's five-turn prefix, not the ten-turn conversation.
    expect(launches()).toHaveLength(1);
    expect(launches()[0]!.accountId).toBe("claw1");
    expect(readTranscript("claw1")[1]).toMatchObject({ isCompactSummary: true, folded: 5, last: { turn: 5 } });
    expect(readTranscript("claw2")).toHaveLength(10);
    // And that prefix is now the newest file, so the next turn's handover picks it on either account:
    // claw2's real transcript would be overwritten, and on claw1 nothing would be fetched.
    const dirs = [configDir("claw1"), configDir("claw2")];
    expect(planSessionHandover({ sessionId: SESSION, targetDir: configDir("claw2"), memberDirs: dirs })).toMatchObject({
      action: "copy",
      fromDir: configDir("claw1"),
      to: transcriptPath("claw2"),
    });
    expect(planSessionHandover({ sessionId: SESSION, targetDir: configDir("claw1"), memberDirs: dirs })).toEqual({
      action: "none",
      reason: "already-local",
    });
    // The pool's prepared env carries its steering variables, which only the shim consumes and strips.
    expect(launches()[0]!.envKeys).toContain("MULTI_CLAWD_SESSION_DIRS");
    expect(launches()[0]!.envKeys).toContain("MULTI_CLAWD_RETRY_ACCOUNTS");
  });

  test("the real pool backend is undeclared, so this reproduction (like the host gate pinned in the #146 suite) stops before any launch", async () => {
    rotatedConversation();
    const pool = registerPool(verifiedLaunch());
    await expect(hostCompactLaunch(pool)).rejects.toThrow(/declares no manualCompaction/);
    expect(launches()).toHaveLength(0);
    expect(readTranscript("claw1")).toHaveLength(5);
    expect(readTranscript("claw2")).toHaveLength(10);
    expect(readTranscript("claw2").at(-1)).toEqual({ type: "user", turn: 10 });
  });
});
