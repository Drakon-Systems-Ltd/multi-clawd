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
 */

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

/** Denials the operator authored in the base argv survive the rewrite (core preserves them too). */
function collectPreservedDenials(baseArgs: readonly string[]): string[] {
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
  const preservedDenials = collectPreservedDenials(baseArgs);
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

/**
 * Backend hook body. Uncapped runs keep their argv untouched — the pool's
 * full-harness behaviour is unchanged for chat. Only runs that arrive with an
 * exact `toolAvailability` (cron tool policies, `disableTools`) are rewritten.
 */
export function resolvePoolExecutionArgs(ctx: {
  baseArgs: readonly string[];
  toolAvailability?: ToolAvailability;
}): readonly string[] {
  return ctx.toolAvailability
    ? resolveRestrictedExecutionArgs(ctx.baseArgs, ctx.toolAvailability)
    : ctx.baseArgs;
}
