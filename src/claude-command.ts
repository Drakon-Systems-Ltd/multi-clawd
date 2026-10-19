/**
 * Which `claude` executable this plugin runs — shared by the plugin (at
 * registration) and the shim (at launch), so both answer the question the
 * same way.
 *
 * OpenClaw 2026.10 refuses to mint verified setup authority (the dashboard's
 * setup custodian) for a CLI backend whose `config.command` it cannot bind to
 * one durable absolute owner. A backend whose command is `node` + our shim can
 * never be bound, so the backend's command must be the real Claude Code
 * executable, declared with the same runtime artifact as the bundled
 * `claude-cli` backend. The path kept is the PATH-visible one (for a native
 * install, the `~/.local/bin/claude` symlink rather than the versioned binary
 * it points at): that is what OpenClaw's verifier expects as the invocation
 * name, and it keeps following the installer's updates.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Plugin → shim: the one claude executable this launch may exec. */
export const CLAUDE_BIN_ENV = "MULTI_CLAWD_CLAUDE_BIN";
/** Plugin → shim: the invocation name to preserve for that executable. */
export const CLAUDE_ARGV0_ENV = "MULTI_CLAWD_CLAUDE_ARGV0";

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First executable `name` on PATH, as an absolute path WITHOUT resolving
 * symlinks. Relative and empty PATH entries are skipped: a launch must never
 * depend on the gateway's working directory.
 */
export function findOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = resolve(join(dir, name));
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export type ClaudeBinOverride =
  | { kind: "path"; value: string }
  | { kind: "argv"; command: string; prependArgs: string[] };

/**
 * `MULTI_CLAWD_CLAUDE_BIN` is either a plain path or a JSON argv array
 * (`["/usr/bin/node", "/path/cli.js"]`) for an interpreter-launched CLI.
 */
export function parseClaudeBinOverride(raw: string | undefined): ClaudeBinOverride | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((p) => typeof p === "string" && p.length > 0)
    ) {
      const [command, ...prependArgs] = parsed as string[];
      return { kind: "argv", command, prependArgs };
    }
  } catch {
    // not JSON — a plain path
  }
  return { kind: "path", value: raw };
}

/**
 * Resolve one override entry to an absolute executable, or undefined. A bare
 * name is looked up on PATH; anything with a separator must be absolute.
 */
export function resolveExecutable(command: string, pathValue: string | undefined): string | undefined {
  if (!command.includes("/") && !command.includes("\\")) return findOnPath(command, pathValue);
  if (!isAbsolute(command)) return undefined;
  const absolute = resolve(command);
  return isExecutableFile(absolute) ? absolute : undefined;
}

export type ClaudeExecutableResolution =
  | { ok: true; command: string; source: "override" | "path" }
  | { ok: false; reason: string };

/**
 * The claude executable a verified backend can declare as its command.
 * Honours an operator `MULTI_CLAWD_CLAUDE_BIN` exactly as the shim always has;
 * an interpreter-form override cannot be one bindable command, so it is
 * reported unresolvable (the caller keeps the legacy shim launch for it).
 */
export function resolveClaudeExecutable(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): ClaudeExecutableResolution {
  if (platform === "win32") {
    return { ok: false, reason: "verified launch is not implemented on Windows" };
  }
  const override = parseClaudeBinOverride(env[CLAUDE_BIN_ENV]);
  if (override) {
    if (override.kind === "argv" && override.prependArgs.length > 0) {
      return { ok: false, reason: `${CLAUDE_BIN_ENV} is an interpreter argv, not one executable` };
    }
    const raw = override.kind === "argv" ? override.command : override.value;
    const command = resolveExecutable(raw, env.PATH);
    return command
      ? { ok: true, command, source: "override" }
      : { ok: false, reason: `${CLAUDE_BIN_ENV}=${raw} is not an executable file` };
  }
  const command = findOnPath("claude", env.PATH);
  return command
    ? { ok: true, command, source: "path" }
    : { ok: false, reason: "no executable `claude` on the gateway's PATH" };
}
