/**
 * Permission-mode derivation for the pooled backend argv.
 *
 * OpenClaw core injects `--permission-mode bypassPermissions` for the BUNDLED
 * claude-cli backend when the exec policy is `full` — recognised by provider id,
 * which a plugin-registered backend does not share. Without the flag a headless
 * pool launch boots default-deny and every host tool call (Bash/Write/Edit)
 * locks out against an approval prompt no channel can answer.
 *
 * We mirror core faithfully but conservatively: bypass ONLY under `full`. Any
 * other or absent mode emits nothing, so Claude keeps its default (prompt-
 * honouring) behaviour and a host running a stricter exec policy is never
 * silently overridden into bypass — this backend must never be less safe than
 * the bundled one it mirrors.
 */

/** Extract `tools.exec.mode` from an openclaw config object; undefined if absent. */
export function resolveExecMode(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const tools = (config as { tools?: unknown }).tools;
  if (typeof tools !== "object" || tools === null) return undefined;
  const exec = (tools as { exec?: unknown }).exec;
  if (typeof exec !== "object" || exec === null) return undefined;
  const mode = (exec as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : undefined;
}

/** Argv fragment appended to the backend base args: bypass only under `full`. */
export function permissionModeArgs(execMode: string | undefined): string[] {
  return execMode === "full" ? ["--permission-mode", "bypassPermissions"] : [];
}
