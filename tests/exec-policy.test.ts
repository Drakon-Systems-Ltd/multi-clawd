import { describe, expect, test } from "vitest";
import { resolveExecMode, permissionModeArgs } from "../src/exec-policy";

describe("permissionModeArgs", () => {
  test("injects bypassPermissions ONLY under a full exec policy", () => {
    expect(permissionModeArgs("full")).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  test("emits nothing for a restrictive or non-full mode (never override a stricter policy)", () => {
    expect(permissionModeArgs("ask")).toEqual([]);
    expect(permissionModeArgs("read-only")).toEqual([]);
    expect(permissionModeArgs("deny")).toEqual([]);
  });

  test("emits nothing when the mode is absent (no policy read → fail safe, not bypass)", () => {
    expect(permissionModeArgs(undefined)).toEqual([]);
  });
});

describe("resolveExecMode", () => {
  test("reads tools.exec.mode from an openclaw config object", () => {
    expect(resolveExecMode({ tools: { exec: { mode: "full" } } })).toBe("full");
    expect(resolveExecMode({ tools: { exec: { mode: "ask" } } })).toBe("ask");
  });

  test("returns undefined when the key is missing at any level (tolerant, never throws)", () => {
    expect(resolveExecMode(undefined)).toBeUndefined();
    expect(resolveExecMode(null)).toBeUndefined();
    expect(resolveExecMode({})).toBeUndefined();
    expect(resolveExecMode({ tools: {} })).toBeUndefined();
    expect(resolveExecMode({ tools: { exec: {} } })).toBeUndefined();
    expect(resolveExecMode({ tools: null })).toBeUndefined();
    expect(resolveExecMode({ tools: { exec: { mode: 42 } } })).toBeUndefined();
  });
});
