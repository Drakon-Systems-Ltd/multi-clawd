import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<Record<string, string>>,
  failTransport: false,
}));
vi.mock("../src/shim-transport.js", () => ({
  createShimExecute: () => async function* (execution: { env: Record<string, string> }) {
    state.calls.push(execution.env);
    yield { type: "item" };
    if (state.failTransport) throw new Error("transport failed");
  },
}));

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend } = await import("../src/index.js");
const { recordSessionPin } = await import("../src/session-affinity.js");
const { RETRY_ROSTER_ENV } = await import("../src/retry-plan.js");
const ref = (id: string) => ({ source: "exec", provider: "test", id });

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-affinity-execute-"));
  state.calls = [];
  state.failTransport = false;
});
afterEach(() => rmSync(home.dir, { recursive: true, force: true }));

async function prepared(failPinned = false) {
  let backend: { prepareExecution?: (ctx: unknown) => Promise<{
    env: Record<string, string>;
    execute?: (execution: unknown) => AsyncIterable<Record<string, unknown>>;
  }> } | undefined;
  const api = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerCliBackend: (value: { id: string }) => {
      if (value.id === "clawd") backend = value as typeof backend;
    },
    registerProvider: () => {},
  } as never;
  const resolver = {
    resolve: async (value: { id: string }) => {
      if (failPinned && value.id === "claw2") throw new Error("resolver failed");
      return `token-${value.id}`;
    },
  } as never;
  registerPoolBackend(api, { id: "clawd", accounts: ["claw1", "claw2", "claw3"], sessionAffinity: true }, [
    { id: "claw1", configDir: "/prepared", oauthTokenRef: ref("claw1") },
    { id: "claw2", oauthTokenRef: ref("claw2") },
    { id: "claw3", configDir: "/third" },
  ], new Set(["claw1", "claw2", "claw3"]), undefined, {
    resolver,
    launch: { kind: "verified", claudeCommand: "/bin/true", claudeSource: "PATH", shimPath: "/shim" } as never,
  });
  recordSessionPin(join(home.dir, ".openclaw", "state", "multi-clawd", "pool-clawd.sessions.json"),
    "sessionA", "claw2", Date.now(), 30 * 24 * 60 * 60 * 1000);
  const result = await backend!.prepareExecution!({
    workspaceDir: "/tmp/ws", provider: "clawd", modelId: "claude-fable-5", executionMode: "agent",
  });
  return { result, execution: { args: ["--resume", "sessionA"], env: result.env } };
}

async function consume(stream: AsyncIterable<Record<string, unknown>>) {
  const items = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("verified session affinity execute", () => {
  test("a transport failure after output propagates without a second launch", async () => {
    const { result, execution } = await prepared();
    state.failTransport = true;
    await expect(consume(result.execute!(execution))).rejects.toThrow("transport failed");
    expect(state.calls).toHaveLength(1);
  });

  test("pinned credential resolution failure uses the prepared execution once", async () => {
    const { result, execution } = await prepared(true);
    await consume(result.execute!(execution));
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toBe(execution.env);
    expect(state.calls[0].MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
  });

  test("resolved pin replaces prepared credentials and excludes the pinned account from retries", async () => {
    const { result, execution } = await prepared();
    await consume(result.execute!(execution));
    expect(state.calls).toHaveLength(1);
    const env = state.calls[0];
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-claw2");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(JSON.parse(env[RETRY_ROSTER_ENV]).map((member: { id: string }) => member.id)).toEqual(["claw3"]);
  });
});
