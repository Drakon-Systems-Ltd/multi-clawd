// Text-only contracts: never execute installation instructions from documentation.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const files = ["README.md", "SETUP-AGENT.md", "PUBLISHING.md"];
for (const file of files) {
  const doc = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  // Scope assertions to the local raw-install guidance, not unrelated safety prose.
  const start = doc.indexOf("**Raw-install fallback boundary:**");
  const end = doc.indexOf("or substitute a different version during fallback.", start);
  const boundary = doc.slice(start, end + "or substitute a different version during fallback.".length).replace(/\s+/g, " ");
  describe(`${file}: raw-install source boundary`, () => {
    test("has local positive identification and narrow compatibility conditions", () => {
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(boundary).toContain("use npm only after positively identifying a ClawHub availability failure");
      expect(boundary).toContain("older OpenClaw CLI explicitly rejecting the `clawhub:` spec as unsupported");
      expect(boundary).toContain("An old CLI version alone is not evidence");
      expect(doc).not.toMatch(/If ClawHub fails, use|For older OpenClaw or a ClawHub failure, use/i);
    });
    test("every denial and interruption takes precedence over availability", () => {
      const stop = boundary.match(/\*\*Stop; do not retry through npm\*\* for ([^.]+)\./)?.[1] ?? "";
      for (const cause of ["moderation", "security", "integrity", "trust", "signature", "policy", "unknown errors", "cancellation", "interruption"]) {
        expect(stop, cause).toContain(cause);
      }
      expect(boundary).toContain("These stops take precedence even if availability diagnostics appeared first");
      expect(boundary).toContain("If the cause is unclear, stop and investigate; do not switch sources or restart the gateway after a failed or interrupted install");
    });
    test("preserves the selected version in the actual npm command", () => {
      expect(boundary).toContain("Only after the availability/unsupported-spec check above, an unversioned fresh install may use");
      expect(boundary).toContain("For a versioned install, retain the same selected exact target");
      const pair = boundary.match(/`clawhub:@drakon-systems\/multi-clawd@([^`]+)`, the permitted npm retry is `openclaw plugins install @drakon-systems\/multi-clawd@([^ `]+) --pin`/);
      expect(pair).not.toBeNull();
      expect(pair?.[1]).toBe("X.Y.Z");
      expect(pair?.[2]).toBe(pair?.[1]);
      expect(boundary).toContain("never drop it, re-resolve latest, or substitute a different version during fallback");
    });
    test("prefers the guarded updater adjacent to the raw instructions", () => {
      expect(doc.slice(Math.max(0, start - 180), start)).toContain("For existing installs, prefer the guarded `multi-clawd update` command rather than a raw source retry.");
    });
  });
}
