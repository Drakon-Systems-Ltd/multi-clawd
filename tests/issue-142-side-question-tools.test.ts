/**
 * #142 — side-questions must be tool-free on the pool.
 *
 * The pool declares `sideQuestionToolMode: "disabled"`, and core trusts that:
 * it skips the empty-cap injection for side-questions and lets a `disableTools`
 * side run launch on a selectable backend. The bundled `claude-cli` backend
 * enforces the declaration in its argv resolver
 * (`resolveClaudeCliSideQuestionExecutionArgs`): strip session / resume / fork /
 * effort / tool / MCP-config flags, then append `--safe-mode --tools ""
 * --disallowedTools mcp__* --strict-mcp-config --no-session-persistence
 * --max-turns 1 --permission-mode default`. The pool ignored `executionMode`, so
 * a `/btw` or setup probe kept native Bash/Edit/Write selectable — under
 * `bypassPermissions` when the exec mode is `full`.
 *
 * Bundled order (2026.10.10 / 2026.11.1): host-owned Bash denial, then the
 * side-question projection, then the exact-cap projection. Expected argv below
 * is written out by hand from that source, not computed by the code under test.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBackend } from "../src/index.js";
import {
  RESTRICTED_SETTINGS,
  resolvePoolExecutionArgs,
  resolveSideQuestionExecutionArgs,
} from "../src/tool-cap.js";
import { cleanShimEnv } from "./shim-env";

const account = { id: "claw2", configDir: "/tmp/claw2" };
const SHIM = join(__dirname, "..", "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");

type ResolveCtx = Parameters<NonNullable<ReturnType<typeof buildBackend>["resolveExecutionArgs"]>>[0];

function ctx(
  baseArgs: readonly string[],
  extra: {
    hostOwnedTools?: readonly string[];
    executionMode?: "agent" | "side-question";
    toolAvailability?: { native: readonly string[]; openClaw: readonly string[] };
  } = {},
): ResolveCtx {
  return {
    baseArgs,
    workspaceDir: "/tmp",
    provider: "claw2",
    modelId: "claude-sonnet-5",
    useResume: false,
    ...extra,
  } as ResolveCtx;
}

/** The pool's operator argv after the launch prefix (BASE_ARGS in src/index.ts). */
const POOL_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
  "--allowedTools",
  "mcp__openclaw__*",
  "--disallowedTools",
  "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
];

/** What survives the side-question strip from POOL_ARGS. */
const POOL_ARGS_KEPT = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
];

/** Appended verbatim by the bundled side-question projection. */
const SIDE_QUESTION_TAIL = [
  "--safe-mode",
  "--tools",
  "",
  "--disallowedTools",
  "mcp__*",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--max-turns",
  "1",
  "--permission-mode",
  "default",
];

describe("ordinary side-question (no host-owned field, no cap)", () => {
  it("legacy launch under exec mode full: native tools off, MCP denied, bypass replaced by default", () => {
    const backend = buildBackend(account, "full", { kind: "legacy", shimPath: "/shim.js" });
    const baseArgs = [...backend.config.args];
    expect(baseArgs).toEqual(["/shim.js", ...POOL_ARGS, "--permission-mode", "bypassPermissions"]);

    const out = backend.resolveExecutionArgs!(ctx(baseArgs, { executionMode: "side-question" }));
    expect(out).toEqual(["/shim.js", ...POOL_ARGS_KEPT, ...SIDE_QUESTION_TAIL]);
    expect(out).not.toContain("bypassPermissions");
    expect(out).not.toContain("mcp__openclaw__*");
  });

  it("verified launch (no shim prefix) gets the same projection", () => {
    const backend = buildBackend(account, "full", {
      kind: "verified",
      claudeCommand: "/usr/bin/claude",
      shimPath: "/shim.js",
    });
    const out = backend.resolveExecutionArgs!(ctx([...backend.config.args], { executionMode: "side-question" }));
    expect(out).toEqual([...POOL_ARGS_KEPT, ...SIDE_QUESTION_TAIL]);
  });

  it("resume argv loses its --resume pair", () => {
    const backend = buildBackend(account, undefined, { kind: "legacy", shimPath: "/shim.js" });
    const out = backend.resolveExecutionArgs!(
      ctx([...backend.config.resumeArgs!], { executionMode: "side-question" }),
    );
    expect(out).toEqual(["/shim.js", ...POOL_ARGS_KEPT, ...SIDE_QUESTION_TAIL]);
  });

  it("strips every session / resume / fork / effort / tool / MCP-config flag in both spellings, as bundled does", () => {
    const baseArgs = [
      "/shim.js",
      "-p",
      "--effort",
      "high",
      "--effort=low",
      "--session-id",
      "abc",
      "--resume",
      "sess",
      "-r",
      "sess2",
      "--resume-session-at",
      "msg1",
      "--continue",
      "-c",
      "--fork-session",
      "--max-turns",
      "40",
      "--max-turns=7",
      "--permission-mode=bypassPermissions",
      "--tools",
      "Bash,Edit",
      "--tools=Write",
      "--allowedTools",
      "Bash",
      "Edit",
      "--allowed-tools=Write",
      "--disallowed-tools",
      "Monitor",
      "--mcp-config",
      "a.json",
      "b.json",
      "--mcp-config=c.json",
      "--bare",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
    ];
    expect(resolvePoolExecutionArgs({ baseArgs, executionMode: "side-question" })).toEqual([
      "/shim.js",
      "-p",
      "--output-format",
      "stream-json",
      ...SIDE_QUESTION_TAIL,
    ]);
  });

  it("keeps flags the bundled projection keeps (settings/system-prompt/add-dir/model are not its business)", () => {
    const baseArgs = ["-p", "--add-dir", "/w", "--append-system-prompt", "x", "--model", "claude-sonnet-5"];
    expect(resolveSideQuestionExecutionArgs(baseArgs)).toEqual([...baseArgs, ...SIDE_QUESTION_TAIL]);
  });

  it("an --effort with no usable value drops only the flag (bundled stripClaudeEffortArgs)", () => {
    expect(resolveSideQuestionExecutionArgs(["-p", "--effort", "--verbose"])).toEqual([
      "-p",
      "--verbose",
      ...SIDE_QUESTION_TAIL,
    ]);
  });
});

describe("side-question with host-owned exec (2026.10.10+)", () => {
  it("is identical with and without the field: the Bash denial is subsumed by --tools \"\"", () => {
    const backend = buildBackend(account, "full", { kind: "legacy", shimPath: "/shim.js" });
    const baseArgs = [...backend.config.args];
    const without = backend.resolveExecutionArgs!(ctx(baseArgs, { executionMode: "side-question" }));
    const withField = backend.resolveExecutionArgs!(
      ctx(baseArgs, { executionMode: "side-question", hostOwnedTools: ["exec", "process"] }),
    ) as readonly string[];
    expect(withField).toEqual(without);
    expect(withField).toEqual(["/shim.js", ...POOL_ARGS_KEPT, ...SIDE_QUESTION_TAIL]);
    // Exactly one tool list and one denial list: no native tool is selectable at all.
    expect(withField.filter((a) => a === "--tools")).toHaveLength(1);
    expect(withField[withField.indexOf("--tools") + 1]).toBe("");
    expect(withField.filter((a) => a === "--disallowedTools")).toHaveLength(1);
  });
});

describe("side-question with an exact cap (restricted projection runs last, as bundled)", () => {
  const side = ["/shim.js", ...POOL_ARGS_KEPT, ...SIDE_QUESTION_TAIL];
  const restrictedKept = ["/shim.js", "-p", "--output-format", "stream-json", "--include-partial-messages",
    "--verbose", "--no-session-persistence", "--max-turns", "1"];
  const restrictedTail = ["--setting-sources", "", "--settings", RESTRICTED_SETTINGS, "--disable-slash-commands",
    "--no-chrome", "--strict-mcp-config"];

  it("empty cap: no native tools, every MCP tool denied, single-turn and no persistence kept", () => {
    const backend = buildBackend(account, "full", { kind: "legacy", shimPath: "/shim.js" });
    const out = backend.resolveExecutionArgs!(ctx([...backend.config.args], {
      executionMode: "side-question",
      hostOwnedTools: ["exec", "process"],
      toolAvailability: { native: [], openClaw: [] },
    }));
    expect(out).toEqual([...restrictedKept, ...restrictedTail, "--tools", "", "--disallowedTools", "mcp__*"]);
    expect(out).not.toContain("bypassPermissions");
  });

  it("named cap: the side-question's mcp__* denial is preserved, so named OpenClaw tools stay denied", () => {
    const out = resolvePoolExecutionArgs({
      baseArgs: [...side.slice(0, 8), "--permission-mode", "bypassPermissions"],
      executionMode: "side-question",
      toolAvailability: { native: ["Read"], openClaw: ["web_search"] },
    });
    expect(out).toEqual([
      ...restrictedKept,
      ...restrictedTail,
      "--tools",
      "Read",
      "--allowedTools",
      "mcp__openclaw__web_search",
      "--disallowedTools",
      "mcp__*",
    ]);
  });
});

describe("non-side-question runs are unchanged", () => {
  const baseArgs = ["/shim.js", ...POOL_ARGS, "--permission-mode", "bypassPermissions"];

  it("agent mode and an absent mode leave a plain turn untouched", () => {
    expect(resolvePoolExecutionArgs({ baseArgs, executionMode: "agent" })).toBe(baseArgs);
    expect(resolvePoolExecutionArgs({ baseArgs })).toBe(baseArgs);
  });

  it("agent mode with host-owned exec only appends Bash to the denials (#136)", () => {
    const out = resolvePoolExecutionArgs({ baseArgs, executionMode: "agent", hostOwnedTools: ["exec"] });
    expect(out).toEqual([
      "/shim.js",
      ...POOL_ARGS.slice(0, -2),
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor,Bash",
    ]);
  });

  it("agent mode never picks up side-question flags", () => {
    const out = resolvePoolExecutionArgs({ baseArgs, executionMode: "agent", hostOwnedTools: ["exec"] });
    for (const flag of ["--safe-mode", "--no-session-persistence", "--max-turns", "--tools"]) {
      expect(out).not.toContain(flag);
    }
  });
});

describe("legacy launch: the shim forwards the projected argv to claude unchanged", () => {
  it("every side-question flag (including the empty --tools value) reaches the child in order", () => {
    expect(existsSync(SHIM)).toBe(true);
    const backend = buildBackend(account, "full", { kind: "legacy", shimPath: SHIM });
    const projected = backend.resolveExecutionArgs!(ctx([...backend.config.args], {
      executionMode: "side-question",
      hostOwnedTools: ["exec", "process"],
    }));
    expect(projected[0]).toBe(SHIM);
    // OpenClaw appends `--model <requested>` after the hook's argv.
    const argv = [...projected, "--model", "claude-sonnet-5"];
    const dir = mkdtempSync(join(tmpdir(), "mc-142-"));
    const res = spawnSync(process.execPath, argv, {
      input: "q\n",
      encoding: "utf8",
      env: cleanShimEnv({
        MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
        MULTI_CLAWD_STATE_FILE: join(dir, "claw2.json"),
        MULTI_CLAWD_ACCOUNT_ID: "claw2",
        FAKE_CLAUDE_EXIT: "0",
        FAKE_CLAUDE_REPORT_ARGV: "1",
      }),
    });
    expect(res.status).toBe(0);
    const result = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; argv?: string[] })
      .find((r) => r.type === "result");
    expect(result?.argv).toEqual(argv.slice(1));
  });
});
