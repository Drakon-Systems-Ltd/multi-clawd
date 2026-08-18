/**
 * #14, delivery half: the pool declining to rotate on paid spill-over is only
 * the right behaviour if the owner is TOLD, and told through the one surface
 * they actually read — the heartbeat. A silent non-decision is just a pool
 * that stopped rotating for no visible reason.
 *
 * Driven through the real wire (state files → prepareExecution → the rendered
 * heartbeat text) for the same reason the exhaustion-lifecycle test is: the
 * classifier being right was never the question.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile, pendingOperatorAlerts } = await import(
  "../src/index.js"
);

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

/** The live two-window shape: spill-over nearly spent, real quota fine. */
function writeOverageHot(accountId: string): void {
  writeState(accountId, {
    seven_day_overage_included: { status: "allowed", utilization: 0.96, seenAt: Date.now() },
    seven_day: { status: "allowed", utilization: 0.75, seenAt: Date.now() },
  });
}

function writeComfortable(accountId: string): void {
  writeState(accountId, {
    seven_day: { status: "allowed", utilization: 0.2, seenAt: Date.now() },
  });
}

function registerPool(
  pool: Record<string, unknown> = {},
): (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }> {
  let backend: { id?: string; prepareExecution?: unknown } | undefined;
  const api = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerCliBackend: (b: { id?: string; prepareExecution?: unknown }) => {
      if (b.id === "clawd" || b.prepareExecution) backend = b;
    },
    registerProvider: () => {},
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"], ...pool },
    [
      { id: "claw1", configDir: "/tmp/claw1-login" },
      { id: "claw2", configDir: "/tmp/claw2-login" },
    ],
    new Set(["claw1", "claw2"]),
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  return backend.prepareExecution as (
    ctx: Record<string, unknown>,
  ) => Promise<{ env: Record<string, string> }>;
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-overage-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the owner is asked, on the surface they read", () => {
  test("a launch with spill-over nearly spent puts the question in the heartbeat", async () => {
    const prepare = registerPool();
    writeOverageHot("claw1");
    writeComfortable("claw2");

    await prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" });

    const text = pendingOperatorAlerts(Date.now()) ?? "";
    expect(text).toContain("claw1");
    expect(text).toContain("96%");
    expect(text).toContain("rotateOnOverage");
  });

  test("the question stops being asked once the condition clears", async () => {
    const prepare = registerPool();
    writeOverageHot("claw1");
    writeComfortable("claw2");
    await prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now()) ?? "").toContain("rotateOnOverage");

    // Weekly resets: spill-over is no longer nearly spent.
    writeComfortable("claw1");
    await prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" });

    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toContain("rotateOnOverage");
  });

  test("having opted in, the pool acts instead of asking", async () => {
    const prepare = registerPool({ rotateOnOverage: true });
    writeOverageHot("claw1");
    writeComfortable("claw2");

    await prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" });

    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toContain("rotateOnOverage");
  });

  test("the pool still serves the account it declined to rotate off", async () => {
    const prepare = registerPool();
    writeOverageHot("claw1");
    writeComfortable("claw2");

    const { env } = await prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" });

    // Home account keeps the work: spill-over alone is not a reason to move.
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
  });
});
