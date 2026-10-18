import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("committed npm lockfile", () => {
  test("exists and matches the package's direct dependency declarations", () => {
    const lockPath = join(ROOT, "package-lock.json");
    expect(existsSync(lockPath)).toBe(true);

    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    const root = lock.packages[""];

    expect(lock.lockfileVersion).toBe(3);
    expect(root.name).toBe(pkg.name);
    expect(root.version).toBe(pkg.version);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    expect(root.peerDependencies).toEqual(pkg.peerDependencies);

    for (const name of Object.keys(pkg.devDependencies)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toEqual(expect.any(String));
    }
  });

  test("is eligible for source control but excluded from the npm package", () => {
    expect(read(".gitignore").split(/\r?\n/)).not.toContain("package-lock.json");
    expect(JSON.parse(read("package.json")).files).not.toContain("package-lock.json");
  });
});
