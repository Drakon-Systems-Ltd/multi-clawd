/**
 * Guards for the security properties SECURITY.md promises publicly.
 *
 * Documentation drifts silently; these turn each published claim into a
 * failing build when the code stops backing it. Same discipline that now pins
 * the manifest version and the README's release tag.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenFileModeWarning } from "../src/account-env";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("tokenFileModeWarning", () => {
  test("0600 and 0400 are clean — no warning", () => {
    expect(tokenFileModeWarning("/t", 0o600)).toBeUndefined();
    expect(tokenFileModeWarning("/t", 0o400)).toBeUndefined();
  });

  test("group- or world-readable warns and names the fix", () => {
    for (const mode of [0o640, 0o644, 0o604, 0o666, 0o777]) {
      const w = tokenFileModeWarning("/t/token", mode);
      expect(w, `mode ${mode.toString(8)}`).toBeDefined();
      expect(w).toContain("chmod 600 /t/token");
    }
  });

  test("group/other WRITE counts too, not just read", () => {
    // 0620: owner rw, group w. Nobody can read it but group, but a writer can
    // swap the credential out from under us — still a hygiene failure.
    expect(tokenFileModeWarning("/t", 0o620)).toBeDefined();
  });

  test("file-type bits from statSync().mode are ignored", () => {
    // Real stat modes carry S_IFREG (0o100000); only the low 9 bits matter.
    expect(tokenFileModeWarning("/t", 0o100600)).toBeUndefined();
    expect(tokenFileModeWarning("/t", 0o100644)).toBeDefined();
  });

  test("the warning never contains the token value — it only takes a path", () => {
    const w = tokenFileModeWarning("/home/u/.claude-token", 0o644);
    expect(w).toContain("/home/u/.claude-token");
    expect(w).toMatch(/readable beyond your user account/);
  });
});

describe("SECURITY.md claims stay true", () => {
  test("documented CLEAR_ENV count matches the actual list", () => {
    const list = read("src/index.ts").match(/const CLEAR_ENV = \[([\s\S]*?)\];/);
    expect(list).not.toBeNull();
    const actual = list![1].split("\n").filter((l) => l.trim().startsWith('"')).length;
    const documented = read("SECURITY.md").match(/(\d+) Claude\/Anthropic\s+environment variables/);
    expect(documented, "SECURITY.md must state the CLEAR_ENV count").not.toBeNull();
    expect(Number(documented![1])).toBe(actual);
  });

  test("zero runtime dependencies — the headline supply-chain claim", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(read("SECURITY.md")).toMatch(/zero runtime\s+dependencies/i);
  });

  test("no shell-string exec anywhere in shipped scripts or src", () => {
    for (const file of ["scripts/setup.mjs", "scripts/cli.mjs", "src/shim.ts"]) {
      const src = read(file);
      expect(src, `${file} must not spawn through a shell`).not.toMatch(/"\/bin\/sh"|shell:\s*true/);
    }
  });
});

describe("agent-install URL is pinned to an immutable tag", () => {
  test("README points at a version tag, never a branch", () => {
    const readme = read("README.md");
    expect(readme).not.toMatch(/multi-clawd\/master\/SETUP-AGENT\.md/);
    const pinned = readme.match(/multi-clawd\/v([\d.]+)\/SETUP-AGENT\.md/);
    expect(pinned, "README must pin SETUP-AGENT.md to a vX.Y.Z tag").not.toBeNull();
    expect(pinned![1]).toBe(JSON.parse(read("package.json")).version);
  });
});
