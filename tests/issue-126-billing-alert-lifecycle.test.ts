/**
 * Regression: a billing alert must say what is true NOW (#126 review).
 *
 * The `billing:<pool>:<account>` alert was raised with the default 6h error
 * TTL while the `billing_refused` verdict lasts 15 minutes, and it was only
 * re-checked by the pool's next prepareExecution. Heartbeats merely render
 * stored alerts, so after the cooldown expired — or after a successful turn
 * on that account had already cleared the record — the operator kept being
 * told the account was excluded until something launched through the pool.
 *
 * Driven through the real wire, as the exhaustion lifecycle test is: real
 * state files, the real prepareExecution, the real rendered heartbeat text,
 * and crucially NO launch between the change of state and the readback.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearBillingRefusal, recordBillingRefusal, type AccountHealthState } from "../src/shim-core";
import { BILLING_REFUSED_TTL_MS } from "../src/health";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile, pendingOperatorAlerts } = await import(
  "../src/index.js"
);

const MODEL = "clawd/claude-fable-5-1";
const NOW_S = () => Math.floor(Date.now() / 1000);

function writeState(state: AccountHealthState): void {
  const file = healthStateFile(state.accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), ...state }));
}

function healthy(accountId: string): AccountHealthState {
  return {
    accountId,
    windows: {
      five_hour: { status: "allowed", utilization: 0.1, resetsAt: NOW_S() + 3600, seenAt: Date.now() },
    },
  };
}

/** The account the provider refused for billing, `ageMs` ago. */
function refused(accountId: string, ageMs: number): AccountHealthState {
  return recordBillingRefusal(healthy(accountId), { kind: "billing_error", reason: "credit balance too low" }, Date.now() - ageMs);
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

/** The billing alert's own line. The rotation INFO line may quote the same reason; it is not the alert. */
const EXCLUDED = 'ERROR: pool clawd: account "claw1" is excluded';

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-billing-alert-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("billing alert lifecycle (#126)", () => {
  test("the alert ends with the cooldown, with no launch in between", async () => {
    const prepare = registerPool();
    writeState(refused("claw1", 60_000));
    writeState(healthy("claw2"));
    const { env } = await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");

    const during = pendingOperatorAlerts(Date.now());
    expect(during).toContain(EXCLUDED);
    expect(during).toContain("billing refused by the provider");

    // Still inside the cooldown: the alert stands, and its wording is current.
    const later = pendingOperatorAlerts(Date.now() + 5 * 60_000);
    expect(later).toContain(EXCLUDED);
    expect(later).toContain("billing refused by the provider 6m ago");

    // The cooldown has run out. Nothing launched; the heartbeat alone must
    // notice — a 6h gravestone here is exactly the reported defect.
    const after = pendingOperatorAlerts(Date.now() - 60_000 + BILLING_REFUSED_TTL_MS + 1_000);
    expect(after ?? "").not.toContain(EXCLUDED);
    expect(after ?? "").not.toContain("ERROR");
  });

  test("an early recovery recorded by a successful turn clears the alert on the next heartbeat", async () => {
    const prepare = registerPool();
    writeState(refused("claw1", 60_000));
    writeState(healthy("claw2"));
    await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now())).toContain(EXCLUDED);

    // The shim's clear after a real result on claw1 (a direct launch, a login
    // or a probe — none of which pass through the pool's prepareExecution).
    writeState(clearBillingRefusal(refused("claw1", 60_000), Date.now()));

    const text = pendingOperatorAlerts(Date.now()) ?? "";
    expect(text).not.toContain(EXCLUDED);
    expect(text).not.toContain("ERROR");
  });

  test("a refusal that is still live keeps its alert across heartbeats and launches", async () => {
    const prepare = registerPool();
    writeState(refused("claw1", 60_000));
    writeState(healthy("claw2"));
    await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now())).toContain(EXCLUDED);
    await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now() + 60_000)).toContain(EXCLUDED);
  });

  test("a fresh refusal re-raises the alert after an earlier one had expired", async () => {
    const prepare = registerPool();
    writeState(refused("claw1", 60_000));
    writeState(healthy("claw2"));
    await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    const expiredAt = Date.now() - 60_000 + BILLING_REFUSED_TTL_MS + 1_000;
    expect(pendingOperatorAlerts(expiredAt) ?? "").not.toContain(EXCLUDED);

    // Refused again, a minute before the readback: the heartbeat must show it
    // even though the key was cleared at the previous one.
    writeState(refused("claw1", 60_000));
    await prepare({ modelId: MODEL, workspaceDir: "/tmp/ws" });
    expect(pendingOperatorAlerts(Date.now())).toContain(EXCLUDED);
  });
});
