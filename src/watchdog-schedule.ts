/**
 * Pure logic for scheduling (and repairing) the eviction watchdog from the
 * setup wizard.
 *
 * The trap this closes: the watchdog is an OS-scheduled unit pointing at
 * scripts/eviction-watchdog.mjs INSIDE an install directory — and installs
 * move (a path install replaced by a registry install, an uninstall/
 * reinstall). When the directory goes, the unit keeps firing against a
 * missing script and the safety net dies silently. The wizard therefore owns
 * the unit: it creates it against the current install, and detects+repairs an
 * orphaned one whose target no longer exists.
 */

export const WATCHDOG_LAUNCHD_LABEL = "com.multi-clawd.eviction-watchdog";
export const WATCHDOG_SYSTEMD_NAME = "multi-clawd-eviction-watchdog";

export interface UnitFile {
  /** Path relative to the user's home directory. */
  path: string;
  content: string;
}

/** Render the scheduler unit file(s) for this platform; [] = unsupported. */
export function renderWatchdogUnit(opts: {
  platform: string;
  nodePath: string;
  scriptPath: string;
}): UnitFile[] {
  if (opts.platform === "darwin") {
    return [
      {
        path: `Library/LaunchAgents/${WATCHDOG_LAUNCHD_LABEL}.plist`,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`,
      },
    ];
  }
  if (opts.platform === "linux") {
    return [
      {
        path: `.config/systemd/user/${WATCHDOG_SYSTEMD_NAME}.service`,
        content: `[Unit]
Description=multi-clawd eviction watchdog (turn-safe; openclaw#107408 mitigation)

[Service]
Type=oneshot
ExecStart=${opts.nodePath} ${opts.scriptPath}
`,
      },
      {
        path: `.config/systemd/user/${WATCHDOG_SYSTEMD_NAME}.timer`,
        content: `[Unit]
Description=Run the multi-clawd eviction watchdog every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`,
      },
    ];
  }
  return [];
}

/**
 * Pull the eviction-watchdog script path out of an existing unit's text
 * (launchd plist or systemd unit). Undefined when the text does not
 * reference the watchdog at all.
 */
export function extractWatchdogTarget(unitText: string): string | undefined {
  const m = unitText.match(/[^<>\s="']*(?:eviction-watchdog|watchdog-launcher)\.mjs/);
  return m ? m[0] : undefined;
}

export type WatchdogUnitState = "ok" | "orphaned" | "absent";

/** Classify an existing unit's health from its extracted target path. */
export function classifyWatchdogUnit(
  targetPath: string | undefined,
  exists: (p: string) => boolean,
): WatchdogUnitState {
  if (targetPath === undefined) return "absent";
  return exists(targetPath) ? "ok" : "orphaned";
}

/**
 * A scheduled unit must never point INTO the npm install: OpenClaw
 * regenerates that directory on every update, orphaning the unit each time.
 */
export function isFragileWatchdogTarget(target: string): boolean {
  return target.includes("/.openclaw/npm/projects/");
}

/**
 * The stable launcher a unit points at instead: written once to the state
 * dir, it resolves the CURRENT install at runtime and runs its watchdog —
 * so updates can move the install freely without touching the unit.
 * Self-contained by design: node built-ins only, no package imports.
 */
export function renderWatchdogLauncher(): string {
  return `#!/usr/bin/env node
// multi-clawd watchdog launcher — the STABLE target for scheduler units.
// Installs move on every update (the npm project dir is regenerated), so the
// unit points HERE; this launcher finds the current install at runtime and
// runs its eviction watchdog. Managed by the setup wizard / update command.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOME = homedir();

function installDir() {
  const ext = join(HOME, ".openclaw", "extensions", "multi-clawd");
  if (existsSync(join(ext, "openclaw.plugin.json"))) return ext;
  const projects = join(HOME, ".openclaw", "npm", "projects");
  let best;
  let bestM = -1;
  try {
    for (const p of readdirSync(projects)) {
      if (!p.startsWith("drakon-systems-multi-clawd-")) continue;
      const dir = join(projects, p, "node_modules", "@drakon-systems", "multi-clawd");
      const manifest = join(dir, "openclaw.plugin.json");
      if (!existsSync(manifest)) continue;
      const t = statSync(manifest).mtimeMs;
      if (t > bestM) { bestM = t; best = dir; }
    }
  } catch {}
  return best;
}

const dir = installDir();
if (!dir) {
  console.error("[watchdog-launcher] no multi-clawd install found — nothing to do");
  process.exit(0);
}
const script = join(dir, "scripts", "eviction-watchdog.mjs");
if (!existsSync(script)) {
  console.error("[watchdog-launcher] " + script + " missing — nothing to do");
  process.exit(0);
}
const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exit(r.status ?? 0);
`;
}
