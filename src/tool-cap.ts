/**
 * Exact per-run tool cap for the pooled Claude Code backend.
 *
 * OpenClaw 2026.8.2 refuses to launch a CLI backend for any run that carries a
 * tool policy — every isolated cron job, every `disableTools` side run — unless
 * the backend declares `nativeToolMode: "selectable"`, names an enforcement
 * strategy, and can rewrite argv so Claude Code honours the cap. Otherwise it
 * fails closed: `CLI backend "clawd" cannot enforce this run's tool cap`. On
 * 3 Sep 2026 that took out rung 1 of every cron chain on the box (31 runs by
 * mid-afternoon) and the heartbeat with it.
 *
 * The bundled `claude-cli` backend does this in core
 * (`resolveClaudeCliRestrictedExecutionArgs` in `dist/cli-shared-*.js`). That
 * helper is not exported through the plugin SDK, so this is a faithful port.
 * Keep it in lockstep with the installed gateway's copy — same strip sets, same
 * appended flags, same denial merge — so a capped run behaves identically
 * whether it lands on the bundled backend or on this pool.
 *
 * OpenClaw 2026.10.10 and 2026.11.1 add a second contract on the same hook:
 * host-owned tools (#136). The bundled backend declares
 * `hostOwnedTools: ["exec", "process"]`; on a normal chat turn core routes
 * those through OpenClaw's own `exec`/`process` tools (approval and allowlist
 * policy included), passes the list to `resolveExecutionArgs`, and the bundled
 * resolver (`resolveClaudeCliExecutionArgs`) appends `Bash` to
 * `--disallowedTools` so Claude Code cannot run shell commands natively; core's
 * native-tool hook denies the equivalent as a backstop. Core only sets the field
 * when the backend is `selectable` + `execution-args` with a resolver, the exec
 * host is not `node` and the run carries no exact cap, so exact caps and older
 * gateways (2026.8.x has no such field) never see it. Same port discipline:
 * the denial step below mirrors the bundled one byte-for-byte.
 *
 * Side-questions (#142). The pool declares `sideQuestionToolMode: "disabled"`
 * and core trusts it: no empty cap is injected for a side-question, and a
 * `disableTools` side run is accepted on this selectable backend. The bundled
 * resolver honours the declaration with `resolveClaudeCliSideQuestionExecutionArgs`
 * (identical on 2026.8.1 and 2026.11.1): strip session / resume / fork / effort /
 * tool / MCP-config flags and append a fixed tool-free, single-turn,
 * non-persistent tail under the default permission mode. Ported below and run
 * in the bundled order: host-owned denial, side-question projection, exact cap.
 */

/** The bundled backend's host-owned set on OpenClaw 2026.10.10 and 2026.11.1 (`extensions/anthropic/cli-backend.ts`). */
export const POOL_HOST_OWNED_TOOLS: readonly string[] = Object.freeze(["exec", "process"]);

export type ToolAvailability = {
  native: readonly string[];
  /** Canonical OpenClaw tool names served through the host-isolated MCP transport. */
  openClaw: readonly string[];
};

export const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

const TOOLS_ARG = "--tools";
const ALLOWED_TOOLS_ARG = "--allowedTools";
const DISALLOWED_TOOLS_ARG = "--disallowedTools";
const SETTING_SOURCES_ARG = "--setting-sources";
const SETTINGS_ARG = "--settings";
const DISABLE_SLASH_COMMANDS_ARG = "--disable-slash-commands";
const NO_CHROME_ARG = "--no-chrome";
const STRICT_MCP_CONFIG_ARG = "--strict-mcp-config";
const DENY_MCP_TOOLS_VALUE = "mcp__*";
const PERMISSION_MODE_ARG = "--permission-mode";
const BYPASS_PERMISSIONS_MODE = "bypassPermissions";
const SAFE_MODE_ARG = "--safe-mode";
const BARE_ARG = "--bare";
const EFFORT_ARG = "--effort";
const MAX_TURNS_ARG = "--max-turns";
const NO_SESSION_PERSISTENCE_ARG = "--no-session-persistence";

/** Mirrors core's CLAUDE_RESTRICTED_SETTINGS byte-for-byte (key order matters for the guard tests). */
export const RESTRICTED_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  enabledPlugins: {},
  autoMemoryEnabled: false,
  claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
});

/** Flags whose (possibly several) values are dropped along with the flag. */
const RESTRICTED_VARIADIC_VALUE_ARGS = new Set([
  TOOLS_ARG,
  ALLOWED_TOOLS_ARG,
  "--allowed-tools",
  DISALLOWED_TOOLS_ARG,
  "--disallowed-tools",
  "--add-dir",
  "--file",
]);

/** Flags with exactly one value, dropped along with it. */
const RESTRICTED_VALUE_ARGS = new Set([
  "--permission-mode",
  SETTING_SOURCES_ARG,
  SETTINGS_ARG,
  "--agent",
  "--agents",
  "--managed-settings",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
  "--plugin-url",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--append-system-prompt-file",
]);

/** Bare flags dropped outright. */
const RESTRICTED_BARE_ARGS = new Set([
  "--bare",
  "--safe-mode",
  DISABLE_SLASH_COMMANDS_ARG,
  "--chrome",
  NO_CHROME_ARG,
  STRICT_MCP_CONFIG_ARG,
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--ide",
]);

type StripPolicy = {
  bare?: ReadonlySet<string>;
  variadicValue?: ReadonlySet<string>;
  value?: ReadonlySet<string>;
};

/** Port of core `stripClaudeArgs`: drops matching flags (and their values) in `--flag value` or `--flag=value` form. */
export function stripClaudeArgs(args: readonly string[], policy: StripPolicy): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const equalsIndex = arg.indexOf("=");
    const argName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (policy.bare?.has(argName)) continue;
    if (policy.variadicValue?.has(argName)) {
      if (equalsIndex < 0) {
        while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) i += 1;
      }
      continue;
    }
    if (policy.value?.has(argName)) {
      if (equalsIndex < 0) {
        const maybeValue = args[i + 1];
        if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) i += 1;
      }
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

/** Port of core `readClaudeToolDenials`: every value of every `--disallowedTools` flag, in argv order, untrimmed. */
function readToolDenials(baseArgs: readonly string[]): string[] {
  const preserved: string[] = [];
  for (let i = 0; i < baseArgs.length; i += 1) {
    const arg = baseArgs[i] ?? "";
    if (arg === DISALLOWED_TOOLS_ARG || arg === "--disallowed-tools") {
      while (typeof baseArgs[i + 1] === "string" && !baseArgs[i + 1]?.startsWith("-")) {
        i += 1;
        preserved.push(...(baseArgs[i] ?? "").split(","));
      }
    } else if (arg.startsWith(`${DISALLOWED_TOOLS_ARG}=`) || arg.startsWith("--disallowed-tools=")) {
      preserved.push(...arg.slice(arg.indexOf("=") + 1).split(","));
    }
  }
  return preserved;
}

/**
 * Port of core `resolveClaudeCliRestrictedExecutionArgs`. Given the launch
 * argv and the run's exact tool contract, returns argv that:
 *  - strips every tool / settings / permission / prompt flag the operator set,
 *  - disables user settings, hooks, plugins, memory, slash commands and Chrome,
 *  - pins native tools to exactly `availability.native` (empty = none),
 *  - allows exactly the OpenClaw MCP tools named, or denies all MCP tools.
 */
export function resolveRestrictedExecutionArgs(
  baseArgs: readonly string[],
  availability: ToolAvailability,
): string[] {
  const preservedDenials = readToolDenials(baseArgs);
  const normalized = stripClaudeArgs(baseArgs, {
    bare: RESTRICTED_BARE_ARGS,
    variadicValue: RESTRICTED_VARIADIC_VALUE_ARGS,
    value: RESTRICTED_VALUE_ARGS,
  });
  normalized.push(
    SETTING_SOURCES_ARG,
    "",
    SETTINGS_ARG,
    RESTRICTED_SETTINGS,
    DISABLE_SLASH_COMMANDS_ARG,
    NO_CHROME_ARG,
    STRICT_MCP_CONFIG_ARG,
    TOOLS_ARG,
    availability.native.join(","),
  );
  if (availability.openClaw.length > 0) {
    normalized.push(
      ALLOWED_TOOLS_ARG,
      availability.openClaw.map((toolName) => `${OPENCLAW_MCP_TOOL_PREFIX}${toolName}`).join(","),
    );
  }
  const denials = [
    ...new Set([
      ...preservedDenials.map((entry) => entry.trim()).filter(Boolean),
      ...(availability.openClaw.length === 0 ? [DENY_MCP_TOOLS_VALUE] : []),
    ]),
  ].sort();
  if (denials.length > 0) normalized.push(DISALLOWED_TOOLS_ARG, denials.join(","));
  return normalized;
}

/** Denial flags only; the host-owned step replaces them and nothing else. */
const DISALLOWED_TOOLS_ARGS = new Set([DISALLOWED_TOOLS_ARG, "--disallowed-tools"]);

/**
 * Port of the host-owned step at the top of core's `resolveClaudeCliExecutionArgs`
 * (OpenClaw 2026.10.10 / 2026.11.1). When the gateway says `exec` is host-owned
 * for this run, Claude Code's native `Bash` is added to the denial list: every
 * operator denial is kept, in order, `Bash` is appended once, and the rest of
 * the argv is untouched. Any other ownership set (or none) returns `baseArgs`
 * as-is — the bundled resolver keys on `exec` alone, `process` has no native
 * equivalent to disable.
 */
export function resolveHostOwnedExecutionArgs(
  baseArgs: readonly string[],
  hostOwnedTools: readonly string[] | undefined,
): readonly string[] {
  if (!hostOwnedTools?.includes("exec")) return baseArgs;
  return [
    ...stripClaudeArgs(baseArgs, { variadicValue: DISALLOWED_TOOLS_ARGS }),
    DISALLOWED_TOOLS_ARG,
    [...new Set([...readToolDenials(baseArgs), "Bash"])].join(","),
  ];
}

/** Core `CLAUDE_SIDE_QUESTION_VARIADIC_VALUE_ARGS`. */
const SIDE_QUESTION_VARIADIC_VALUE_ARGS = new Set([
  ALLOWED_TOOLS_ARG,
  "--allowed-tools",
  DISALLOWED_TOOLS_ARG,
  "--disallowed-tools",
  TOOLS_ARG,
  "--mcp-config",
]);

/** Core `CLAUDE_SIDE_QUESTION_VALUE_ARGS`. */
const SIDE_QUESTION_VALUE_ARGS = new Set([
  PERMISSION_MODE_ARG,
  "--session-id",
  "--resume",
  "--resume-session-at",
  "-r",
  MAX_TURNS_ARG,
]);

/** Core `CLAUDE_SIDE_QUESTION_BARE_ARGS`. */
const SIDE_QUESTION_BARE_ARGS = new Set([
  "--continue",
  "-c",
  "--fork-session",
  BARE_ARG,
  SAFE_MODE_ARG,
  STRICT_MCP_CONFIG_ARG,
  NO_SESSION_PERSISTENCE_ARG,
]);

/**
 * Port of core `stripClaudeEffortArgs`: drops `--effort` (and its value, when
 * the next arg is a non-blank non-flag) and every `--effort=...`.
 */
function stripEffortArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === EFFORT_ARG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && maybeValue.trim().length > 0 && !maybeValue.startsWith("-")) i += 1;
      continue;
    }
    if (arg.startsWith(`${EFFORT_ARG}=`)) continue;
    normalized.push(arg);
  }
  return normalized;
}

/**
 * Port of core `resolveClaudeCliSideQuestionExecutionArgs`. Drops every flag a
 * side-question must not inherit (session / resume / fork / effort / tool /
 * MCP config / turn limit / permission mode) and appends, in this order:
 * `--safe-mode --tools "" --disallowedTools mcp__* --strict-mcp-config
 * --no-session-persistence --max-turns 1 --permission-mode default`. No native
 * tool is selectable and no MCP tool is reachable, so any host-owned Bash
 * denial before it is subsumed (and, as in core, its denial list replaced).
 */
export function resolveSideQuestionExecutionArgs(baseArgs: readonly string[]): string[] {
  return [
    ...stripClaudeArgs(stripEffortArgs(baseArgs), {
      bare: SIDE_QUESTION_BARE_ARGS,
      variadicValue: SIDE_QUESTION_VARIADIC_VALUE_ARGS,
      value: SIDE_QUESTION_VALUE_ARGS,
    }),
    SAFE_MODE_ARG,
    TOOLS_ARG,
    "",
    DISALLOWED_TOOLS_ARG,
    DENY_MCP_TOOLS_VALUE,
    STRICT_MCP_CONFIG_ARG,
    NO_SESSION_PERSISTENCE_ARG,
    MAX_TURNS_ARG,
    "1",
    PERMISSION_MODE_ARG,
    "default",
  ];
}

/**
 * A native control operation (manual `/compact`, #159) does not run under
 * `bypassPermissions`. OpenClaw 2026.11.2 marks the run with
 * `controlOperation: "compact"`, and the bundled resolver then leaves out the
 * `--permission-mode bypassPermissions` it injects for a full-exec turn
 * (`normalizeClaudeBackendArgs`); a mode the operator set explicitly is kept.
 * The pool's equivalent injection is baked into its argv
 * (`permissionModeArgs`), so exactly that pair is dropped here, in either
 * spelling, and any other mode is left alone. Hosts before 2026.11.2 pass no
 * marker; the bundled backend keeps the mode there too, and so does this.
 */
export function resolveControlOperationArgs(baseArgs: readonly string[], controlOperation?: string): readonly string[] {
  if (controlOperation !== "compact") return baseArgs;
  const out: string[] = [];
  for (let i = 0; i < baseArgs.length; i++) {
    const arg = baseArgs[i]!;
    if (arg === PERMISSION_MODE_ARG && baseArgs[i + 1] === BYPASS_PERMISSIONS_MODE) {
      i++;
      continue;
    }
    if (arg === `${PERMISSION_MODE_ARG}=${BYPASS_PERMISSIONS_MODE}`) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Backend hook body, in the bundled order: host-owned denial first, then the
 * side-question projection (`executionMode === "side-question"`), exact cap
 * last. A chat turn on a gateway that routes `exec` through OpenClaw
 * (2026.10+) loses native Bash and keeps everything else; a chat turn on an
 * older gateway arrives without `hostOwnedTools` and keeps its argv untouched.
 * Runs with an exact `toolAvailability` (cron tool policies, `disableTools`)
 * are rewritten as before; core never pairs them with `hostOwnedTools`, and if
 * it ever did the cap's preserved-denial merge would carry `Bash` exactly as
 * the bundled resolver's does. A side-question (`/btw`, setup probes) is made
 * tool-free on every gateway, whatever the operator argv or exec mode; with a
 * cap as well, the cap rewrites the projected argv exactly as core's does.
 * A control operation first drops the injected `bypassPermissions` mode (above).
 */
export function resolvePoolExecutionArgs(ctx: {
  baseArgs: readonly string[];
  executionMode?: string;
  hostOwnedTools?: readonly string[];
  toolAvailability?: ToolAvailability;
  controlOperation?: string;
}): readonly string[] {
  const baseArgs = resolveHostOwnedExecutionArgs(resolveControlOperationArgs(ctx.baseArgs, ctx.controlOperation), ctx.hostOwnedTools);
  const executionArgs =
    ctx.executionMode === "side-question" ? resolveSideQuestionExecutionArgs(baseArgs) : baseArgs;
  return ctx.toolAvailability
    ? resolveRestrictedExecutionArgs(executionArgs, ctx.toolAvailability)
    : executionArgs;
}
