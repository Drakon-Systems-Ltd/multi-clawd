import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { materialiseRuntime } from "../src/runtime-home";

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake dist: an ESM shim importing a sibling, like the real shim graph. */
function fakeDist(marker: string): string {
  const d = tmp("mc-capture-");
  writeFileSync(join(d, "shim-core.js"), `export const marker = ${JSON.stringify(marker)};\n`);
  writeFileSync(join(d, "shim.js"), `import { marker } from "./shim-core.js";\nconsole.log(marker);\n`);
  return d;
}

describe("materialiseRuntime (issue #31)", () => {
  test("shim still runs after the load directory is deleted", () => {
    const capture = fakeDist("alive");
    const state = tmp("mc-state-");
    const rt = materialiseRuntime(capture, state);
    expect(rt.stable).toBe(true);
    expect(rt.shimPath.startsWith(state)).toBe(true);

    rmSync(capture, { recursive: true, force: true }); // OpenClaw prunes the capture
    expect(existsSync(rt.shimPath)).toBe(true);
    // Runs as ESM from the copy, sibling import included.
    expect(execFileSync(process.execPath, [rt.shimPath], { encoding: "utf8" }).trim()).toBe("alive");
  });

  test("same content maps to the same dir; new content gets a new dir", () => {
    const state = tmp("mc-state-");
    const a = materialiseRuntime(fakeDist("v1"), state);
    const b = materialiseRuntime(fakeDist("v1"), state);
    const c = materialiseRuntime(fakeDist("v2"), state);
    expect(b.dir).toBe(a.dir);
    expect(c.dir).not.toBe(a.dir);
    expect(readdirSync(join(state, "runtime")).filter((n) => !n.includes("staging"))).toHaveLength(2);
  });

  test("falls back to the load path, flagged unstable, when the copy fails", () => {
    const capture = fakeDist("x");
    const blocker = join(tmp("mc-state-"), "not-a-dir");
    writeFileSync(blocker, "file where the state dir should be");
    const rt = materialiseRuntime(capture, blocker);
    expect(rt.stable).toBe(false);
    expect(rt.shimPath).toBe(join(capture, "shim.js"));
    expect(rt.error).toBeTruthy();
  });

  test("refuses a dist without shim.js", () => {
    const d = tmp("mc-capture-");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "index.js"), "export {};\n");
    expect(materialiseRuntime(d, tmp("mc-state-")).stable).toBe(false);
  });
});
