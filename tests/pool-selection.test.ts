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

function writeState(
  accountId: string,
  windows: Record<string, unknown>,
  credential?: Record<string, unknown>,
): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ accountId, updatedAt: Date.now(), windows, credential }),
  );
}

interface Registered {
  prepare: (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }>;
  logs: { info: string[]; warn: string[]; error: string[] };
}

function registerPool(poolOverrides: Record<string, unknown> = {}): Registered {
  let backend: { id?: string; prepareExecution?: unknown } | undefined;
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const api = {
    logger: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    registerCliBackend: (b: { id?: string; prepareExecution?: unknown }) => {
      if (b.id === "clawd" || b.prepareExecution) backend = b;
    },
    registerProvider: () => {},
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"], ...poolOverrides },
    [
      { id: "claw1", configDir: "/tmp/claw1-login" },
      { id: "claw2", configDir: "/tmp/claw2-login" },
    ],
    new Set(["claw1", "claw2"]),
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  return { prepare: backend.prepareExecution as Registered["prepare"], logs };
}

/** The account a launch would actually run on, read off the prepared env. */
async function chosenAccount(
  modelId = "clawd/claude-opus-5",
  poolOverrides: Record<string, unknown> = {},
): Promise<string> {
  const { prepare } = registerPool(poolOverrides);
  const { env } = await prepare({ modelId, workspaceDir: "/tmp/ws" });
  return env.MULTI_CLAWD_ACCOUNT_ID ?? env.CLAUDE_CONFIG_DIR ?? "(none)";
}

/** The exact quota shape from #8: both accounts report five_hour `allowed`. */
function writeAllowedQuota(accountId: string): void {
  writeState(accountId, {
    five_hour: { status: "allowed", utilization: 0.1, resetsAt: NOW_S() + 3600, seenAt: Date.now() },
  });
}

const SESSION_EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

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

/**
 * Issue #8: the selected native account returns HTTP 410 session_expired, the
 * pool never learns, and every clawd/* rung re-selects the same dead login.
 * These drive the SAME wire as the suite above — real state files, real
 * prepareExecution — because the bug was never in the classifier, it was in
 * what selection was allowed to see.
 */
describe("credential-health failover wiring (#8)", () => {
  test("quota says allowed but the login is dead: the launch goes to the spare", async () => {
    // The exact #8 control: both quota files report five_hour `allowed`, so
    // nothing in the quota dimension can distinguish these accounts. Only the
    // credential record can, and before this fix it did not exist.
    writeState(
      "claw1",
      { five_hour: { status: "allowed", utilization: 0.1, seenAt: Date.now() } },
      { status: "failed", reason: SESSION_EXPIRED, seenAt: Date.now() },
    );
    writeAllowedQuota("claw2");
    expect(await chosenAccount()).toContain("claw2");
  });

  test("four consecutive pooled rungs do not all land on the dead account", async () => {
    // The observed trace: clawd/claude-fable-5, opus-4-8, opus-4-7, sonnet-5,
    // four identical session_expired 410s in one run. Each rung is a fresh
    // prepareExecution against unchanged state, which is why re-running the
    // selection has to keep excluding claw1 rather than returning home.
    writeState(
      "claw1",
      { five_hour: { status: "allowed", seenAt: Date.now() } },
      { status: "failed", reason: SESSION_EXPIRED, seenAt: Date.now() },
    );
    writeAllowedQuota("claw2");
    const rungs = [
      "clawd/claude-fable-5",
      "clawd/claude-opus-4-8",
      "clawd/claude-opus-4-7",
      "clawd/claude-sonnet-5",
    ];
    const chosen: string[] = [];
    for (const rung of rungs) chosen.push(await chosenAccount(rung));
    expect(chosen).toHaveLength(4);
    expect(chosen.every((c) => c.includes("claw2"))).toBe(true);
    expect(chosen.some((c) => c.includes("claw1"))).toBe(false);
  });

  test("a cleared credential (successful run / re-auth) returns the pool home", async () => {
    writeState(
      "claw1",
      { five_hour: { status: "allowed", seenAt: Date.now() } },
      { status: "failed", reason: SESSION_EXPIRED, seenAt: Date.now() },
    );
    writeAllowedQuota("claw2");
    // minDwellMs 0: this asserts the CREDENTIAL exclusion lifted, not that
    // sticky dwell elapsed (dwell is covered in sticky.test.ts).
    expect(await chosenAccount("clawd/claude-fable-5", { minDwellMs: 0 })).toContain("claw2");

    // What a successful execution through the shim, or `multi-clawd login
    // claw1`, writes: an "ok" record that outranks the stale failure.
    writeState(
      "claw1",
      { five_hour: { status: "allowed", seenAt: Date.now() } },
      { status: "ok", seenAt: Date.now() },
    );
    expect(await chosenAccount("clawd/claude-fable-5", { minDwellMs: 0 })).toContain("claw1");
  });

  test("the exclusion ages out on its own, so a login fixed out-of-band recovers", async () => {
    // 16 minutes old: past CREDENTIAL_FAILED_TTL_MS. Nothing cleared it
    // explicitly, so the account is re-tried (and if still dead, the very next
    // launch records it again).
    writeState(
      "claw1",
      { five_hour: { status: "allowed", seenAt: Date.now() } },
      { status: "failed", reason: SESSION_EXPIRED, seenAt: Date.now() - 16 * 60 * 1000 },
    );
    writeAllowedQuota("claw2");
    expect(await chosenAccount()).toContain("claw1");
  });

  test("every login dead: one hard auth error naming re-authentication, not a launch", async () => {
    const dead = { status: "failed", reason: SESSION_EXPIRED, seenAt: Date.now() };
    writeState("claw1", { five_hour: { status: "allowed", seenAt: Date.now() } }, dead);
    writeState("claw2", { five_hour: { status: "allowed", seenAt: Date.now() } }, dead);
    const { prepare, logs } = registerPool();
    await expect(
      prepare({ modelId: "clawd/claude-fable-5", workspaceDir: "/tmp/ws" }),
    ).rejects.toThrow(/re-authenticate/i);
    // Exactly one operator-facing error for the whole pool, and it names the fix.
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]).toMatch(/multi-clawd login/);
  });

  test("credential failure and quota exhaustion are reported as different problems", async () => {
    // Both are "this account cannot serve you", but the operator's action is
    // different — wait vs log back in — so the surfaced reasons must not blur.
    const deadState = {
      accountId: "claw1",
      windows: { five_hour: { status: "allowed", seenAt: Date.now() } },
      credential: { status: "failed" as const, reason: SESSION_EXPIRED, seenAt: Date.now() },
    };
    const exhaustedState = {
      accountId: "claw1",
      windows: {
        five_hour: { status: "rejected", resetsAt: NOW_S() + 1800, seenAt: Date.now() },
      },
    };
    const { classifyAccountHealth } = await import("../src/health.js");
    const dead = classifyAccountHealth(deadState, {}, Date.now());
    const exhausted = classifyAccountHealth(exhaustedState, {}, Date.now());
    expect(dead.verdict).toBe("credential_failed");
    expect(exhausted.verdict).toBe("exhausted");
    expect(dead.reason).toMatch(/re-authenticate/i);
    expect(dead.reason).not.toMatch(/utilization|rejected until/);
    expect(exhausted.reason).not.toMatch(/re-authenticate/i);
  });
});
