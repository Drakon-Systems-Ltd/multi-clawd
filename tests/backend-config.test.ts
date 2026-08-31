/**
 * Regression guards for the backend config template — the flags here have
 * each caused a production incident when set wrong, so they are pinned by
 * test rather than trusted to survive refactors.
 */
import { readFileSync, statSync } from "node:fs";
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

  it("keeps the OpenClaw 2.0 session, fork, and recovery contract", () => {
    const backend = buildBackend(account);
    expect(backend.config.sessionArgs).toEqual(["--session-id", "{sessionId}"]);
    expect((backend.config as { sessionArg?: string }).sessionArg).toBe("--session-id");
    expect(backend.config.forkArg).toBe("--fork-session");
    expect(backend.config.resumeAtArg).toBe("--resume-session-at");
    expect(backend.config.freshSessionRecovery).toBe("invalidated-only");
    expect(backend.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
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

  it("builds and tests against the same current OpenClaw SDK release", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.devDependencies.openclaw).toBe("2026.8.1");
    expect(pkg.openclaw.build.openclawVersion).toBe(pkg.devDependencies.openclaw);
  });

  it("retains the declared OpenClaw 2026.6 minimum runtime contract", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.6");
  });

  it("ships a normalized executable CLI bin entry", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const cli = new URL("../scripts/cli.mjs", import.meta.url);
    expect(pkg.bin).toEqual({ "multi-clawd": "scripts/cli.mjs" });
    expect(statSync(cli).mode & 0o111).not.toBe(0);
  });
});
