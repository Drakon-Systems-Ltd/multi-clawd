/**
 * Guards for the security properties SECURITY.md promises publicly.
 *
 * Documentation drifts silently; these turn each published claim into a
 * failing build when the code stops backing it. Same discipline that now pins
 * the manifest version and the README's release tag.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

  test("SECURITY.md actually ships to npm users, and the README points at it", () => {
    // A disclosure policy nobody receives is decoration. It must be in `files`
    // (v1.5.2 shipped without it) and linked from the page npm renders.
    expect(JSON.parse(read("package.json")).files).toContain("SECURITY.md");
    expect(read("README.md")).toMatch(/\[SECURITY\.md\]\(SECURITY\.md\)/);
  });

  test("no shell-string exec anywhere in shipped scripts or src", () => {
    const shippedScripts = readdirSync(join(ROOT, "scripts"))
      .filter((name) => name.endsWith(".mjs") || name.endsWith(".py"))
      .map((name) => `scripts/${name}`);
    for (const file of [...shippedScripts, "src/shim.ts"]) {
      const src = read(file);
      expect(src, `${file} must not spawn through a shell`).not.toMatch(/"\/bin\/sh"|shell\s*[:=]\s*(?:true|True)/);
    }
  });

  test("Hermes adapter keeps credential values off argv, environment, and rendered output", () => {
    const cli = read("scripts/hermes.mjs");
    const bridge = read("scripts/hermes_bridge.py");
    // The token reaches the bridge on stdin only — never as an argument.
    expect(cli).toMatch(/input:\s*JSON\.stringify\(/);
    expect(cli).not.toMatch(/spawnSync\(\s*hermes\.python\s*,\s*\[\s*BRIDGE\s*,/);
    expect(cli).not.toMatch(/process\.env\.(?:ACCESS|REFRESH|OAUTH|ANTHROPIC).*=/i);
    expect(cli).not.toMatch(/console\.(?:log|error)\([^\n]*(?:accessToken|refreshToken|Fingerprint)/);
    expect(bridge).toMatch(/if len\(sys\.argv\) != 1/);
    expect(bridge).not.toMatch(/subprocess\.|os\.system|shell\s*=\s*True/);
  });

  test("the published tarball carries no Python bytecode", () => {
    // A .pyc embeds the full source, comments included — the same leak path
    // `removeComments` closes for dist/. `files` includes scripts/ wholesale,
    // and an allowlisted directory is NOT filtered by .gitignore, so the
    // exclusion has to live in `files` itself.
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const packed: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.filter((path) => path.includes("__pycache__") || /\.py[cod]$/.test(path))).toEqual([]);
    expect(packed).toContain("scripts/hermes_bridge.py");
    // Spawning npm is slow, and slower still alongside the other suites.
  }, 120_000);

  test("only stable setup tokens can be imported into Hermes", () => {
    // Rotating grants are single-use on refresh; duplicating one guarantees a
    // dead credential. The refusal must exist on both sides of the bridge.
    const core = read("src/hermes-core.ts");
    const bridge = read("scripts/hermes_bridge.py");
    expect(core).toMatch(/rotating_grant_not_supported/);
    expect(core).not.toMatch(/claudeAiOauth/);
    expect(bridge).toMatch(/rotating_grant_not_supported/);
    expect(bridge).toMatch(/"refreshToken",\s*"expiresAtMs"/);
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
