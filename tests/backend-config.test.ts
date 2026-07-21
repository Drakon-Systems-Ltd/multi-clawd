/**
 * Regression guards for the backend config template — the flags here have
 * each caused a production incident when set wrong, so they are pinned by
 * test rather than trusted to survive refactors.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBackend } from "../src/index.js";

const account = { id: "claw2", configDir: "/tmp/claw2" };

describe("buildBackend config", () => {
  it("keeps raw-transcript reseed enabled so a failed cross-account resume can retry fresh", () => {
    // 2026-07-21: with this false, a mid-conversation pool rotation made the
    // gateway's resume fail with session_expired and — lacking the pre-built
    // history prompt this flag gates — it skipped the fresh-session retry and
    // cascaded down the model-fallback chain to a non-Claude provider.
    const backend = buildBackend(account);
    expect(backend.config.reseedFromRawTranscriptWhenUncompacted).toBe(true);
  });

  it("declares the claude-stream-json dialect so live turns never leak raw JSONL", () => {
    const backend = buildBackend(account);
    expect(backend.config.jsonlDialect).toBe("claude-stream-json");
  });

  it("passes --resume for resumed sessions via the shim", () => {
    const backend = buildBackend(account);
    expect(backend.config.resumeArgs).toContain("--resume");
    expect(backend.config.resumeArgs).toContain("{sessionId}");
  });
});

describe("plugin manifest", () => {
  it("carries a version that matches package.json (synced by the npm version script)", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.version).toBe(pkg.version);
  });
});
