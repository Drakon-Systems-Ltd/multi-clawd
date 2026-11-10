/**
 * #137: isolated completions (prompt-only, tool-less side inference such as
 * conversation labels, session summaries and plugin completions) are refused
 * on pooled backends. Core's CLI runner requires `prepareExecution` to return
 * `isolatedCompletionEnforced: true`; that flag is a private contract between
 * core and its bundled backends and is absent from the SDK's public
 * `CliBackendPreparedExecution` type. OpenClaw 2026.8.1, 2026.10.10 and
 * 2026.11.1 all carry the identical gate.
 *
 * This suite pins the facts so the gap stays visible instead of silent:
 *
 *  1. Host evidence, read by shape from the installed OpenClaw dist (point
 *     MULTI_CLAWD_OPENCLAW_DIST at another `openclaw/dist` to audit a different
 *     release): the refusal gate exists, core hands the private
 *     `isolatedCompletionPrompt` context to every backend's prepareExecution,
 *     and the public SDK type still omits the flag. When upstream publishes
 *     the contract, the "still private" test fails on purpose: that is the
 *     signal to implement #137 against the public type.
 *
 *  2. Our documented refusal: given that private context, the pool returns no
 *     `isolatedCompletionEnforced`. We never claim an isolation we do not
 *     enforce; core then fails closed ("does not support isolated completion;
 *     OpenClaw did not start the run") and no process is started.
 *
 *  3. Projection parity: the bundled backend pairs its flag with a
 *     side-question argv projection; since #142 the pool's resolver applies
 *     the same one (the gap this section originally pinned is closed). The
 *     bundled resolver runs in a child process because two OpenClaw releases
 *     cannot share one Node process. Still no isolatedCompletionEnforced
 *     (see reports/compat-audit/2026-11-08-isolated-completion-contract.md).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildBackend, resolveBackendLaunch } from "../src/index.js";

/** Mirrors the private fields core adds for isolated completions (prepare.ts). */
type PrivateIsolatedContext = {
  isolatedCompletionCwd: string;
  isolatedCompletionModelId: string;
  isolatedCompletionPrompt: string;
  isolatedCompletionSystemPrompt: string;
};

const REFUSAL_GATE =
  /if \(params\.isolatedCompletion && preparedExecution\?\.isolatedCompletionEnforced !== true\) throw unsupportedIsolatedCompletionError\(/;

function openclawDist(): string {
  if (process.env.MULTI_CLAWD_OPENCLAW_DIST) return process.env.MULTI_CLAWD_OPENCLAW_DIST;
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("openclaw"));
}

function readDistSources(dist: string, pattern: RegExp): string[] {
  return readdirSync(dist)
    .filter((f) => pattern.test(f))
    .map((f) => readFileSync(join(dist, f), "utf8"));
}

/** The public `CliBackendPreparedExecution` type bodies declared by the installed dist. */
function publicPreparedExecutionTypes(dist: string): string[] {
  const bodies: string[] = [];
  for (const src of readDistSources(dist, /\.d\.ts$/)) {
    const re = /\n(?:export )?type CliBackendPreparedExecution = \{([\s\S]*?)\n\};/g;
    for (let m = re.exec(src); m; m = re.exec(src)) bodies.push(m[1] ?? "");
  }
  return bodies;
}

const dist = openclawDist();
const runnerSources = readDistSources(dist, /^prepare\.runtime.*\.m?js$/).filter((src) =>
  src.includes("unsupportedIsolatedCompletionError("),
);
const scratch = mkdtempSync(join(tmpdir(), "mc-137-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function verifiedLaunch() {
  mkdirSync(join(scratch, "bin"), { recursive: true });
  const bin = join(scratch, "bin", "claude");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: join(scratch, "bin") }, platform: "darwin" });
}

const isolatedContext = (provider: string) => ({
  workspaceDir: scratch,
  agentDir: join(scratch, "agent"),
  provider,
  modelId: "claude-haiku-5-5",
  executionMode: "side-question" as const,
  toolAvailability: { native: [], openClaw: [] },
  isolatedCompletionCwd: scratch,
  isolatedCompletionModelId: "claude-haiku-5-5",
  isolatedCompletionPrompt: "Label this conversation in three words.",
  isolatedCompletionSystemPrompt: "Reply with the label only.",
}) satisfies Parameters<NonNullable<ReturnType<typeof buildBackend>["prepareExecution"]>>[0] &
  PrivateIsolatedContext;

describe(`OpenClaw's isolated-completion gate is a private contract (${dist})`, () => {
  test("core refuses any backend whose prepareExecution does not set isolatedCompletionEnforced", () => {
    expect(runnerSources.length).toBeGreaterThan(0);
    for (const src of runnerSources) expect(src).toMatch(REFUSAL_GATE);
    // 2026.8.1 inlines the error builder into the runner chunk; 2026.10+ imports it
    // from an execution-target chunk, so the operator-facing text is searched dist-wide.
    const refusalText = readDistSources(dist, /\.m?js$/).filter((src) =>
      src.includes("does not support isolated completion; OpenClaw did not start the run."),
    );
    expect(refusalText.length).toBeGreaterThan(0);
  });

  test("core hands the private isolatedCompletion* context to every backend's prepareExecution", () => {
    for (const src of runnerSources) {
      expect(src).toContain("isolatedCompletionPrompt: params.prompt");
      expect(src).toContain("isolatedCompletionSystemPrompt: params.extraSystemPrompt");
      expect(src).toContain("isolatedCompletionCwd: cwd");
      expect(src).toContain("isolatedCompletionModelId: normalizedModel");
    }
  });

  test("the public SDK CliBackendPreparedExecution type still omits isolatedCompletionEnforced (flips when upstream publishes it)", () => {
    const bodies = publicPreparedExecutionTypes(dist);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain("toolAvailabilityEnforced?: true");
      expect(body).not.toContain("isolatedCompletionEnforced");
    }
  });
});

describe("the pool documents its refusal instead of faking isolation", () => {
  test("a verified launch returns env only: no isolatedCompletionEnforced, no transport", async () => {
    const backend = buildBackend({ id: "claw1", configDir: join(scratch, "claw1-login") }, undefined, verifiedLaunch());
    const prepared = (await backend.prepareExecution!(isolatedContext("claw1"))) as
      | ({ isolatedCompletionEnforced?: true; execute?: unknown; env?: Record<string, string> } | null | undefined);
    expect(prepared?.env?.CLAUDE_CONFIG_DIR).toBe(join(scratch, "claw1-login"));
    expect(prepared?.execute).toBeUndefined();
    expect(prepared?.isolatedCompletionEnforced).toBeUndefined();
  });

  test("a legacy launch returns env only as well", async () => {
    const backend = buildBackend({ id: "claw1", configDir: join(scratch, "claw1-login") });
    const prepared = (await backend.prepareExecution!(isolatedContext("claw1"))) as
      | ({ isolatedCompletionEnforced?: true; execute?: unknown } | null | undefined);
    expect(prepared?.execute).toBeUndefined();
    expect(prepared?.isolatedCompletionEnforced).toBeUndefined();
  });

  test("the pool declares the side-question contract it would have to enforce", () => {
    const backend = buildBackend({ id: "claw1", configDir: join(scratch, "claw1-login") });
    expect(backend.sideQuestionToolMode).toBe("disabled");
    expect(backend.toolAvailabilityEnforcement).toBe("execution-args");
  });
});

/** Run the installed dist's bundled Claude resolver in its own process (no version mixing). */
function bundledExecutionArgs(ctx: Record<string, unknown>): string[] | undefined {
  const script = [
    'import { pathToFileURL } from "node:url";',
    "const [dist, ctxJson] = process.argv.slice(1);",
    "const shared = await import(pathToFileURL(`${dist}/extensions/anthropic/cli-shared.js`).href);",
    "if (typeof shared.resolveClaudeCliExecutionArgs !== 'function') { console.log('null'); process.exit(0); }",
    "console.log(JSON.stringify(shared.resolveClaudeCliExecutionArgs(JSON.parse(ctxJson))));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, "--", dist, JSON.stringify(ctx)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: scratch },
    timeout: 60_000,
  }).trim();
  const parsed = JSON.parse(out) as string[] | null;
  return parsed ?? undefined;
}

describe(`the side-question projection matches the bundled resolver (closed by #142) (${dist})`, () => {
  const backend = buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" }, undefined, verifiedLaunch());
  const baseArgs = [...(backend.config.args ?? [])];
  const sideQuestion = (toolAvailability?: { native: string[]; openClaw: string[] }) => ({
    baseArgs,
    workspaceDir: "/tmp",
    provider: "claw1",
    modelId: "claude-haiku-5-5",
    executionMode: "side-question" as const,
    useResume: false,
    ...(toolAvailability ? { toolAvailability } : {}),
  });

  test("an isolated completion's argv carries every bundled session-persistence and turn bound", () => {
    const bundled = bundledExecutionArgs(sideQuestion({ native: [], openClaw: [] }));
    if (!bundled) return; // dist does not export the resolver: nothing to compare against
    const pool = [...(backend.resolveExecutionArgs!(sideQuestion({ native: [], openClaw: [] })) ?? [])];
    // Tool-free, settings-free and MCP-free on both: the exact-cap port already covers that.
    for (const shared of ["--tools", "--setting-sources", "--settings", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome"]) {
      expect(pool).toContain(shared);
      expect(bundled).toContain(shared);
    }
    const missing = bundled.filter((arg) => !pool.includes(arg));
    expect(missing).toEqual([]);
    // Full parity: the projection now yields the bundled argv exactly.
    expect(pool.filter((arg) => !bundled.includes(arg))).toEqual([]);
  });

  test("an ordinary side-question is projected tool-free, matching the bundled backend", () => {
    const bundled = bundledExecutionArgs(sideQuestion());
    if (!bundled) return;
    const pool = [...(backend.resolveExecutionArgs!(sideQuestion()) ?? [])];
    // #142: the pool no longer hands a side question the full agent argv.
    expect(pool).not.toEqual(baseArgs);
    expect(pool).not.toContain("--allowedTools");
    expect(bundled.filter((arg) => !pool.includes(arg))).toEqual([]);
  });
});
