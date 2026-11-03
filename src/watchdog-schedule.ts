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

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** systemd `Environment="K=V"` quoting: backslash and double quote are escaped. */
function systemdEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A unit file is line-oriented (systemd) or element-oriented (plist): a
 * newline or NUL inside an interpolated value would start a second directive
 * (`ExecStart=` twice, a stray `<string>`), so no such value is ever rendered.
 * Paths come from the operator's environment, never from a remote source,
 * which makes refusing the right answer: the unit is not written at all.
 */
function assertUnitSafe(what: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`watchdog unit: ${what} contains a line break or NUL and cannot be written to a scheduler unit`);
  }
}

/** The variables that select an OpenClaw instance; the only ones a unit pins. */
export const OPENCLAW_INSTANCE_KEYS = ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const;

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
  assertUnitSafe("node path", opts.nodePath);
  assertUnitSafe("script path", opts.scriptPath);
  for (const [k, v] of pinned) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`watchdog unit: "${k}" is not a valid environment variable name`);
    assertUnitSafe(`${k} value`, v);
  }
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
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.scriptPath)}</string>
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
 * The OpenClaw instance variables an existing unit pins, read back from its
 * text: systemd `Environment=` assignments (quoted or bare, several per line,
 * C-style escapes inside double quotes) or the launchd `EnvironmentVariables`
 * dict. Only the instance keys are returned; anything else the operator
 * added to the unit is theirs and never compared.
 */
export function extractWatchdogEnv(unitText: string): Record<string, string> {
  const found: Record<string, string> = {};
  const keep = (k: string, v: string) => {
    if ((OPENCLAW_INSTANCE_KEYS as readonly string[]).includes(k)) found[k] = v;
  };
  for (const line of unitText.split(/\r?\n/)) {
    const m = line.match(/^\s*Environment\s*=\s*(.*)$/);
    if (!m) continue;
    for (const token of splitSystemdAssignments(m[1])) {
      const eq = token.indexOf("=");
      if (eq > 0) keep(token.slice(0, eq), token.slice(eq + 1));
    }
  }
  const dict = unitText.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (dict) {
    for (const pair of dict[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      keep(xmlUnescape(pair[1]), xmlUnescape(pair[2]));
    }
  }
  return found;
}

/** `Environment=` value → assignments, honouring systemd's quoting. */
function splitSystemdAssignments(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (/\s/.test(value[i])) {
      i += 1;
      continue;
    }
    let token = "";
    while (i < value.length && !/\s/.test(value[i])) {
      const q = value[i];
      if (q === '"' || q === "'") {
        i += 1;
        while (i < value.length && value[i] !== q) {
          if (q === '"' && value[i] === "\\" && i + 1 < value.length) {
            i += 1;
            token += value[i] === "n" ? "\n" : value[i] === "t" ? "\t" : value[i];
          } else {
            token += value[i];
          }
          i += 1;
        }
        i += 1;
      } else {
        token += q;
        i += 1;
      }
    }
    out.push(token);
  }
  return out;
}

export type WatchdogUnitReason = "orphaned" | "fragile" | "other-launcher" | "instance-env";

export interface WatchdogUnitPlan {
  /** keep = serves this instance already; repoint = swap the script path; rewrite = render the unit afresh. */
  action: "keep" | "repoint" | "rewrite";
  reasons: WatchdogUnitReason[];
  /** New text for the unit file the target was found in (repoint and rewrite). */
  content?: string;
}

/**
 * What to do with an existing watchdog unit so that it serves THIS instance
 * (#116): the unit must run this instance's launcher (not an install path,
 * not another instance's launcher) with exactly this instance's OPENCLAW_*
 * variables pinned. The launcher reads those variables, not its own location,
 * so a unit that runs the right file with the wrong (or no) pin still scans
 * the wrong instance.
 *
 * `repoint` keeps the operator's unit text and swaps the script path: enough
 * when the pinned variables already match. `rewrite` renders the unit anew
 * from `renderWatchdogUnit` when the variables must change, since editing
 * `Environment=` lines or a plist dict in place is not worth the fragility.
 */
export function planWatchdogUnit(opts: {
  platform: string;
  unitText: string;
  target: string;
  launcher: string;
  env: Record<string, string>;
  nodePath: string;
  exists: (p: string) => boolean;
}): WatchdogUnitPlan {
  const reasons: WatchdogUnitReason[] = [];
  if (!opts.exists(opts.target)) reasons.push("orphaned");
  else if (isFragileWatchdogTarget(opts.target)) reasons.push("fragile");
  else if (opts.target !== opts.launcher) reasons.push("other-launcher");
  const want = Object.entries(opts.env).filter(([, v]) => v !== "");
  const have = extractWatchdogEnv(opts.unitText);
  const envMatches =
    want.length === Object.keys(have).length && want.every(([k, v]) => have[k] === v);
  if (!envMatches) reasons.push("instance-env");
  if (reasons.length === 0) return { action: "keep", reasons };
  if (envMatches) {
    return { action: "repoint", reasons, content: opts.unitText.split(opts.target).join(opts.launcher) };
  }
  const [unit] = renderWatchdogUnit({
    platform: opts.platform,
    nodePath: opts.nodePath,
    scriptPath: opts.launcher,
    env: opts.env,
  });
  if (!unit) {
    // Unsupported platform renders nothing; the path swap is still better than
    // a dead unit.
    return { action: "repoint", reasons, content: opts.unitText.split(opts.target).join(opts.launcher) };
  }
  return { action: "rewrite", reasons, content: unit.content };
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
