/**
 * Self-heal the scheduled eviction watchdog after an update (shared by
 * `multi-clawd update`). The npm install dir is regenerated on every update,
 * so a unit pointing into it just orphaned; and a unit must serve the OpenClaw
 * instance this process runs for (#116): this instance's launcher, with this
 * instance's OPENCLAW_* variables pinned. The launcher reads those variables,
 * not its own path, so a unit that runs the right file with the wrong (or no)
 * pin scans another instance and no-ops.
 *
 * Every existing unit is planned by watchdog-schedule#planWatchdogUnit: kept
 * (launcher content refreshed), repointed (path swap, operator text kept) or
 * rewritten (rendered afresh with the pin; the old unit is kept as a .bak).
 * Never fatal: doctor still reports the truth afterwards.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openclawInstanceEnv, WATCHDOG_LAUNCHER } from "./_shared.mjs";

/**
 * @param wds the built watchdog-schedule module (dist/watchdog-schedule.js)
 * @returns the unit files that were changed
 */
export function healWatchdogUnits(wds, { log = console.log } = {}) {
  const changed = [];
  const env = openclawInstanceEnv();
  const pins = Object.keys(env).sort();
  const refreshLauncher = () => {
    mkdirSync(dirname(WATCHDOG_LAUNCHER), { recursive: true });
    writeFileSync(WATCHDOG_LAUNCHER, wds.renderWatchdogLauncher());
  };
  for (const [platform, d] of [
    ["darwin", join(homedir(), "Library", "LaunchAgents")],
    ["linux", join(homedir(), ".config", "systemd", "user")],
  ]) {
    let files = [];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      // Only live unit files: a *.bak-… copy is inert and must never be
      // "repaired" in place of the real unit.
      if (!/\.(plist|service|timer)$/.test(f)) continue;
      const file = join(d, f);
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const target = wds.extractWatchdogTarget(text);
      if (!target) continue;
      let plan;
      try {
        plan = wds.planWatchdogUnit({
          platform,
          unitText: text,
          target,
          launcher: WATCHDOG_LAUNCHER,
          env,
          nodePath: process.execPath,
          exists: existsSync,
        });
      } catch (err) {
        // A path or pinned value that cannot be written into a unit file: leave
        // this unit alone; doctor reports it.
        log(`  ⚠ watchdog unit ${f} left unchanged — ${err?.message ?? err}`);
        continue;
      }
      refreshLauncher();
      if (plan.action === "keep") continue;
      if (plan.action === "rewrite") {
        copyFileSync(file, `${file}.bak-update-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      }
      writeFileSync(file, plan.content);
      changed.push(file);
      if (platform === "darwin") {
        // Direct spawns, not a `sh -c` string: no quoting to get wrong and
        // no shell for a path to break out of. Both calls are best-effort —
        // unload fails harmlessly when nothing is loaded yet.
        spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
        spawnSync("launchctl", ["load", file], { stdio: "ignore" });
      } else {
        try {
          execFileSync("systemctl", ["--user", "daemon-reload"]);
        } catch {
          /* manual reload needed */
        }
      }
      log(
        `  🔧 watchdog unit ${f} → stable launcher${pins.length ? ` for this instance (pins ${pins.join(", ")})` : " (survives future updates)"}`,
      );
    }
  }
  return changed;
}
