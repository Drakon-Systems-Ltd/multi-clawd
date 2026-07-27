import { describe, expect, test } from "vitest";
import {
  compareVersions,
  decideUpdateAction,
  formatUpdateBanner,
  classifyCliSkew,
  detectCliInstallKind,
  cliUpdateCommand,
  formatCliSkew,
} from "../src/update-core";

describe("compareVersions", () => {
  test("orders semver triplets numerically, not lexically", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0); // lexical would fail
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("tolerates missing segments (1.2 == 1.2.0)", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("decideUpdateAction", () => {
  test("not installed → install", () => {
    expect(decideUpdateAction({ installed: undefined, latest: "1.1.0" })).toBe("install");
  });

  test("behind latest → update", () => {
    expect(decideUpdateAction({ installed: "1.0.1", latest: "1.1.0" })).toBe("update");
  });

  test("at latest → up-to-date", () => {
    expect(decideUpdateAction({ installed: "1.1.0", latest: "1.1.0" })).toBe("up-to-date");
  });

  test("ahead of latest (dev checkout) → up-to-date, never a downgrade", () => {
    expect(decideUpdateAction({ installed: "1.2.0", latest: "1.1.0" })).toBe("up-to-date");
  });

  test("registry unreachable → unknown (caller offers to reinstall anyway)", () => {
    expect(decideUpdateAction({ installed: "1.1.0", latest: undefined })).toBe("unknown");
  });
});

describe("formatUpdateBanner", () => {
  test("update available names both versions", () => {
    const b = formatUpdateBanner({ installed: "1.0.1", latest: "1.1.0" });
    expect(b).toContain("1.0.1");
    expect(b).toContain("1.1.0");
    expect(b).toMatch(/→/);
  });

  test("up to date says so with the version", () => {
    const b = formatUpdateBanner({ installed: "1.1.0", latest: "1.1.0" });
    expect(b).toMatch(/up to date/i);
    expect(b).toContain("1.1.0");
  });

  test("not installed", () => {
    expect(formatUpdateBanner({ installed: undefined, latest: "1.1.0" })).toMatch(/not installed/i);
  });
});

describe("CLI/plugin version skew", () => {
  const PKG = "@drakon-systems/multi-clawd";

  test("equal versions are aligned; missing plugin is its own case", () => {
    expect(classifyCliSkew({ cliVersion: "1.5.4", pluginVersion: "1.5.4" })).toBe("aligned");
    expect(classifyCliSkew({ cliVersion: "1.5.4", pluginVersion: undefined })).toBe(
      "plugin-missing",
    );
  });

  test("the trap that motivated this: CLI older than plugin", () => {
    // Exactly the state Michael hit — `update` had moved the plugin to 1.5.4
    // while the global CLI sat at 1.5.1, so doctor reported with old logic.
    expect(classifyCliSkew({ cliVersion: "1.5.1", pluginVersion: "1.5.4" })).toBe("cli-behind");
  });

  test("CLI newer than plugin is the opposite, fixable case", () => {
    expect(classifyCliSkew({ cliVersion: "1.6.0", pluginVersion: "1.5.4" })).toBe("cli-ahead");
  });

  test("install kind is derived from the package directory", () => {
    expect(detectCliInstallKind("/home/u/.npm-global/lib/node_modules/@drakon-systems/multi-clawd"))
      .toBe("global");
    expect(detectCliInstallKind("/home/u/.npm/_npx/a1b2/node_modules/@drakon-systems/multi-clawd"))
      .toBe("npx");
    expect(detectCliInstallKind("/home/u/projects/multi-clawd")).toBe("source");
    // Windows-style separators must classify identically.
    expect(detectCliInstallKind("C:\\Users\\u\\AppData\\npm\\node_modules\\multi-clawd")).toBe(
      "global",
    );
  });

  test("each install kind gets the command that actually works for it", () => {
    expect(cliUpdateCommand("global", PKG)).toBe(`npm i -g ${PKG}@latest`);
    expect(cliUpdateCommand("npx", PKG)).toContain("@latest");
    expect(cliUpdateCommand("source", PKG)).toContain("git pull");
  });

  test("aligned installs say nothing at all", () => {
    expect(
      formatCliSkew({
        cliVersion: "1.6.0",
        pluginVersion: "1.6.0",
        installKind: "global",
        pkg: PKG,
      }),
    ).toBeUndefined();
  });

  test("a stale CLI is told the consequence, not just the numbers", () => {
    const msg = formatCliSkew({
      cliVersion: "1.5.1",
      pluginVersion: "1.5.4",
      installKind: "global",
      pkg: PKG,
    });
    expect(msg).toContain("1.5.1");
    expect(msg).toContain("1.5.4");
    expect(msg).toMatch(/doctor/);
    expect(msg).toContain(`npm i -g ${PKG}@latest`);
  });

  test("a stale plugin points at update, not at npm", () => {
    const msg = formatCliSkew({
      cliVersion: "1.6.0",
      pluginVersion: "1.5.4",
      installKind: "global",
      pkg: PKG,
    });
    expect(msg).toContain("multi-clawd update");
    expect(msg).not.toContain("npm i -g");
  });
});
