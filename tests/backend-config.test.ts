/**
 * Regression guards for the backend config template — the flags here have
 * each caused a production incident when set wrong, so they are pinned by
 * test rather than trusted to survive refactors.
 */
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBackend, buildRetryRoster } from "../src/index.js";

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

describe("buildRetryRoster (#19)", () => {
  const native = { id: "claw1", native: true };
  const configDir = { id: "claw2", configDir: "/tmp/claw2" };
  const tokenFile = { id: "claw3", oauthTokenFile: "~/.claw3/token" };
  const tokenRef = { id: "claw4", oauthTokenRef: { provider: "op", id: "x" } };

  it("offers the other pool members with the credential env the shim needs", () => {
    const roster = buildRetryRoster([native, configDir], "claw1");
    expect(roster.map((r) => r.id)).toEqual(["claw2"]);
    expect(roster[0].env.CLAUDE_CONFIG_DIR).toBe("/tmp/claw2");
    expect(roster[0].stateFile).toContain("claw2.json");
  });

  it("never offers the account that is launching", () => {
    expect(buildRetryRoster([native, configDir], "claw2").map((r) => r.id)).toEqual(["claw1"]);
  });

  it("excludes token-backed accounts — their secret must not ride in every child's env", () => {
    // Security, not capability: a token sibling would mean one compromised
    // child sees the whole pool's credentials rather than its own login.
    const roster = buildRetryRoster([native, configDir, tokenFile, tokenRef], "claw1");
    expect(roster.map((r) => r.id)).toEqual(["claw2"]);
  });

  it("carries no identity vars — those are set at retry time from the entry", () => {
    const roster = buildRetryRoster([native, configDir], "claw1");
    expect(roster[0].env.MULTI_CLAWD_ACCOUNT_ID).toBeUndefined();
    expect(roster[0].env.MULTI_CLAWD_STATE_FILE).toBeUndefined();
  });

  it("a native sibling carries no config dir at all", () => {
    const roster = buildRetryRoster([configDir, native], "claw2");
    expect(roster[0].id).toBe("claw1");
    expect(roster[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
