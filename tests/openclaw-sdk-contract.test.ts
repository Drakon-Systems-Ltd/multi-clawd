import process from "node:process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import plugin, { buildBackend, CLEAR_ENV } from "../src/index.js";
import { loadBundledCatalogIds } from "../src/catalog-source.js";

const require = createRequire(import.meta.url);

function upstreamPackageRoot(): string {
  const entry = require.resolve("openclaw");
  const packageJson = JSON.parse(
    readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
  ) as { version?: string };
  expect(packageJson.version).toBe("2026.8.1");
  return dirname(entry);
}

async function upstreamClaudeClearEnv(): Promise<string[]> {
  const sharedPath = join(upstreamPackageRoot(), "extensions", "anthropic", "cli-shared.js");
  const shared = await import(pathToFileURL(sharedPath).href) as {
    CLAUDE_CLI_CLEAR_ENV?: unknown;
  };
  expect(Array.isArray(shared.CLAUDE_CLI_CLEAR_ENV)).toBe(true);
  return shared.CLAUDE_CLI_CLEAR_ENV as string[];
}

describe("current OpenClaw plugin SDK contract", () => {
  test("clearEnv covers the installed OpenClaw backend plus CLAUDE_CONFIG_DIR isolation", async () => {
    const upstream = await upstreamClaudeClearEnv();
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

    plugin.register(api as never);

    expect(backends).toHaveLength(1);
    expect(backends[0]).toMatchObject({ id: "claw1", config: { command: process.execPath } });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "claw1", auth: [] });
    expect(hooks).toContain("heartbeat_prompt_contribution");
  });

  test("our CLI backend keeps the stable bundled execution contract", async () => {
    const backendPath = join(
      upstreamPackageRoot(),
      "extensions",
      "anthropic",
      "cli-backend.js",
    );
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
    const ids = await loadBundledCatalogIds();
    expect(ids).not.toBeNull();
    expect(ids).toEqual(expect.arrayContaining([expect.stringMatching(/^claude-/)]));
  });

  test("the plugin avoids 2.0 private-local and deprecated SDK subpaths", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /openclaw\/plugin-sdk\/(?:cli-backend|provider-model-shared|plugin-config-runtime)/,
    );
  });
});