/**
 * #93 on the real launch path: `registerPoolBackend` → `prepareExecution`
 * reading fixture health files from an isolated state dir. Fixture
 * credentials only (config-dir paths that do not exist); no provider is
 * contacted and no child is launched.
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

const { registerPoolBackend, healthStateFile } = await import("../src/index.js");
const { SESSION_AFFINITY_ENV } = await import("../src/session-affinity.js");

const NOW_S = () => Math.floor(Date.now() / 1000);
const HOUR = 3_600_000;

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

/** A live weekly window at the given utilization, as the shim records it. */
const weekly = (utilization: number, seenAgoMs = 1000) =>
  ({ status: utilization >= 0.85 ? "allowed_warning" : "allowed", utilization, resetsAt: NOW_S() + 3 * 86400, seenAt: Date.now() - seenAgoMs });

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
    { id: "clawd", accounts: ["claw1", "claw2", "claw3"], ...poolOverrides },
    [
      { id: "claw1", configDir: join(home.dir, "claw1-login") },
      { id: "claw2", configDir: join(home.dir, "claw2-login") },
      { id: "claw3", configDir: join(home.dir, "claw3-login") },
    ],
    new Set(["claw1", "claw2", "claw3"]),
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  return { prepare: backend.prepareExecution as Registered["prepare"], logs };
}

async function launch(poolOverrides: Record<string, unknown> = {}): Promise<{ account: string; env: Record<string, string>; logs: Registered["logs"] }> {
  const { prepare, logs } = registerPool(poolOverrides);
  const { env } = await prepare({ modelId: "clawd/claude-fable-5-1", workspaceDir: "/tmp/ws" });
  return { account: env.MULTI_CLAWD_ACCOUNT_ID, env, logs };
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-headroom-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("near-limit headroom on the launch path (#93)", () => {
  test("with every account near its limit the launch lands on the one with the most headroom, in every strategy", async () => {
    writeState("claw1", { seven_day: weekly(0.99) });
    writeState("claw2", { seven_day: weekly(0.86) });
    writeState("claw3", { seven_day: weekly(0.9) });
    expect((await launch()).account).toBe("claw2");
    for (const strategy of ["ordered", "reset-aware", "spread"]) {
      expect((await launch({ strategy })).account).toBe("claw2");
    }
  });

  test("the rotation away from home is logged and names the home account's reason, as before", async () => {
    writeState("claw1", { seven_day: weekly(0.99) });
    writeState("claw2", { seven_day: weekly(0.86) });
    writeState("claw3", { seven_day: weekly(0.9) });
    const { logs } = await launch();
    expect(logs.info.some((l) => /rotated to claw2 from claw1 \(seven_day utilization 0\.99 >= 0\.85\)/.test(l))).toBe(true);
  });

  test("a fresh usage-poll record outranks a stale stream record for the same window", async () => {
    // claw1's stream last saw 99% two hours ago; the poll read 86% a minute ago. claw2 is a fresh 90%.
    writeState("claw1", { seven_day: weekly(0.99, 2 * HOUR), "usage:seven_day": weekly(0.86, 60_000) });
    writeState("claw2", { seven_day: weekly(0.9) });
    writeState("claw3", { seven_day: weekly(0.95) });
    expect((await launch()).account).toBe("claw1");
  });

  test("a healthy sibling still wins over every near-limit account", async () => {
    writeState("claw1", { seven_day: weekly(0.86) });
    writeState("claw2", { seven_day: weekly(0.5) });
    writeState("claw3", { seven_day: weekly(0.99) });
    expect((await launch()).account).toBe("claw2");
  });

  test("a healthy home is never rotated away from, however much emptier a sibling is", async () => {
    writeState("claw1", { seven_day: weekly(0.84) });
    writeState("claw2", { seven_day: weekly(0.1) });
    writeState("claw3", { seven_day: weekly(0.2) });
    expect((await launch()).account).toBe("claw1");
  });

  test("a wholly exhausted pool still launches on home so the failure is the real one", async () => {
    for (const id of ["claw1", "claw2", "claw3"]) {
      writeState(id, { five_hour: { status: "rejected", resetsAt: NOW_S() + 3600, seenAt: Date.now() } });
    }
    expect((await launch()).account).toBe("claw1");
  });

  test("an exhausted home with near-limit siblings goes to the sibling with the most headroom, never the exhausted one", async () => {
    writeState("claw1", { five_hour: { status: "rejected", resetsAt: NOW_S() + 3600, seenAt: Date.now() } });
    writeState("claw2", { seven_day: weekly(0.95) });
    writeState("claw3", { seven_day: weekly(0.88) });
    expect((await launch()).account).toBe("claw3");
  });

  test("session affinity sees the same verdicts; a pin may only win for a usable account, unchanged", async () => {
    writeState("claw1", { seven_day: weekly(0.99) });
    writeState("claw2", { seven_day: weekly(0.86) });
    writeState("claw3", { seven_day: weekly(0.9) });
    const { account, env } = await launch({ sessionAffinity: true });
    expect(account).toBe("claw2");
    const affinity = JSON.parse(env[SESSION_AFFINITY_ENV]) as { verdicts: Array<{ id: string; verdict: string }> };
    expect(affinity.verdicts).toEqual([
      { id: "claw1", verdict: "near_limit" }, { id: "claw2", verdict: "near_limit" }, { id: "claw3", verdict: "near_limit" },
    ]);
  });
});
