/**
 * #136 — host-owned exec/process on the pool.
 *
 * OpenClaw 2026.10.10 and 2026.11.1 route `exec`/`process` through OpenClaw's
 * own tools for a normal chat turn when the backend declares
 * `hostOwnedTools: ["exec", "process"]` (bundled `claude-cli` does), and the
 * bundled argv resolver then appends `Bash` to `--disallowedTools` so Claude
 * Code cannot run shell commands natively. Without the declaration the same
 * turn on the pool kept Claude Code's own Bash under the permission mode
 * derived from `tools.exec.mode` — a silent approval-policy divergence. Core
 * only hands the field to the resolver on a normal turn (`selectable` +
 * `execution-args` + a resolver, exec host != node, no exact cap); an exact
 * cap or an older gateway never sets it, so those paths must be unchanged.
 */
import { describe, expect, it } from "vitest";
import { buildBackend } from "../src/index.js";
import { POOL_HOST_OWNED_TOOLS, resolvePoolExecutionArgs } from "../src/tool-cap.js";

const account = { id: "claw2", configDir: "/tmp/claw2" };

type ResolveCtx = Parameters<NonNullable<ReturnType<typeof buildBackend>["resolveExecutionArgs"]>>[0];

/** Build the hook context the gateway passes; extra fields mirror the 2026.11.1 shape. */
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

/** Values following the (single) `--disallowedTools` flag, or null when the flag is absent. */
function disallowed(args: readonly string[]): string[] | null {
  const hits = args.map((a, i) => (a === "--disallowedTools" ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return null;
  expect(hits).toHaveLength(1);
  return (args[hits[0]! + 1] ?? "").split(",");
}

describe("backend declares the bundled host-owned tool set", () => {
  it("declares exactly exec and process, as the bundled claude-cli backend does on 2026.10.10 / 2026.11.1", () => {
    const backend = buildBackend(account) as { hostOwnedTools?: readonly string[] };
    expect(backend.hostOwnedTools).toEqual(["exec", "process"]);
    expect(POOL_HOST_OWNED_TOOLS).toEqual(["exec", "process"]);
  });

  it("keeps the three declarations core requires before it honours hostOwnedTools", () => {
    const backend = buildBackend(account);
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.toolAvailabilityEnforcement).toBe("execution-args");
    expect(typeof backend.resolveExecutionArgs).toBe("function");
  });
});

describe("normal turn with host-owned exec", () => {
  it("appends Bash to the operator denials and leaves every other flag in place", () => {
    const backend = buildBackend(account, "full");
    const baseArgs = [...backend.config.args];
    const before = disallowed(baseArgs)!;
    expect(before).not.toContain("Bash");

    const out = backend.resolveExecutionArgs!(ctx(baseArgs, { hostOwnedTools: ["exec", "process"] }));
    expect(disallowed(out)).toEqual([...before, "Bash"]);
    // Only the denial list moved; the rest of the argv is byte-identical.
    const strip = (a: readonly string[]) => {
      const i = a.indexOf("--disallowedTools");
      return [...a.slice(0, i), ...a.slice(i + 2)];
    };
    expect(strip(out)).toEqual(strip(baseArgs));
    expect(out).toContain("--permission-mode");
    expect(out).toContain("bypassPermissions");
    expect(out[0]).toBe(baseArgs[0]);
  });

  it("merges several denial flags, both spellings and the = form, and never duplicates Bash", () => {
    const baseArgs = [
      "/shim.js",
      "-p",
      "--disallowedTools",
      "ScheduleWakeup,Bash",
      "--disallowed-tools=CronCreate",
      "--disallowedTools",
      "Monitor",
      "--output-format",
      "stream-json",
    ];
    const out = resolvePoolExecutionArgs({ baseArgs, hostOwnedTools: ["exec"] });
    expect(out).toEqual([
      "/shim.js",
      "-p",
      "--output-format",
      "stream-json",
      "--disallowedTools",
      "ScheduleWakeup,Bash,CronCreate,Monitor",
    ]);
  });

  it("adds a denial list when the operator argv had none", () => {
    const out = resolvePoolExecutionArgs({ baseArgs: ["/shim.js", "-p"], hostOwnedTools: ["exec", "process"] });
    expect(out).toEqual(["/shim.js", "-p", "--disallowedTools", "Bash"]);
  });

  it("only exec ownership disables Bash; process alone changes nothing (bundled keys on exec)", () => {
    const baseArgs = ["/shim.js", "-p", "--disallowedTools", "Monitor"];
    expect(resolvePoolExecutionArgs({ baseArgs, hostOwnedTools: ["process"] })).toBe(baseArgs);
    expect(resolvePoolExecutionArgs({ baseArgs, hostOwnedTools: [] })).toBe(baseArgs);
  });
});

describe("paths core never hands hostOwnedTools to stay as they were", () => {
  const baseArgs = ["/shim.js", "-p", "--disallowedTools", "Monitor", "--permission-mode", "bypassPermissions"];

  it("an older gateway (no field in the context) leaves a chat turn untouched", () => {
    const backend = buildBackend(account);
    const args = [...backend.config.args];
    expect(backend.resolveExecutionArgs!(ctx(args))).toEqual(args);
    expect(disallowed(backend.resolveExecutionArgs!(ctx(args)) as string[])).not.toContain("Bash");
  });

  it("an exact cap (core sets no hostOwnedTools) pins tools and preserves operator denials without adding Bash", () => {
    const out = resolvePoolExecutionArgs({ baseArgs, toolAvailability: { native: ["Read"], openClaw: ["exec"] } });
    expect(out).toContain("--tools");
    expect(out[out.indexOf("--tools") + 1]).toBe("Read");
    expect(out).toContain("--allowedTools");
    expect(out[out.indexOf("--allowedTools") + 1]).toBe("mcp__openclaw__exec");
    expect(disallowed(out)).toEqual(["Monitor"]);
    expect(out).not.toContain("bypassPermissions");
  });

  it("a side question without the field is untouched", () => {
    const backend = buildBackend(account);
    expect(backend.resolveExecutionArgs!(ctx(baseArgs, { executionMode: "side-question" }))).toEqual(baseArgs);
  });

  it("a side question receiving host-owned exec also denies Bash", () => {
    const backend = buildBackend(account);
    const out = backend.resolveExecutionArgs!(ctx(baseArgs, {
      executionMode: "side-question",
      hostOwnedTools: ["exec", "process"],
    })) as string[];
    expect(disallowed(out)).toEqual(["Monitor", "Bash"]);
    expect(out).toContain("bypassPermissions"); // Full tool-free projection remains #142.
  });

  it("if both an exact cap and the field ever arrive together, the result matches the bundled order (Bash lands in the sorted cap denials)", () => {
    const out = resolvePoolExecutionArgs({
      baseArgs,
      hostOwnedTools: ["exec", "process"],
      toolAvailability: { native: [], openClaw: [] },
    });
    expect(disallowed(out)).toEqual(["Bash", "Monitor", "mcp__*"]);
    expect(out[out.indexOf("--tools") + 1]).toBe("");
  });
});
