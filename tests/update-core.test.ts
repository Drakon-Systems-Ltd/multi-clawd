import { describe, expect, test } from "vitest";
import { compareVersions, decideUpdateAction, formatUpdateBanner } from "../src/update-core";

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
