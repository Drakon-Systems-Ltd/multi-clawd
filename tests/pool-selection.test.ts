/**
 * Wiring test for pool account selection.
 *
 * Everything else in this suite tests the DECISION helpers — classify, choose,
 * sticky. Nothing tested the wire between them and the account a turn actually
 * launches on, which is the only part a user experiences. So this drives
 * `registerPoolBackend` end to end: real state files on disk, real
 * `prepareExecution`, and asserts on the credential env the child would get.
 *
 * Delete the health rules and these fail; delete only a helper's unit test and
 * nobody notices.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Must be hoisted above the import of index.ts: healthStateFile() resolves
// through homedir() at call time, but the module is evaluated on import.
const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile } = await import("../src/index.js");

const NOW_S = () => Math.floor(Date.now() / 1000);

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

interface Registered {
  prepare: (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }>;
}

function registerPool(): Registered {
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
  return { prepare: backend.prepareExecution as Registered["prepare"] };
}

/** The account a launch would actually run on, read off the prepared env. */
async function chosenAccount(): Promise<string> {
  const { prepare } = registerPool();
  const { env } = await prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });
  return env.MULTI_CLAWD_ACCOUNT_ID ?? env.CLAUDE_CONFIG_DIR ?? "(none)";
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-pool-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pool selection wiring", () => {
  test("with no telemetry at all, the launch stays on the home account", async () => {
    expect(await chosenAccount()).toContain("claw1");
  });

  test("a numberless 5-hour warning on home rotates the launch to the spare", async () => {
    // The exact shape Anthropic ships: status + reset, no utilization. Before
    // 1.7.2 this classified as `ok` and the turn stayed on claw1 until the
    // limit actually bit.
    writeState("claw1", {
      five_hour: { status: "allowed_warning", resetsAt: NOW_S() + 1800, seenAt: Date.now() },
    });
    expect(await chosenAccount()).toContain("claw2");
  });

  test("the same warning on the WEEKLY window does not rotate", async () => {
    writeState("claw1", {
      seven_day: { status: "allowed_warning", resetsAt: NOW_S() + 86_400, seenAt: Date.now() },
    });
    expect(await chosenAccount()).toContain("claw1");
  });

  test("a reset-less rejection on home rotates the launch to the spare", async () => {
    writeState("claw1", { five_hour: { status: "rejected", seenAt: Date.now() } });
    expect(await chosenAccount()).toContain("claw2");
  });

  test("an `unknown` rejection does not strand the account", async () => {
    // Live case: a Fable-only 429 lands here with no recognisable type.
    writeState("claw1", { unknown: { status: "rejected", seenAt: Date.now() } });
    expect(await chosenAccount()).toContain("claw1");
  });

  test("when both accounts are warning, the launch still goes somewhere", async () => {
    const w = { status: "allowed_warning", resetsAt: NOW_S() + 1800, seenAt: Date.now() };
    writeState("claw1", { five_hour: w });
    writeState("claw2", { five_hour: w });
    expect(await chosenAccount()).toContain("claw1");
  });
});
