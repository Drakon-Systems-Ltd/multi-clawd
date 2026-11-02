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

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** systemd `Environment="K=V"` quoting: backslash and double quote are escaped. */
function systemdEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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
  /**
   * Instance variables to pin (#116): OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH
   * and OPENCLAW_HOME as resolved by openclaw-paths#openclawInstanceEnv. A
   * scheduler starts the unit with its own environment, so without these a
   * watchdog set up for a relocated instance would act on the default one.
   * Absent or empty for the default instance: the unit text is unchanged.
   */
  env?: Record<string, string>;
}): UnitFile[] {
  const pinned = Object.entries(opts.env ?? {}).filter(([, v]) => v !== "").sort(([a], [b]) => a.localeCompare(b));
  if (opts.platform === "darwin") {
    const envDict = pinned.length === 0 ? "" : `  <key>EnvironmentVariables</key>
  <dict>
${pinned.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join("\n")}
  </dict>
`;
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
${envDict}  <key>StartInterval</key>
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
${pinned.map(([k, v]) => `Environment="${k}=${systemdEscape(v)}"\n`).join("")}ExecStart=${opts.nodePath} ${opts.scriptPath}
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
  // Any `npm/projects` tree, not only `~/.openclaw/...`: a relocated state
  // dir (OPENCLAW_STATE_DIR, #116) regenerates its installs the same way.
  return /[\\/]npm[\\/]projects[\\/]/.test(target);
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
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Same instance selection as the plugin and CLI (openclaw-paths): the state
// dir is OPENCLAW_STATE_DIR, else <OPENCLAW_HOME or home>/.openclaw. The unit
// that runs this pins those variables for a non-default instance.
const pick = (name) => {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const expand = (p, home) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : resolve(p));
const OC_HOME = pick("OPENCLAW_HOME");
const HOME = OC_HOME ? expand(OC_HOME, homedir()) : homedir();
const OC_STATE = pick("OPENCLAW_STATE_DIR");
const STATE_DIR = OC_STATE ? expand(OC_STATE, HOME) : join(HOME, ".openclaw");

function installDir() {
  const ext = join(STATE_DIR, "extensions", "multi-clawd");
  if (existsSync(join(ext, "openclaw.plugin.json"))) return ext;
  const projects = join(STATE_DIR, "npm", "projects");
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
  console.error("[watchdog-launcher] no multi-clawd install found under " + STATE_DIR + " — nothing to do");
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
