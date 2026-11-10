/**
 * #146 compatibility audit, finding filed as #159: a manual `/compact` on a
 * pooled backend is refused by OpenClaw before any process starts.
 *
 * The pool declares `ownsNativeCompaction: true` and no `manualCompaction`.
 * Core's manual-compaction path returns a failure result for exactly that
 * pair ("owns compaction but does not support manual compaction"), while the
 * bundled `claude-cli` backend declares the public `manualCompaction`
 * contract and runs Claude Code's native `/compact` as a control operation.
 *
 * What this suite is: a STATIC shape pin of the host gate, plus the two
 * declarations the gate reads. It does not call the host's compaction
 * function; the refusal itself was measured separately by running that
 * function in-process (reports/compat-audit/2026-11-10-openclaw-2026.11.2.md).
 * It fixes nothing.
 *
 *  1. Host gate, read from the installed OpenClaw dist (point
 *     MULTI_CLAWD_OPENCLAW_DIST at another `openclaw/dist` to audit a
 *     different release). One function-local match: the ownership early
 *     return, the read of `backend.manualCompaction`, and the failure return
 *     carrying the refusal text, consecutively. If upstream reorders or
 *     reroutes any of the three, the match fails.
 *
 *  2. The bundled backend of that same OpenClaw must declare the contract
 *     (it does on every supported release, 2026.8.1 included). A missing
 *     builder or a missing declaration fails; nothing is skipped.
 *
 *  3. Our backend's declaration today. The last test fails on purpose once
 *     #159 lands; update it then to assert the mirrored contract instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildBackend } from "../src/index.js";

function openclawDist(): string {
  if (process.env.MULTI_CLAWD_OPENCLAW_DIST) return process.env.MULTI_CLAWD_OPENCLAW_DIST;
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("openclaw"));
}

const REFUSAL_TEXT = "owns compaction but does not support manual compaction.";

/**
 * The three consecutive statements of core's `compactNativeCliSession`:
 *
 *   if (!backend?.ownsNativeCompaction) return;
 *   const manualCompaction = backend.manualCompaction;
 *   if (!manualCompaction) return <failure carrying the refusal text>;
 *
 * 2026.8.1 returns the failure object inline; 2026.10+ builds it with
 * `buildCompactionFailureResult(`. Only whitespace may sit between them.
 */
const REFUSAL_GATE = new RegExp(
  [
    String.raw`if \(!backend\?\.ownsNativeCompaction\) return;`,
    String.raw`const manualCompaction = backend\.manualCompaction;`,
    String.raw`if \(!manualCompaction\) return (?:buildCompactionFailureResult\(|\{\s*ok: false,\s*compacted: false,\s*reason: )` +
      "`" +
      String.raw`CLI backend "\$\{runtime\}" owns compaction but does not support manual compaction\.` +
      "`",
  ].join(String.raw`\s*`),
);

const dist = openclawDist();
const hostVersion = (JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as { version: string }).version;

/** Only the compaction chunks: reading the whole dist is slow enough to time out on a cold cache. */
const compactionSources = readdirSync(dist)
  .filter((f) => /^compact-.*\.m?js$/.test(f))
  .map((f) => readFileSync(join(dist, f), "utf8"))
  .filter((src) => src.includes(REFUSAL_TEXT));

type ManualCompaction = {
  buildPrompt?: (instructions?: string) => string;
  input?: string;
  validateOutput?: (raw: string) => { ok: boolean; reason?: string };
};

describe(`OpenClaw ${hostVersion} gates manual compaction on the manualCompaction contract (${dist})`, () => {
  test("the installed dist returns the refusal when a backend owns compaction and declares no manualCompaction", () => {
    expect(compactionSources.length).toBeGreaterThan(0);
    for (const src of compactionSources) expect(src).toMatch(REFUSAL_GATE);
  });

  test("the bundled claude-cli backend declares the contract: native /compact, validated by a compact boundary", async () => {
    const mod = (await import(pathToFileURL(join(dist, "extensions", "anthropic", "cli-backend.js")).href)) as {
      buildAnthropicCliBackend?: () => { ownsNativeCompaction?: boolean; manualCompaction?: ManualCompaction };
    };
    expect(typeof mod.buildAnthropicCliBackend).toBe("function");
    const bundled = mod.buildAnthropicCliBackend!();
    const manual = bundled.manualCompaction;
    expect(bundled.ownsNativeCompaction).toBe(true);
    expect(manual, `OpenClaw ${hostVersion} bundled backend no longer declares manualCompaction`).toBeDefined();
    expect(manual!.buildPrompt?.()).toBe("/compact");
    expect(manual!.buildPrompt?.("  keep the plan  ")).toBe("/compact keep the plan");
    expect(manual!.input).toBe("arg");
    expect(manual!.validateOutput?.('{"type":"system","subtype":"compact_boundary"}')).toEqual({ ok: true });
    expect(manual!.validateOutput?.('{"type":"result","subtype":"success"}').ok).toBe(false);
  });
});

describe("the pool's compaction declaration today (#159)", () => {
  const backend = buildBackend({ id: "claw1", native: true }) as {
    ownsNativeCompaction?: boolean;
    manualCompaction?: unknown;
  };

  test("the pool declares ownsNativeCompaction, the first field the host gate reads", () => {
    expect(backend.ownsNativeCompaction).toBe(true);
  });

  test("the pool declares no manualCompaction, the second field the host gate reads (flips when #159 is implemented)", () => {
    expect(backend.manualCompaction).toBeUndefined();
  });
});
