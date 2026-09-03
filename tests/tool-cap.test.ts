/**
 * The pool must accept exact-cap runs (OpenClaw 2026.8.2 fails closed
 * otherwise) and rewrite argv exactly as the bundled claude-cli backend does,
 * so a cron job behaves the same on either backend.
 */
import { describe, expect, it } from "vitest";
import { buildBackend } from "../src/index.js";
import {
  RESTRICTED_SETTINGS,
  resolvePoolExecutionArgs,
  resolveRestrictedExecutionArgs,
  stripClaudeArgs,
} from "../src/tool-cap.js";

const account = { id: "claw2", configDir: "/tmp/claw2" };

describe("backend declares exact-cap support", () => {
  it("is selectable with execution-args enforcement and a resolver (the 2026.8.2 launch gate)", () => {
    const backend = buildBackend(account);
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.toolAvailabilityEnforcement).toBe("execution-args");
    expect(typeof backend.resolveExecutionArgs).toBe("function");
  });

  it("leaves uncapped (chat) runs untouched", () => {
    const backend = buildBackend(account);
    const baseArgs = [...backend.config.args];
    const out = backend.resolveExecutionArgs!({
      baseArgs,
      workspaceDir: "/tmp",
      provider: "claw2",
      modelId: "claude-sonnet-5",
      useResume: false,
    });
    expect(out).toEqual(baseArgs);
  });
});

describe("resolveRestrictedExecutionArgs (port of core)", () => {
  const baseArgs = [
    "/shim.js",
    "-p",
    "--output-format",
    "stream-json",
    "--setting-sources",
    "user",
    "--allowedTools",
    "mcp__openclaw__*",
    "--disallowedTools",
    "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
    "--permission-mode",
    "bypassPermissions",
  ];

  it("keeps the shim path and stream flags, strips operator tool/permission flags", () => {
    const out = resolveRestrictedExecutionArgs(baseArgs, { native: [], openClaw: [] });
    expect(out[0]).toBe("/shim.js");
    expect(out).toContain("--output-format");
    expect(out).not.toContain("bypassPermissions");
    expect(out.filter((a) => a === "--setting-sources")).toHaveLength(1);
    expect(out[out.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("disables hooks, plugins, memory, slash commands and chrome with core's exact settings blob", () => {
    const out = resolveRestrictedExecutionArgs(baseArgs, { native: [], openClaw: [] });
    expect(out[out.indexOf("--settings") + 1]).toBe(RESTRICTED_SETTINGS);
    expect(RESTRICTED_SETTINGS).toBe(
      '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}',
    );
    expect(out).toContain("--disable-slash-commands");
    expect(out).toContain("--no-chrome");
    expect(out).toContain("--strict-mcp-config");
  });

  it("with no tools at all: --tools '' and every MCP tool denied, operator denials preserved and sorted", () => {
    const out = resolveRestrictedExecutionArgs(baseArgs, { native: [], openClaw: [] });
    expect(out[out.indexOf("--tools") + 1]).toBe("");
    expect(out).not.toContain("--allowedTools");
    expect(out[out.indexOf("--disallowedTools") + 1]).toBe(
      "Bash(run_in_background:true),CronCreate,Monitor,ScheduleWakeup,mcp__*",
    );
  });

  it("allows exactly the named OpenClaw tools under the MCP prefix and pins native tools", () => {
    const out = resolveRestrictedExecutionArgs(baseArgs, {
      native: ["Read", "Grep"],
      openClaw: ["exec", "memory_search"],
    });
    expect(out[out.indexOf("--tools") + 1]).toBe("Read,Grep");
    expect(out[out.indexOf("--allowedTools") + 1]).toBe("mcp__openclaw__exec,mcp__openclaw__memory_search");
    // openClaw tools present → no blanket mcp__* denial, only the operator's.
    expect(out[out.indexOf("--disallowedTools") + 1]).toBe(
      "Bash(run_in_background:true),CronCreate,Monitor,ScheduleWakeup",
    );
  });

  it("resolvePoolExecutionArgs only rewrites when a cap is present", () => {
    expect(resolvePoolExecutionArgs({ baseArgs })).toBe(baseArgs);
    expect(resolvePoolExecutionArgs({ baseArgs, toolAvailability: { native: [], openClaw: [] } })).toContain("--tools");
  });
});

describe("stripClaudeArgs", () => {
  it("handles --flag=value, single-value and variadic forms", () => {
    const out = stripClaudeArgs(["--settings=x", "--add-dir", "a", "b", "--permission-mode", "plan", "keep", "--ide"], {
      bare: new Set(["--ide"]),
      variadicValue: new Set(["--add-dir"]),
      value: new Set(["--settings", "--permission-mode"]),
    });
    expect(out).toEqual(["keep"]);
  });
});
