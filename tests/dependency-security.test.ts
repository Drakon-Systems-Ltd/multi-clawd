import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

/**
 * Committed-lockfile guard for the dev tree's security floors (#157).
 *
 * Every package here arrives through the pinned `openclaw` devDependency. This
 * package declares none of them as a production or npm-bundled dependency, and
 * a host's own OpenClaw install resolves its own copies, which the overrides
 * below do not reach (npm applies `overrides` from the root project only).
 *
 * Each floor is the first release carrying the fixes for the advisories
 * Dependabot reported against the committed lockfile. The guard reads the
 * lockfile only: every record that is one of these packages by install path
 * (hoisted or nested), by recorded `name` (how npm writes an alias) or by
 * registry tarball URL. It does not inspect an installed tree, the built
 * `dist/` or the packed tarball, so it says nothing about a vendored copy.
 *
 * `hono` (#175) reaches the tree through the MCP SDK's own `^4.11.4` range, so
 * its floor is held by the lockfile record alone: no override, and the floor
 * stays inside major 4.
 *
 * `minimatch` has no floor on purpose: patched releases start at 11.0.1, a new
 * major, and `openclaw` pins 10.x exactly. It stays open in #157.
 */
const FLOORS: Record<string, string> = {
  undici: "8.12.2",
  "@modelcontextprotocol/sdk": "1.32.0",
  "fast-uri": "3.1.9",
  hono: "4.13.16",
};

/**
 * Packages the pinned `openclaw` declares at an exact, unpatched version. Only
 * an override can move them, and it is scoped to that one `openclaw` version so
 * a newer OpenClaw (CI overlays several) keeps the versions it ships with.
 */
const OVERRIDDEN = ["undici", "@modelcontextprotocol/sdk"];

/**
 * Plain `x.y.z` only. The lockfile pins published registry releases of these
 * packages; a prerelease or build-metadata version throws, so it fails the
 * guard and gets looked at instead of being ordered by guesswork.
 */
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
  const tarballPrefix = `https://registry.npmjs.org/${name}/-/`;
  return Object.entries<any>(lock.packages)
    .filter(
      ([path, entry]) =>
        path === suffix ||
        path.endsWith(`/${suffix}`) ||
        entry.name === name ||
        (typeof entry.resolved === "string" && entry.resolved.startsWith(tarballPrefix)),
    )
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

  test("hono is floored by the lockfile alone, inside the major its dependents accept (#175)", () => {
    expect(JSON.stringify(pkg.overrides ?? {})).not.toContain('"hono"');
    expect(pkg.devDependencies.hono).toBeUndefined();

    const found = lockedVersions(lock, "hono");
    expect(found.map(({ path }) => path)).toEqual(["node_modules/hono"]);
    expect(parse(found[0].version)[0]).toBe(parse(FLOORS.hono)[0]);

    const sdkRange = lock.packages["node_modules/@modelcontextprotocol/sdk"].dependencies?.hono;
    expect(sdkRange, "the MCP SDK's declared hono range").toBe("^4.11.4");
  });

  test("these packages are development-only lockfile records, not declared production or npm-bundled dependencies", () => {
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
