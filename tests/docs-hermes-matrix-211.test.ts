import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

function section(start: string, end: string): string {
  const a = readme.indexOf(start);
  const b = readme.indexOf(end, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return readme.slice(a, b);
}

describe("README Hermes vs OpenClaw capability matrix (#211)", () => {
  const block = section("#### Capability comparison", "### Security model");
  const row = (name: string) => block.split("\n").find((l) => l.startsWith(`| ${name} |`)) ?? "";

  test("sits inside the 'What this integration is (and is not)' area and links the guide", () => {
    expect(readme.indexOf("### What this integration is (and is not)")).toBeLessThan(
      readme.indexOf("#### Capability comparison"),
    );
    expect(block).toContain("(#hermes-agent-integration)");
  });

  test("distinguishes proactive OpenClaw rotation from Hermes reactive failover", () => {
    expect(row("Proactive near-limit rotation")).toContain("Not implemented for Hermes yet");
    expect(row("Failover when a turn dies with a limit error")).toContain("Hermes-native");
  });

  test("states skills/MCP and the Claude Code harness do not transfer", () => {
    expect(row("OpenClaw skills and MCP wiring")).toContain("Not copied across");
    expect(row("Claude Code harness")).toContain("Not used");
  });

  test("makes no new promises", () => {
    expect(block).not.toMatch(/\b(soon|will be|planned|roadmap|coming)\b/i);
  });
});
