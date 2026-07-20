/**
 * Shared helpers for the CLI scripts (cli.mjs, setup.mjs).
 *
 * resolveWatchdogScript exists because of a real footgun: run via `npx`, a
 * script's __dirname is the EPHEMERAL npx cache — pointing a scheduled unit
 * there breaks on the next cache clean. The watchdog target must be the
 * INSTALLED plugin's copy whenever one exists; the __dirname sibling is only
 * correct for a source checkout with no install.
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

/** The watchdog script a scheduled unit should point at. */
export function resolveWatchdogScript(fallbackDir) {
  const inst = resolveInstallDir();
  if (inst) {
    const p = join(inst, "scripts", "eviction-watchdog.mjs");
    if (existsSync(p)) return p;
  }
  return join(fallbackDir, "eviction-watchdog.mjs");
}
