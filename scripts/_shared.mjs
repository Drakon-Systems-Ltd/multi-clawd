/**
 * Shared helpers for the CLI scripts (cli.mjs, setup.mjs).
 *
 * Two real footguns shaped this file: run via `npx`, a script's __dirname is
 * the EPHEMERAL npx cache; and the npm install dir itself is regenerated on
 * every update. So nothing durable (scheduler units) may point at either —
 * they point at the stable WATCHDOG_LAUNCHER, which resolves the current
 * install at runtime.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the plugin is installed: path install wins, else newest npm-project install. */
export function resolveInstallDir() {
  const HOME = homedir();
  const extDir = join(HOME, ".openclaw", "extensions", "multi-clawd");
  if (existsSync(join(extDir, "openclaw.plugin.json"))) return extDir;
  const projects = join(HOME, ".openclaw", "npm", "projects");
  let best;
  let bestM = -1;
  try {
    for (const p of readdirSync(projects)) {
      if (!p.startsWith("drakon-systems-multi-clawd-")) continue;
      const dir = join(projects, p, "node_modules", "@drakon-systems", "multi-clawd");
      const manifest = join(dir, "openclaw.plugin.json");
      if (!existsSync(manifest)) continue;
      const m = statSync(manifest).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = dir;
      }
    }
  } catch {
    /* no npm projects dir */
  }
  return best;
}

/**
 * The stable launcher path scheduler units point at. Lives in the state dir
 * (never moved by installs); its content is rendered by
 * watchdog-schedule.ts#renderWatchdogLauncher and resolves the current
 * install at runtime.
 */
export const WATCHDOG_LAUNCHER = join(
  homedir(),
  ".openclaw",
  "state",
  "multi-clawd",
  "watchdog-launcher.mjs",
);

/** The default OpenClaw config path, resolved for display (never a literal `~`). */
export function openclawConfigPath() {
  return join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * One diagnostic for every command that needs the OpenClaw config (#106).
 *
 * `error` is whatever reading or parsing threw. The message names the resolved
 * path and the next step, and keeps the real causes apart: the file is missing
 * (and whether OpenClaw itself looks installed), it is unreadable for this
 * user, it is not a regular file, or it is present but not valid JSON. It never
 * repeats raw Node error text: an fs message is noise to a first-time user, and
 * a JSON SyntaxError quotes a slice of the file, which may hold credentials.
 *
 * A `configPath` other than the default (hermes `--config`) gets a "check the
 * path" step instead of `multi-clawd setup`, which only writes the default;
 * that split applies to the missing and the not-a-regular-file cases alike.
 */
export function describeOpenclawConfigError(error, configPath = openclawConfigPath()) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  const isDefault = configPath === openclawConfigPath();
  const at = `OpenClaw config at ${configPath}`;
  if (code === "ENOENT") {
    const dir = dirname(configPath);
    if (isDefault && !existsSync(dir)) {
      return `OpenClaw config not found at ${configPath} (no ${dir} directory). ` +
        "Install and start OpenClaw first, then run `multi-clawd setup`.";
    }
    return `OpenClaw config not found at ${configPath}. ` + (isDefault
      ? "Run `multi-clawd setup` to create it."
      : "Check the --config path, or omit it to use the default location.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return `${at} is not readable: permission denied. Run multi-clawd as the user that ` +
      "owns the OpenClaw install, or fix the file's ownership and mode; `multi-clawd setup` cannot fix this.";
  }
  const notRegular = { EISDIR: "it is a directory", ELOOP: "it is a symbolic-link loop",
    ENOTDIR: "a parent in the path is not a directory" }[code];
  if (notRegular) {
    // `multi-clawd setup` writes only the default path, so for a custom
    // `--config` the fix is the named path (or the option), never setup.
    return `${at} is not a regular file (${notRegular}). ` + (isDefault
      ? "Move whatever is at that path aside, then run `multi-clawd setup` or restore the OpenClaw config file."
      : "Restore the OpenClaw config file at that path, or correct the --config path (omit it to use the " +
        "default location); `multi-clawd setup` only writes the default path.");
  }
  if (error instanceof SyntaxError) {
    return `${at} is malformed JSON. Fix the file by hand (a JSON validator helps) and retry; ` +
      "`multi-clawd setup` does not repair it.";
  }
  return `${at} could not be read${code ? ` (${code})` : ""}.`;
}
