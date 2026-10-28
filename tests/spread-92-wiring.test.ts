/**
 * Spread strategy (#92) on the real wire: `registerPoolBackend` →
 * `prepareExecution` reading the served-launch journal from an isolated
 * state dir, then the compiled shim honouring a session pin. Fixture
 * credentials only (config-dir paths that do not exist); the fake claude
 * never contacts a provider.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanShimEnv } from "./shim-env.js";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile, pendingOperatorAlerts } = await import("../src/index.js");
const { historyFile, readHistory, recordHistory } = await import("../src/history.js");
const { recordSessionPin, SESSION_AFFINITY_ENV } = await import("../src/session-affinity.js");

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.mjs");
const NOW_S = () => Math.floor(Date.now() / 1000);

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

function journal(): string {
  return historyFile(healthStateFile("claw1"));
}

function serve(accountId: string, agoMs: number): void {
  recordHistory(healthStateFile(accountId), { at: new Date(Date.now() - agoMs).toISOString(), kind: "served", accountId });
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
      { id: "claw1", configDir: join(home.dir, "claw1-login") },
      { id: "claw2", configDir: join(home.dir, "claw2-login") },
    ],
    new Set(["claw1", "claw2"]),
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  return { prepare: backend.prepareExecution as Registered["prepare"], logs };
}

async function chosen(poolOverrides: Record<string, unknown> = {}): Promise<{ account: string; env: Record<string, string>; logs: Registered["logs"] }> {
  const { prepare, logs } = registerPool(poolOverrides);
  const { env } = await prepare({ modelId: "clawd/claude-fable-5-1", workspaceDir: "/tmp/ws" });
  return { account: env.MULTI_CLAWD_ACCOUNT_ID, env, logs };
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-spread-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("spread placement on the launch path (#92)", () => {
  test("a busy home account hands the next new session to the idle sibling; the default strategy still picks home", async () => {
    serve("claw1", 60_000);
    serve("claw1", 30_000);
    expect((await chosen()).account).toBe("claw1");
    expect((await chosen({ strategy: "ordered" })).account).toBe("claw1");
    expect((await chosen({ strategy: "spread" })).account).toBe("claw2");
  });

  test("launches served outside the window do not count, and a shorter window changes the answer", async () => {
    serve("claw1", 2 * 3_600_000); // two hours ago: outside the default hour
    serve("claw1", 2 * 3_600_000 + 1);
    serve("claw2", 20 * 60_000);   // twenty minutes ago
    // Default hour: claw1 0, claw2 1 → claw1. Three hours: claw1 2, claw2 1 → claw2.
    expect((await chosen({ strategy: "spread" })).account).toBe("claw1");
    expect((await chosen({ strategy: "spread", spreadWindowMs: 3 * 3_600_000 })).account).toBe("claw2");
  });

  test("the least-served account is never an exhausted or near-limit one", async () => {
    serve("claw1", 60_000);
    serve("claw1", 30_000);
    writeState("claw2", { five_hour: { status: "rejected", resetsAt: NOW_S() + 3600, seenAt: Date.now() } });
    expect((await chosen({ strategy: "spread" })).account).toBe("claw1");
    writeState("claw2", { five_hour: { status: "allowed_warning", resetsAt: NOW_S() + 1800, seenAt: Date.now() } });
    expect((await chosen({ strategy: "spread" })).account).toBe("claw1");
  });

  test("a wholly exhausted pool launches exactly where ordered would, so the chain still sees the real failure", async () => {
    serve("claw1", 60_000);
    for (const id of ["claw1", "claw2"]) {
      writeState(id, { five_hour: { status: "rejected", resetsAt: NOW_S() + 3600, seenAt: Date.now() } });
    }
    expect((await chosen({ strategy: "spread" })).account).toBe((await chosen({ strategy: "ordered" })).account);
  });

  test("a placement off the first member is not a rotation: no alert, no rotation event, no sticky file", async () => {
    serve("claw1", 60_000);
    const { account, logs } = await chosen({ strategy: "spread" });
    expect(account).toBe("claw2");
    expect(logs.info.join("\n")).not.toMatch(/rotated to|returning home/);
    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toMatch(/rotat/);
    expect(readHistory(journal()).filter((e) => e.kind === "rotation")).toEqual([]);
    expect(existsSync(join(home.dir, ".openclaw", "state", "multi-clawd", "pool-clawd.sticky.json"))).toBe(false);
  });

  test("spread switches session affinity on; an explicit false is overridden with a warning", async () => {
    const plain = await chosen({ strategy: "spread" });
    expect(plain.env[SESSION_AFFINITY_ENV]).toBeDefined();
    expect(plain.logs.warn.join("\n")).not.toMatch(/sessionAffinity/);
    const forced = await chosen({ strategy: "spread", sessionAffinity: false });
    expect(forced.env[SESSION_AFFINITY_ENV]).toBeDefined();
    expect(forced.logs.warn.join("\n")).toMatch(/sessionAffinity: false is ignored/);
    // Ordered without affinity still hands the shim no pin store (unchanged default).
    expect((await chosen()).env[SESSION_AFFINITY_ENV]).toBeUndefined();
  });
});

describe("spread never moves a pinned healthy session (#92)", () => {
  function runShim(env: Record<string, string>, args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [SHIM, ...args, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"], {
      encoding: "utf8", input: "fixture prompt\n",
      env: { ...cleanShimEnv(), ...env, MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]) },
    });
  }

  test("a resumed session pinned to the busier account stays there; a new session takes the spread pick", async () => {
    expect(existsSync(SHIM)).toBe(true);
    serve("claw1", 60_000);
    serve("claw1", 30_000);
    recordSessionPin(join(home.dir, ".openclaw", "state", "multi-clawd", "pool-clawd.sessions.json"),
      "pinned-session", "claw1", Date.now(), 30 * 24 * 3_600_000);
    const { account, env } = await chosen({ strategy: "spread" });
    expect(account).toBe("claw2");

    const resumed = runShim(env, ["--resume", "pinned-session"]);
    expect(resumed.status).toBe(0);
    let servedRows = readHistory(journal()).filter((e) => e.kind === "served");
    expect(servedRows.at(-1)?.accountId).toBe("claw1");

    const fresh = runShim(env, ["--session-id", "brand-new-session"]);
    expect(fresh.status).toBe(0);
    servedRows = readHistory(journal()).filter((e) => e.kind === "served");
    expect(servedRows.at(-1)?.accountId).toBe("claw2");
  }, 30_000);
});
