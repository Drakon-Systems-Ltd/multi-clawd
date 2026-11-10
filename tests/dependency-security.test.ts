import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

/**
 * Committed-lockfile guard for the dev tree's security floors (#157).
 *
 * Every package here arrives through the pinned `openclaw` devDependency. This
 * package does not bundle any of them: it declares no `dependencies`, and a
 * host's own OpenClaw install resolves its own copies, which the overrides
 * below do not reach (npm applies `overrides` from the root project only).
 *
 * Each floor is the first release carrying the fixes for the advisories
 * Dependabot reported against the committed lockfile. The guard reads the
 * lockfile's `node_modules/<name>` records, hoisted and nested; it does not
 * inspect an installed tree, an aliased install or a bundled copy.
 *
 * `minimatch` has no floor on purpose: patched releases start at 11.0.1, a new
 * major, and `openclaw` pins 10.x exactly. It stays open in #157.
 */
const FLOORS: Record<string, string> = {
  undici: "8.12.2",
  "@modelcontextprotocol/sdk": "1.32.0",
  "fast-uri": "3.1.9",
};

/**
 * Packages the pinned `openclaw` declares at an exact, unpatched version. Only
 * an override can move them, and it is scoped to that one `openclaw` version so
 * a newer OpenClaw (CI overlays several) keeps the versions it ships with.
 */
const OVERRIDDEN = ["undici", "@modelcontextprotocol/sdk"];

function parse(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a plain release version: ${version}`);
  return match.slice(1).map(Number);
}

function atLeast(version: string, floor: string): boolean {
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function lockedVersions(lock: any, name: string): Array<{ path: string; version: string }> {
  const suffix = `node_modules/${name}`;
  return Object.entries<any>(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([path, entry]) => ({ path, version: entry.version }));
}

describe("dev-tree security floors (#157)", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");

  test.each(Object.entries(FLOORS))("every lockfile record of %s is at or above %s", (name, floor) => {
    const found = lockedVersions(lock, name);
    expect(found.length, `${name} is no longer in the lockfile; drop its floor`).toBeGreaterThan(0);
    for (const { path, version } of found) {
      expect(atLeast(version, floor), `${path} is ${version}, below ${floor}`).toBe(true);
    }
  });

  test.each(OVERRIDDEN)("%s is overridden only under the pinned openclaw", (name) => {
    const pinned = pkg.devDependencies.openclaw;
    expect(pkg.overrides?.[name], `unscoped override of ${name}`).toBeUndefined();
    expect(Object.keys(pkg.overrides ?? {})).toEqual([`openclaw@${pinned}`]);

    const override = pkg.overrides[`openclaw@${pinned}`][name];
    expect(override, `overrides["openclaw@${pinned}"].${name}`).toEqual(expect.any(String));
    expect(atLeast(override, FLOORS[name])).toBe(true);
    expect(parse(override)[0]).toBe(parse(FLOORS[name])[0]);

    const hoisted = lock.packages[`node_modules/${name}`];
    expect(lock.packages["node_modules/openclaw"].version).toBe(pinned);
    expect(lock.packages[`node_modules/openclaw/node_modules/${name}`]).toBeUndefined();
    expect(hoisted?.version, `the copy openclaw resolves for ${name}`).toBe(override);
  });

  test.each(Object.keys(FLOORS))("%s lockfile records name the release they pin", (name) => {
    for (const { path, version } of lockedVersions(lock, name)) {
      const base = name.split("/").pop();
      expect(lock.packages[path].resolved, path).toBe(
        `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`,
      );
      expect(lock.packages[path].integrity, path).toMatch(/^sha512-/);
    }
  });

  test("these packages are development-only in the lockfile and not bundled", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.bundleDependencies ?? pkg.bundledDependencies).toBeUndefined();
    expect(pkg.files).not.toContain("package-lock.json");
    for (const name of Object.keys(FLOORS)) {
      for (const { path } of lockedVersions(lock, name)) {
        expect(lock.packages[path].dev, `${path} must stay dev-only`).toBe(true);
      }
    }
  });
});
