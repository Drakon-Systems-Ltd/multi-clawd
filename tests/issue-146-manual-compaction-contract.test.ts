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
 * What this suite is: a fixture with two kinds of check. The host gate is a
 * STATIC source-shape match on the installed dist. The bundled backend and
 * our own backends are built and inspected at runtime (their declarations,
 * and the bundled prompt builder and output validator, are called). Nothing
 * here calls the host's compaction function; the refusal itself was measured
 * separately by running that function in-process
 * (reports/compat-audit/2026-11-10-openclaw-2026.11.2.md). It fixes nothing.
 *
 *  1. Host gate, read from the installed OpenClaw dist (point
 *     MULTI_CLAWD_OPENCLAW_DIST at another `openclaw/dist` to audit a
 *     different release). The body of `compactNativeCliSession` is isolated
 *     and must contain, exactly once and as complete consecutive statements:
 *     the ownership early return, the read of `backend.manualCompaction`, and
 *     the failure return carrying the refusal text. The refusal text must not
 *     occur anywhere else in the chunk. In-test mutations of the real chunk
 *     (a decoy copy in another function, a changed return, a reordered gate)
 *     must each be rejected.
 *
 *  2. The bundled backend of that same OpenClaw must declare the contract
 *     (it does on every supported release, 2026.8.1 included). A missing
 *     builder or a missing declaration fails; nothing is skipped.
 *
 *  3. Our backends as the plugin entry registers them: both single-account
 *     backends and the pooled one. The last test fails on purpose once #159
 *     lands; update it then to assert the mirrored contract instead.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import plugin from "../src/index.js";

function openclawDist(): string {
  if (process.env.MULTI_CLAWD_OPENCLAW_DIST) return process.env.MULTI_CLAWD_OPENCLAW_DIST;
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("openclaw"));
}

const REFUSAL_TEXT = "owns compaction but does not support manual compaction.";

/**
 * The three consecutive, complete statements of core's `compactNativeCliSession`:
 *
 *   if (!backend?.ownsNativeCompaction) return;
 *   const manualCompaction = backend.manualCompaction;
 *   if (!manualCompaction) return <failure carrying the refusal text>;
 *
 * 2026.8.1 returns the failure object inline; 2026.10+ builds it with
 * `buildCompactionFailureResult(...)`. Only whitespace may sit between the
 * statements, and the return must end right after the refusal text.
 */
const REFUSAL_GATE = new RegExp(
  [
    String.raw`if \(!backend\?\.ownsNativeCompaction\) return;`,
    String.raw`const manualCompaction = backend\.manualCompaction;`,
    String.raw`if \(!manualCompaction\) return (?:buildCompactionFailureResult\(|\{\s*ok: false,\s*compacted: false,\s*reason: )` +
      "`" +
      String.raw`CLI backend "\$\{runtime\}" owns compaction but does not support manual compaction\.` +
      "`" +
      String.raw`(?:\);|\s*\};)`,
  ].join(String.raw`\s*`),
  "g",
);

const HOST_FUNCTION_START = "\nasync function compactNativeCliSession(params) {\n";

/** The body of the host's `compactNativeCliSession`, or null unless it is defined exactly once. */
function hostFunctionBody(src: string): string | null {
  const start = src.indexOf(HOST_FUNCTION_START);
  if (start < 0 || src.indexOf(HOST_FUNCTION_START, start + 1) >= 0) return null;
  // Bundled output closes a top-level function with `}` at column 0.
  const end = src.indexOf("\n}\n", start + HOST_FUNCTION_START.length);
  return end < 0 ? null : src.slice(start + HOST_FUNCTION_START.length, end);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** True only when the gate sits once inside the host function and the refusal text exists nowhere else. */
function hostGateIsPinned(src: string): boolean {
  const body = hostFunctionBody(src);
  if (body === null) return false;
  return (body.match(REFUSAL_GATE) ?? []).length === 1 && count(src, REFUSAL_TEXT) === 1;
}

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
  test("source shape: compactNativeCliSession holds the ownership return, the manualCompaction read and the refusal return, once", () => {
    expect(compactionSources).toHaveLength(1);
    expect(hostGateIsPinned(compactionSources[0]!)).toBe(true);
  });

  test("the shape match rejects a decoy copy, a changed return and a reordered gate (mutations of the real chunk)", () => {
    const real = compactionSources[0]!;
    const gate = hostFunctionBody(real)!.match(REFUSAL_GATE)![0];
    const [ownership, read] = gate.split(/\n\s*/);
    expect(ownership).toBe("if (!backend?.ownsNativeCompaction) return;");
    expect(read).toBe("const manualCompaction = backend.manualCompaction;");

    // The real gate stops refusing; an identical gate lives on in some other function.
    const decoy =
      real.replace(gate, `${ownership}\n\t${read}`) +
      `\nasync function unrelated(params) {\n\tconst backend = params.backend;\n\tconst runtime = "x";\n\t${gate}\n}\n`;
    expect(count(decoy, REFUSAL_TEXT)).toBe(1);
    expect(hostGateIsPinned(decoy)).toBe(false);

    // The refusal text survives but the statement no longer returns it as-is.
    const text = "`CLI backend \"${runtime}\" owns compaction but does not support manual compaction.`";
    expect(real).toContain(text);
    expect(hostGateIsPinned(real.replace(text, `${text} && void 0`))).toBe(false);

    // The read moves ahead of the ownership check.
    expect(hostGateIsPinned(real.replace(`${ownership}\n\t${read}`, `${read}\n\t${ownership}`))).toBe(false);

    // A second definition of the function makes the pin ambiguous.
    expect(hostGateIsPinned(`${real}${HOST_FUNCTION_START}}\n`)).toBe(false);
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

describe("our backends' compaction declarations today, as the plugin entry registers them (#159)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "mc-146-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  type Declared = { id: string; ownsNativeCompaction?: boolean; manualCompaction?: unknown };

  function registered(): Declared[] {
    const backends: Declared[] = [];
    const pluginConfig = {
      accounts: [
        { id: "claw1", configDir: join(scratch, "claw1") },
        { id: "claw2", configDir: join(scratch, "claw2") },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
    };
    const config = { plugins: { entries: { "multi-clawd": { config: pluginConfig } } } };
    const api = {
      config,
      pluginConfig,
      runtime: { config: { current: () => config } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: (backend: Declared) => backends.push(backend),
      registerProvider: () => {},
      on: () => {},
    };
    // Pin the launch mode to "no claude on PATH" so every machine registers the same way.
    const savedPath = process.env.PATH;
    const savedBin = process.env.MULTI_CLAWD_CLAUDE_BIN;
    process.env.PATH = "";
    delete process.env.MULTI_CLAWD_CLAUDE_BIN;
    try {
      plugin.register(api as never);
    } finally {
      process.env.PATH = savedPath;
      if (savedBin !== undefined) process.env.MULTI_CLAWD_CLAUDE_BIN = savedBin;
    }
    return backends;
  }

  const backends = registered();

  test("the entry registers both single-account backends and the pooled backend", () => {
    expect(backends.map((b) => b.id)).toEqual(["claw1", "claw2", "clawd"]);
  });

  test.each(["claw1", "claw2", "clawd"])("%s declares ownsNativeCompaction, the first field the host gate reads", (id) => {
    expect(backends.find((b) => b.id === id)?.ownsNativeCompaction).toBe(true);
  });

  test.each(["claw1", "claw2", "clawd"])(
    "%s declares no manualCompaction, the second field the host gate reads (flips when #159 is implemented)",
    (id) => {
      const backend = backends.find((b) => b.id === id);
      expect(backend).toBeDefined();
      expect(backend!.manualCompaction).toBeUndefined();
    },
  );
});
