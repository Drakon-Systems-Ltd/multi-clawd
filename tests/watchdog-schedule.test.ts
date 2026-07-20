import { describe, expect, test } from "vitest";
import {
  renderWatchdogUnit,
  renderWatchdogLauncher,
  extractWatchdogTarget,
  classifyWatchdogUnit,
  isFragileWatchdogTarget,
  WATCHDOG_LAUNCHD_LABEL,
  WATCHDOG_SYSTEMD_NAME,
} from "../src/watchdog-schedule";

const NODE = "/usr/bin/node";
const SCRIPT = "/home/user/multi-clawd/scripts/eviction-watchdog.mjs";

describe("renderWatchdogUnit", () => {
  test("darwin: launchd plist with 5-min interval, node + script argv", () => {
    const files = renderWatchdogUnit({ platform: "darwin", nodePath: NODE, scriptPath: SCRIPT });
    expect(files).toHaveLength(1);
    const [plist] = files;
    expect(plist.path).toContain(`${WATCHDOG_LAUNCHD_LABEL}.plist`);
    expect(plist.content).toContain(`<string>${WATCHDOG_LAUNCHD_LABEL}</string>`);
    expect(plist.content).toContain(`<string>${NODE}</string>`);
    expect(plist.content).toContain(`<string>${SCRIPT}</string>`);
    expect(plist.content).toContain("<key>StartInterval</key>");
    expect(plist.content).toContain("<integer>300</integer>");
  });

  test("linux: systemd user service + timer pair", () => {
    const files = renderWatchdogUnit({ platform: "linux", nodePath: NODE, scriptPath: SCRIPT });
    expect(files).toHaveLength(2);
    const service = files.find((f) => f.path.endsWith(".service"));
    const timer = files.find((f) => f.path.endsWith(".timer"));
    expect(service?.path).toContain(WATCHDOG_SYSTEMD_NAME);
    expect(service?.content).toContain(`ExecStart=${NODE} ${SCRIPT}`);
    expect(timer?.content).toContain("OnUnitActiveSec=5min");
    expect(timer?.content).toContain("OnBootSec=2min");
  });

  test("unsupported platform: empty (caller skips with a note)", () => {
    expect(renderWatchdogUnit({ platform: "win32", nodePath: NODE, scriptPath: SCRIPT })).toEqual([]);
  });
});

describe("extractWatchdogTarget", () => {
  test("pulls the script path out of a launchd plist", () => {
    const plist = `<array><string>/opt/node</string><string>/old/install/scripts/eviction-watchdog.mjs</string></array>`;
    expect(extractWatchdogTarget(plist)).toBe("/old/install/scripts/eviction-watchdog.mjs");
  });

  test("pulls the script path out of a systemd ExecStart", () => {
    const unit = `[Service]\nExecStart=/usr/bin/node /home/u/.openclaw/extensions/multi-clawd/scripts/eviction-watchdog.mjs\n`;
    expect(extractWatchdogTarget(unit)).toBe(
      "/home/u/.openclaw/extensions/multi-clawd/scripts/eviction-watchdog.mjs",
    );
  });

  test("undefined when the unit does not reference the watchdog script", () => {
    expect(extractWatchdogTarget("ExecStart=/usr/bin/python3 /x/other.py")).toBeUndefined();
    expect(extractWatchdogTarget("")).toBeUndefined();
  });
});

describe("classifyWatchdogUnit", () => {
  test("healthy: unit exists and its target script exists", () => {
    expect(classifyWatchdogUnit("/a/eviction-watchdog.mjs", () => true)).toBe("ok");
  });

  test("orphaned: unit exists but target script is gone (the migration trap)", () => {
    expect(classifyWatchdogUnit("/gone/eviction-watchdog.mjs", () => false)).toBe("orphaned");
  });

  test("absent: no unit references the watchdog", () => {
    expect(classifyWatchdogUnit(undefined, () => true)).toBe("absent");
  });
});

describe("renderWatchdogLauncher", () => {
  test("self-contained launcher: resolves install at runtime, spawns its watchdog, fail-safe exits", () => {
    const src = renderWatchdogLauncher();
    expect(src).toContain("extensions"); // path-install first
    expect(src).toContain("drakon-systems-multi-clawd-"); // npm-project scan
    expect(src).toContain("eviction-watchdog.mjs");
    expect(src).toContain("spawnSync");
    expect(src).not.toMatch(/from "\.\.?\//); // no package-relative imports — must survive any install layout
    expect(src).toContain('from "node:'); // node built-ins only
  });
});

describe("isFragileWatchdogTarget", () => {
  test("npm project paths are fragile (regenerated on every update)", () => {
    expect(
      isFragileWatchdogTarget(
        "/home/u/.openclaw/npm/projects/drakon-systems-multi-clawd-x/node_modules/@drakon-systems/multi-clawd/scripts/eviction-watchdog.mjs",
      ),
    ).toBe(true);
  });

  test("checkout, extensions, and launcher paths are stable", () => {
    expect(isFragileWatchdogTarget("/home/u/dev/multi-clawd/scripts/eviction-watchdog.mjs")).toBe(false);
    expect(isFragileWatchdogTarget("/home/u/.openclaw/extensions/multi-clawd/scripts/eviction-watchdog.mjs")).toBe(false);
    expect(isFragileWatchdogTarget("/home/u/.openclaw/state/multi-clawd/watchdog-launcher.mjs")).toBe(false);
  });
});

describe("extractWatchdogTarget — launcher-aware", () => {
  test("also extracts a watchdog-launcher.mjs target", () => {
    expect(
      extractWatchdogTarget("ExecStart=/usr/bin/node /home/u/.openclaw/state/multi-clawd/watchdog-launcher.mjs"),
    ).toBe("/home/u/.openclaw/state/multi-clawd/watchdog-launcher.mjs");
  });
});
