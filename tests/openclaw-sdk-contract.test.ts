import process from "node:process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import plugin, { CLEAR_ENV } from "../src/index.js";

const require = createRequire(import.meta.url);

async function upstreamClaudeClearEnv(): Promise<string[]> {
  const entry = require.resolve("openclaw");
  const packageJson = JSON.parse(
    readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
  ) as { version?: string };
  expect(packageJson.version).toBe("2026.7.1");
  const sharedPath = join(dirname(entry), "extensions", "anthropic", "cli-shared.js");
  const shared = await import(pathToFileURL(sharedPath).href) as {
    CLAUDE_CLI_CLEAR_ENV?: unknown;
  };
  expect(Array.isArray(shared.CLAUDE_CLI_CLEAR_ENV)).toBe(true);
  return shared.CLAUDE_CLI_CLEAR_ENV as string[];
}

describe("current OpenClaw plugin SDK contract", () => {
  test("clearEnv exactly matches the installed OpenClaw backend", async () => {
    expect(CLEAR_ENV).toEqual(await upstreamClaudeClearEnv());
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
});