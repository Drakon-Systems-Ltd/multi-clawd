import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readme = read("README.md");
const security = read("SECURITY.md");

function tableRow(table: string, surface: string): string {
  return table.split("\n").find((line) => line.startsWith(`| ${surface} |`)) ?? "";
}

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("docs touch and process tables", () => {
  test("README discloses network, credential and platform behaviour", () => {
    expect(tableRow(readme, "Network")).toContain("api.anthropic.com/api/oauth/usage");
    expect(tableRow(readme, "Network")).toContain("usagePoll.enabled: false");
    expect(tableRow(readme, "Credentials")).toContain("Keychain");
    expect(readme).not.toContain("Zero egress of its own");
    expect(readme).not.toContain("no shell-outs");
    expect(tableRow(readme, "Windows (native)")).toContain("not implemented");
  });

  test("SECURITY table names every child-process importing source file", () => {
    const sourceFiles = ["src", "scripts"].flatMap(filesUnder);
    const importsChildProcess = (path: string) =>
      /\b(?:from\s*["'](?:node:)?child_process["']|import\s*\(\s*["'](?:node:)?child_process["']\s*\)|require\s*\(\s*["'](?:node:)?child_process["']\s*\))/.test(read(path));
    const expected = sourceFiles.filter(importsChildProcess).map((path) =>
      path.startsWith("src/") ? path.replace(/^src\//, "dist/").replace(/\.ts$/, ".js") : path,
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const path of expected) {
      expect(
        security.split("\n").some((line) => line.startsWith(`| \`${path}\` |`)),
        `Missing SECURITY.md table row for ${path}`,
      ).toBe(true);
    }
  });
});
