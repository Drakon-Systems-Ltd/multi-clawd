import process from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import plugin, { buildBackend, CLEAR_ENV } from "../src/index.js";
import { loadBundledCatalog } from "../src/catalog-source.js";
import {
  compareCalVer,
  installedOpenClawRoot,
  installedOpenClawVersion,
  readUpstreamClaudeClearEnv,
} from "./support/openclaw-upstream.js";

// Lowest OpenClaw this package supports (package.json peerDependencies).
const MIN_SUPPORTED_OPENCLAW = "2026.8.1";

function anthropicExtensionDir(): string {
  return join(installedOpenClawRoot(), "dist", "extensions", "anthropic");
}

/**
 * Fixture trees for the resolver's own tests. These are SYNTHETIC: they prove
 * the resolver handles each upstream layout, not that any OpenClaw release has
 * that layout. The real-install tests below are the ones that cover upstream.
 */
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-sdk-contract-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});
function makeFixture(files: Record<string, string>): string {
  const dir = fixtureDir(files);
  fixtures.push(dir);
  return dir;
}

describe("OpenClaw install under test (real package, not a fixture)", () => {
  test("is at or above the supported floor, and matches MULTI_CLAWD_EXPECT_OPENCLAW when the CI matrix sets it", () => {
    const version = installedOpenClawVersion();
    expect(compareCalVer(version, MIN_SUPPORTED_OPENCLAW)).toBeGreaterThanOrEqual(0);
    const expected = process.env.MULTI_CLAWD_EXPECT_OPENCLAW;
    // The compat matrix installs a specific release over the pinned devDependency.
    // If that install silently did not take, fail instead of re-testing 2026.8.1.
    if (expected) expect(version).toBe(expected);
  });
});

describe("upstream clear-env resolver (synthetic fixture trees)", () => {
  const LIST = 'export const CLAUDE_CLI_CLEAR_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];\n';

  test("reads the 2026.9+ layout from cli-constants.js", async () => {
    const dir = makeFixture({ "cli-constants.js": LIST });
    await expect(readUpstreamClaudeClearEnv(dir)).resolves.toEqual({
      names: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
      source: "cli-constants.js",
    });
  });

  test("falls back to the 2026.8.x layout in cli-shared.js", async () => {
    const dir = makeFixture({ "cli-shared.js": LIST });
    await expect(readUpstreamClaudeClearEnv(dir)).resolves.toMatchObject({ source: "cli-shared.js" });
  });

  test("falls back when cli-constants.js exists but no longer exports the list", async () => {
    const dir = makeFixture({ "cli-constants.js": "export const OTHER = 1;\n", "cli-shared.js": LIST });
    await expect(readUpstreamClaudeClearEnv(dir)).resolves.toMatchObject({ source: "cli-shared.js" });
  });

  test("throws a descriptive error, never an empty list, when upstream moves it again", async () => {
    const dir = makeFixture({ "cli-shared.js": "export const SOMETHING_ELSE = [];\n" });
    const error = await readUpstreamClaudeClearEnv(dir).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/Unsupported OpenClaw contract/);
    expect(error!.message).toMatch(/cli-constants\.js: file not found/);
    expect(error!.message).toMatch(/cli-shared\.js: CLAUDE_CLI_CLEAR_ENV is not a non-empty string\[\]/);
    expect(error!.message).toMatch(/CLEAR_ENV_SOURCES/);
  });
});

describe("current OpenClaw plugin SDK contract", () => {
  test("clearEnv covers the installed OpenClaw backend plus CLAUDE_CONFIG_DIR isolation", async () => {
    const { names: upstream } = await readUpstreamClaudeClearEnv();
    expect(CLEAR_ENV).toEqual(expect.arrayContaining(upstream));
    expect(CLEAR_ENV).toContain("CLAUDE_CONFIG_DIR");
    expect(CLEAR_ENV.filter((name) => name !== "CLAUDE_CONFIG_DIR")).toEqual(upstream);
  });

  test("the plugin entry registers a CLI backend and provider from the live runtime config", () => {
    const backends: unknown[] = [];
    const providers: unknown[] = [];
    const hooks: string[] = [];
    const config = {
      plugins: {
        entries: {
          "multi-clawd": {
            config: { accounts: [{ id: "claw1", native: true }] },
          },
        },
      },
      tools: { exec: { mode: "ask" } },
    };
    const api = {
      config: {},
      pluginConfig: {},
      runtime: { config: { current: () => config } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: (backend: unknown) => backends.push(backend),
      registerProvider: (provider: unknown) => providers.push(provider),
      on: (name: string) => hooks.push(name),
    };

    // The launch mode depends on whether `claude` is on PATH; pin it to "not
    // found" so this test sees the legacy launch on every machine.
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

    expect(backends).toHaveLength(1);
    expect(backends[0]).toMatchObject({ id: "claw1", config: { command: process.execPath } });
    expect((backends[0] as { runtimeArtifact?: unknown }).runtimeArtifact).toBeUndefined();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "claw1", auth: [] });
    expect(hooks).toContain("heartbeat_prompt_contribution");
  });

  test("our CLI backend keeps the stable bundled execution contract", async () => {
    const backendPath = join(anthropicExtensionDir(), "cli-backend.js");
    const upstream = await import(pathToFileURL(backendPath).href) as {
      buildAnthropicCliBackend?: () => { config?: Record<string, unknown> };
    };
    expect(typeof upstream.buildAnthropicCliBackend).toBe("function");
    const bundled = upstream.buildAnthropicCliBackend!();
    const ours = buildBackend({ id: "claw1", native: true });
    expect(ours.config).toMatchObject({
      output: bundled.config?.output,
      liveSession: bundled.config?.liveSession,
      input: bundled.config?.input,
      sessionArgs: bundled.config?.sessionArgs,
      freshSessionRecovery: bundled.config?.freshSessionRecovery,
    });
    expect(ours.config.clearEnv).toEqual(
      expect.arrayContaining(bundled.config?.clearEnv as string[]),
    );
    expect(ours.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect((ours.config as { sessionArg?: string }).sessionArg).toBe("--session-id");
  });

  test("secret refs resolve through the live 2.0 SDK without exposing values", async () => {
    const ref = {
      source: "env" as const,
      provider: "default",
      id: "MULTI_CLAWD_CONTRACT_PLACEHOLDER",
    };
    const resolved = await resolveSecretRefValues([ref], {
      config: {},
      env: { MULTI_CLAWD_CONTRACT_PLACEHOLDER: "contract-placeholder" },
    });
    expect(resolved.get("env:default:MULTI_CLAWD_CONTRACT_PLACEHOLDER")).toBe(
      "contract-placeholder",
    );
  });

  test("the bundled Claude catalog remains loadable from the packaged runtime", async () => {
    // OpenClaw <= 2026.8 ships cli-catalog.js; 2026.9+ removed it and declares
    // the models in the plugin manifest. Either way the mirror must produce
    // ids, and from the source that matches what is actually installed, so a
    // silent fall-through to the built-in list cannot pass.
    const hasLegacyModule = existsSync(join(anthropicExtensionDir(), "cli-catalog.js"));
    const catalog = await loadBundledCatalog();
    expect(catalog, "neither cli-catalog.js nor the bundled manifest modelCatalog yielded ids").not.toBeNull();
    expect(catalog!.source).toBe(hasLegacyModule ? "cli-catalog" : "manifest");
    expect(catalog!.ids).toEqual(expect.arrayContaining([expect.stringMatching(/^claude-/)]));
  });

  test("the plugin avoids 2.0 private-local and deprecated SDK subpaths", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /openclaw\/plugin-sdk\/(?:cli-backend|provider-model-shared|plugin-config-runtime)/,
    );
  });
});