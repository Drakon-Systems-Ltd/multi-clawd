/**
 * Regression: an exhaustion alert must not outlive the exhaustion (#15).
 *
 * Friday's box (Michael's MacBook) declared "pool clawd: every account is
 * exhausted" on its 10:20Z and 11:20Z heartbeat wakes — naming four models —
 * while interactive turns through the same gateway ran Claude fine. The pool
 * was healthy; the wakes were reading `pool-exhausted:clawd:<model>` keys
 * raised during a real 09:20Z outage and never cleared, sitting out the 6h
 * error TTL. Alerts reach the operator through the heartbeat hook alone, which
 * is why only wakes lied.
 *
 * Driven through the real wire — real state files, real prepareExecution, the
 * real rendered heartbeat text — because the classifier was never wrong. The
 * missing step was between a recovered pool and what the operator was told.
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

const NOW_S = () => Math.floor(Date.now() / 1000);

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

/** Both accounts out of five-hour quota, for every model. */
function writeExhausted(accountId: string): void {
  writeState(accountId, {
    five_hour: { status: "rejected", resetsAt: NOW_S() + 1800, seenAt: Date.now() },
  });
}

/** Both accounts healthy again — the shape after a window reset. */
function writeHealthy(accountId: string): void {
  writeState(accountId, {
    five_hour: {
      status: "allowed",
      utilization: 0.1,
      resetsAt: NOW_S() + 3600,
      seenAt: Date.now(),
    },
  });
}

function registerPool(): (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }> {
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
    { id: "clawd", accounts: ["claw1", "claw2"] },
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
  home.dir = mkdtempSync(join(tmpdir(), "mc-exhaustion-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("exhaustion alert lifecycle", () => {
  test("a recovered pool stops telling the operator it is exhausted", async () => {
    const prepare = registerPool();
    for (const id of ["claw1", "claw2"]) writeExhausted(id);

    // The outage: the chain walks its rungs, each writing its own alert key.
    for (const model of [
      "clawd/claude-opus-5",
      "clawd/claude-fable-5",
      "clawd/claude-opus-4-8",
      "clawd/claude-sonnet-5",
    ]) {
      await prepare({ modelId: model, workspaceDir: "/tmp/ws" });
    }
    const during = pendingOperatorAlerts(Date.now());
    expect(during).toContain("every account is exhausted");
    expect(during).toContain("claude-sonnet-5");

    // The windows reset. One launch on ONE model is all that happens next —
    // the operator never re-requests the other three, which is exactly how
    // four gravestones survived on Friday's box.
    for (const id of ["claw1", "claw2"]) writeHealthy(id);
    await prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });

    expect(pendingOperatorAlerts(Date.now())).toBeUndefined();
  });

  test("a model that is still exhausted keeps its alert when another recovers", async () => {
    const prepare = registerPool();
    // Model-scoped rejection (the reactive 429 capture): sonnet-5 only.
    for (const id of ["claw1", "claw2"]) {
      writeState(id, {
        five_hour: {
          status: "rejected",
          model: "claude-sonnet-5",
          resetsAt: NOW_S() + 1800,
          seenAt: Date.now(),
        },
      });
    }
    await prepare({ modelId: "clawd/claude-sonnet-5", workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now())).toContain("claude-sonnet-5");

    // A healthy launch on a DIFFERENT model must not clear a live claim about
    // sonnet-5 — the sweep re-checks, it does not assume.
    await prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now())).toContain("claude-sonnet-5");
  });
});
