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
 * This suite pins the facts and fixes nothing:
 *
 *  1. Host evidence, read by shape from the installed OpenClaw dist (point
 *     MULTI_CLAWD_OPENCLAW_DIST at another `openclaw/dist` to audit a
 *     different release): the refusal gate exists and is keyed on the two
 *     backend fields. This is STATIC evidence about the host; the audit
 *     report records the separate in-process run of the host's own function.
 *
 *  2. The bundled backend of the installed OpenClaw, when it declares the
 *     contract, has the three members the public type requires. Releases
 *     whose bundled backend predates the contract are reported, not failed.
 *
 *  3. Our backend today: owns compaction, declares no manual compaction. The
 *     last test fails on purpose once #159 lands; update it then to assert
 *     the mirrored contract instead.
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
 * `if (!backend?.ownsNativeCompaction) return;` then `if (!manualCompaction) return ...`.
 * 2026.8.1 returns the failure object inline; 2026.10+ builds it with a helper.
 */
const OWNERSHIP_GATE = /if \(!backend\?\.ownsNativeCompaction\) return;/;
const MANUAL_GATE = /if \(!manualCompaction\) return (?:buildCompactionFailureResult\(|\{\s*ok: false,)/;

const dist = openclawDist();
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

async function bundledManualCompaction(): Promise<ManualCompaction | undefined> {
  const mod = (await import(pathToFileURL(join(dist, "extensions", "anthropic", "cli-backend.js")).href)) as {
    buildAnthropicCliBackend?: () => { ownsNativeCompaction?: boolean; manualCompaction?: ManualCompaction };
  };
  return mod.buildAnthropicCliBackend?.().manualCompaction;
}

describe(`OpenClaw refuses manual compaction without the manualCompaction contract (${dist})`, () => {
  test("the installed dist carries the refusal, gated on ownsNativeCompaction then manualCompaction", () => {
    expect(compactionSources.length).toBeGreaterThan(0);
    for (const src of compactionSources) {
      expect(src).toMatch(OWNERSHIP_GATE);
      expect(src).toMatch(MANUAL_GATE);
      expect(src.indexOf("ownsNativeCompaction) return;")).toBeLessThan(src.indexOf(REFUSAL_TEXT));
    }
  });

  test("the bundled claude-cli backend, where it declares the contract, runs native /compact and checks for a boundary", async () => {
    const manual = await bundledManualCompaction();
    if (!manual) {
      // Older bundled backends (the pinned build SDK) predate the declaration.
      expect(manual).toBeUndefined();
      return;
    }
    expect(manual.buildPrompt?.()).toBe("/compact");
    expect(manual.buildPrompt?.("  keep the plan  ")).toBe("/compact keep the plan");
    expect(manual.input).toBe("arg");
    expect(manual.validateOutput?.('{"type":"system","subtype":"compact_boundary"}')).toEqual({ ok: true });
    expect(manual.validateOutput?.('{"type":"result","subtype":"success"}').ok).toBe(false);
  });
});

describe("the pool's compaction declaration today (#159)", () => {
  const backend = buildBackend({ id: "claw1", native: true }) as {
    ownsNativeCompaction?: boolean;
    manualCompaction?: unknown;
  };

  test("the pool owns native compaction, which is the half of the pair that routes /compact to the gate", () => {
    expect(backend.ownsNativeCompaction).toBe(true);
  });

  test("the pool declares no manualCompaction, so core refuses a manual /compact (flips when #159 is implemented)", () => {
    expect(backend.manualCompaction).toBeUndefined();
  });
});
