/**
 * Wiring test for the login-health probe (#8, second production case).
 *
 * A probe verdict is only worth as much as the history behind it, and that
 * history used to be thrown away by an unrelated event — every register()
 * pass. These drive real probe passes across a re-registration.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted above the index.ts import: healthStateFile() resolves through
// homedir() at call time, but the module is evaluated on import.
const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile, runLoginHealthProbe, startLoginHealthProbe } =
  await import("../src/index.js");
const { parseStoredState } = await import("../src/shim-core.js");

const MIN = 60 * 1000;
const REF = { source: "exec", provider: "onepassword", id: "op://Vault/Item/field" };

const ACCOUNTS = [
  { id: "claw1", oauthTokenRef: REF },
  { id: "claw2", oauthTokenRef: REF },
];

function logs() {
  const out = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    out,
    logger: {
      info: (m: string) => out.info.push(m),
      warn: (m: string) => out.warn.push(m),
      error: (m: string) => out.error.push(m),
    },
  };
}

/** A resolver whose every ref resolution ends the same way. */
function resolverThat(outcome: { value?: string; failure?: "provider_error" | "empty_result" }) {
  return {
    resolveDetailed: async () => outcome,
    resolve: async () => outcome.value,
    peek: () => outcome.value,
  } as never;
}

/** Quota telemetry that says nothing: both accounts plainly allowed. */
function writeAllowedQuota(accountId: string): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      accountId,
      updatedAt: Date.now(),
      windows: {
        five_hour: {
          status: "allowed",
          utilization: 0.1,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          seenAt: Date.now(),
        },
      },
    }),
  );
}

function storedCredential(accountId: string): { status?: string; seenAt?: number } | undefined {
  try {
    return parseStoredState(readFileSync(healthStateFile(accountId), "utf8"))?.credential;
  } catch {
    return undefined;
  }
}

/** The account a launch would actually run on, read off the prepared env. */
async function chosenAccount(): Promise<string> {
  let backend: { prepareExecution?: unknown } | undefined;
  const { logger } = logs();
  const api = {
    logger,
    registerCliBackend: (b: { prepareExecution?: unknown }) => {
      if (b.prepareExecution) backend = b;
    },
    registerProvider: () => {},
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"] },
    ACCOUNTS,
    new Set(["claw1", "claw2"]),
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  const prepare = backend.prepareExecution as (
    ctx: Record<string, unknown>,
  ) => Promise<{ env: Record<string, string> }>;
  const { env } = await prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });
  return env.MULTI_CLAWD_ACCOUNT_ID ?? "(none)";
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-probe-"));
  writeAllowedQuota("claw1");
  writeAllowedQuota("claw2");
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("probe state survives re-registration (#8 case 2, gap b)", () => {
  test("a failure streak is not wiped by a register() pass", async () => {
    // register() re-runs on every config rebuild — three times in the live
    // case, each one resetting the streak, so a resolver that failed for six
    // hours straight never once reached its 3-consecutive threshold.
    const { out, logger } = logs();
    const resolver = resolverThat({ failure: "provider_error" });
    const start = Date.now();

    await runLoginHealthProbe([ACCOUNTS[0]], logger, { resolver, nowMs: start });
    await runLoginHealthProbe([ACCOUNTS[0]], logger, { resolver, nowMs: start + 5 * MIN });

    // A config rebuild lands here, mid-streak.
    startLoginHealthProbe([ACCOUNTS[0]], logger);

    await runLoginHealthProbe([ACCOUNTS[0]], logger, { resolver, nowMs: start + 11 * MIN });

    // Third consecutive failure, 11 minutes into the streak: broken.
    expect(out.error.join("\n")).toMatch(/claw1/);
    expect(out.error.length).toBeGreaterThan(0);
  });
});
