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
import { join } from "node:path";

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
