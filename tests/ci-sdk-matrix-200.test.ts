import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Guards the CI-only SDK compatibility matrix (#200): the previous OpenClaw
// minor must be pinned exactly, with an exact installed-version assertion,
// and the older baselines plus `latest` must stay.
const ci = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const entries = [...ci.matchAll(/- openclaw: "([^"]+)"\s*\n\s*expect: "([^"]*)"/g)].map((m) => ({
  openclaw: m[1],
  expect: m[2],
}));

describe("sdk-contract-compat matrix", () => {
  test("covers the previous minor 2026.10.34 with an exact expectation", () => {
    expect(entries).toContainEqual({ openclaw: "2026.10.34", expect: "2026.10.34" });
  });
  test("keeps older baselines and the unpinned latest lane", () => {
    expect(entries).toContainEqual({ openclaw: "2026.10.10", expect: "2026.10.10" });
    expect(entries).toContainEqual({ openclaw: "2026.11.1", expect: "2026.11.1" });
    expect(entries).toContainEqual({ openclaw: "latest", expect: "" });
  });
  test("every pinned lane asserts the version it installs", () => {
    for (const e of entries.filter((x) => x.openclaw !== "latest")) expect(e.expect).toBe(e.openclaw);
  });
});
