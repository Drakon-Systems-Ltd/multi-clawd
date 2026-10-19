/**
 * Evidence from OpenClaw itself, not from our reading of it: drive the host's
 * own CLI execution-target selection with what our backend's prepareExecution
 * returns, and check the runner hands a plugin target to the transport.
 *
 * OpenClaw does not export the runner's target selection on every release
 * (2026.8.1 keeps `resolveCliExecutionTarget` module-private; 2026.10.x exports
 * it from a hashed chunk), so the dist is searched by shape. Point
 * MULTI_CLAWD_OPENCLAW_DIST at another installed `openclaw/dist` to check a
 * different host; when no dist exposes the function the test reports a skip.
 *
 * The full runner (`executePreparedCliRun`) is not driven: it requires a live
 * admitted-run authority that only the gateway's admission path can mint.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildBackend, resolveBackendLaunch } from "../src/index.js";

type ExecutionTarget = { kind: string; execute?: unknown };
type ResolveTarget = (context: {
  backendId: string;
  params: Record<string, unknown>;
  execute?: unknown;
}) => ExecutionTarget;

function openclawDist(): string {
  if (process.env.MULTI_CLAWD_OPENCLAW_DIST) return process.env.MULTI_CLAWD_OPENCLAW_DIST;
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("openclaw"));
}

async function loadHostTargetSelection(): Promise<{ resolve?: ResolveTarget; runnerSource?: string; dist: string }> {
  const dist = openclawDist();
  const files = readdirSync(dist).filter((f) => /\.(m?js)$/.test(f));
  let resolve: ResolveTarget | undefined;
  let runnerSource: string | undefined;
  for (const f of files) {
    const src = readFileSync(join(dist, f), "utf8");
    if (!runnerSource && src.includes("executePluginOwnedProcess(")) runnerSource = src;
    if (resolve || !src.includes("function resolveCliExecutionTarget(")) continue;
    const alias = /resolveCliExecutionTarget as ([A-Za-z_$][\w$]*)/.exec(src)?.[1];
    if (!alias) continue;
    const mod = (await import(pathToFileURL(join(dist, f)).href)) as Record<string, unknown>;
    if (typeof mod[alias] === "function") resolve = mod[alias] as ResolveTarget;
  }
  return { resolve, runnerSource, dist };
}

const host = await loadHostTargetSelection();
const scratch = mkdtempSync(join(tmpdir(), "mc-host-target-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function verifiedBackend() {
  mkdirSync(join(scratch, "bin"), { recursive: true });
  const bin = join(scratch, "bin", "claude");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  const launch = resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: join(scratch, "bin") }, platform: "darwin" });
  return buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" }, undefined, launch);
}

describe.skipIf(!host.resolve)(`OpenClaw's own execution-target selection (${host.dist})`, () => {
  test("an agent turn's prepared transport becomes the host's plugin execution target", async () => {
    const prepared = await verifiedBackend().prepareExecution!({
      workspaceDir: "/tmp", provider: "claw1", modelId: "claude-fable-5", executionMode: "agent",
    });
    const target = host.resolve!({ backendId: "claw1", params: {}, execute: prepared?.execute });
    expect(target.kind).toBe("plugin");
    expect(target.execute).toBe(prepared?.execute);
  });

  test("a side-question has no transport, so the host runs (and verifies) the process itself", async () => {
    const prepared = await verifiedBackend().prepareExecution!({
      workspaceDir: "/tmp", provider: "claw1", modelId: "claude-fable-5", executionMode: "side-question",
    });
    expect(host.resolve!({ backendId: "claw1", params: {}, execute: prepared?.execute }).kind).toBe("process");
  });

  test("the runner dispatches a plugin target to the transport", () => {
    expect(host.runnerSource).toBeDefined();
    expect(host.runnerSource).toMatch(/executionTarget\.kind === "plugin"\) result = await executePluginOwnedProcess\(/);
    expect(host.runnerSource).toMatch(/iterator = params\.execute\(/);
  });
});
