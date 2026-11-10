import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

/**
 * Security floors for the dev tree (#157).
 *
 * Every package here arrives through the pinned `openclaw` devDependency; none
 * of it ships in the published package. Each floor is the first release that
 * carries the fixes for the advisories Dependabot reported against the
 * committed lockfile. The test reads every copy of a package in the lockfile,
 * so a nested copy below the floor fails it too.
 *
 * `minimatch` has no floor on purpose: its only patched release is a new major
 * (11.x) and `openclaw@2026.8.1` pins 10.x exactly. See #157.
 */
const FLOORS: Record<string, string> = {
  undici: "8.12.2",
  "@modelcontextprotocol/sdk": "1.32.0",
  "fast-uri": "3.1.9",
};

/** Packages `openclaw@2026.8.1` pins exactly; only a root override can move them. */
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

  test.each(Object.entries(FLOORS))("%s is locked at or above %s", (name, floor) => {
    const found = lockedVersions(lock, name);
    expect(found.length, `${name} is no longer in the lockfile; drop its floor`).toBeGreaterThan(0);
    for (const { path, version } of found) {
      expect(atLeast(version, floor), `${path} is ${version}, below ${floor}`).toBe(true);
    }
  });

  test.each(OVERRIDDEN)("%s override stays within the patched major", (name) => {
    const override = pkg.overrides?.[name];
    expect(override, `package.json overrides.${name}`).toEqual(expect.any(String));
    expect(atLeast(override, FLOORS[name])).toBe(true);
    expect(parse(override)[0]).toBe(parse(FLOORS[name])[0]);
    for (const { path, version } of lockedVersions(lock, name)) {
      expect(version, path).toBe(override);
    }
  });

  test("the floors stay a dev-tree concern: nothing here ships", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.files).not.toContain("package-lock.json");
    for (const name of Object.keys(FLOORS)) {
      for (const { path } of lockedVersions(lock, name)) {
        expect(lock.packages[path].dev, `${path} must stay dev-only`).toBe(true);
      }
    }
  });
});
