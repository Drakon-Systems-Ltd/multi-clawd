/**
 * Wiring test for the login-health probe (#8, second production case).
 *
 * The probe already decided, correctly, that an account's login was dead — and
 * then did nothing with it but log. Selection read quota files only, so the
 * verdict was inert: five hours of turns kept launching on the account the
 * probe had already condemned.
 *
 * The same case also proved the opposite hazard. Its real cause was a host-wide
 * network outage, so EVERY probe failed at once; a fix that let any probe
 * failure bench an account would have rotated away from a healthy login and
 * fixed nothing. So these tests pin both directions: credential evidence must
 * reach selection, host evidence must not.
 *
 * Driven through the real wire — real state files, real prepareExecution —
 * for the same reason pool-selection.test.ts is: the bug was never in a
 * classifier, it was in what selection was allowed to see.
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

/** Distinct refs: a resolver must be able to tell the two accounts apart. */
const REF_BY_ACCOUNT: Record<string, typeof REF> = {
  claw1: { ...REF, id: "op://Vault/claw1/field" },
  claw2: { ...REF, id: "op://Vault/claw2/field" },
};

const ACCOUNTS = [
  { id: "claw1", oauthTokenRef: REF_BY_ACCOUNT.claw1 },
  { id: "claw2", oauthTokenRef: REF_BY_ACCOUNT.claw2 },
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

/**
 * Same registration as `chosenAccount()`, but with a launch-path resolver
 * wired: `tokens[id]` is what that account's secret ref resolves to, and
 * `undefined` models a provider that returns nothing for it. Resolves to the
 * account id the launch actually ran on.
 */
async function chosenAccountWith(tokens: Record<string, string | undefined>): Promise<string> {
  let backend: { prepareExecution?: unknown } | undefined;
  const { logger } = logs();
  const api = {
    logger,
    registerCliBackend: (b: { prepareExecution?: unknown }) => {
      if (b.prepareExecution) backend = b;
    },
    registerProvider: () => {},
  } as never;
  const resolver = {
    resolve: async (ref: { id?: string }) => {
      const id = Object.keys(REF_BY_ACCOUNT).find((k) => REF_BY_ACCOUNT[k].id === ref?.id);
      return id ? tokens[id] : undefined;
    },
    resolveDetailed: async () => ({ value: undefined, failure: "empty_result" as const }),
    peek: () => undefined,
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"] },
    ACCOUNTS,
    new Set(["claw1", "claw2"]),
    undefined,
    { resolver },
  );
  if (!backend?.prepareExecution) throw new Error("pool backend did not register");
  const prepare = backend.prepareExecution as (
    ctx: Record<string, unknown>,
  ) => Promise<{ env: Record<string, string> }>;
  const { env } = await prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" });
  return env.MULTI_CLAWD_ACCOUNT_ID ?? "(none)";
}

/**
 * Selection shorthand: both credentials resolve, so the account that comes
 * back is the one the POOL chose — the question these tests are asking. They
 * used to reach selection through a launch that resolved nothing at all, which
 * only worked while an unresolved credential silently produced a credential-free
 * env; since 1.7.3 that state refuses to launch, so the resolver is wired.
 */
const bothResolve = () =>
  chosenAccountWith({ claw1: "sk-ant-oat01-one", claw2: "sk-ant-oat01-two" });

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-probe-"));
  writeAllowedQuota("claw1");
  writeAllowedQuota("claw2");
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("probe verdicts reach pool selection (#8 case 2, gap a)", () => {
  test("a credential-broken probe takes the account out of the pool", async () => {
    // Control: with quota identical on both, the launch stays home on claw1.
    expect(await bothResolve()).toBe("claw1");

    await runLoginHealthProbe([ACCOUNTS[0]], logs().logger, {
      resolver: resolverThat({ failure: "empty_result" }),
      nowMs: Date.now(),
    });

    expect(await bothResolve()).toBe("claw2");
  });

  test("the exclusion is refreshed while the probe keeps finding it broken", async () => {
    // The record is TTL-bounded (15m) and the probe runs every 15m. Writing it
    // only on the broken TRANSITION would let the exclusion lapse under a
    // login that is still dead, and the account would come back mid-outage.
    const start = Date.now();
    const { logger } = logs();
    await runLoginHealthProbe([ACCOUNTS[0]], logger, {
      resolver: resolverThat({ failure: "empty_result" }),
      nowMs: start,
    });
    const first = storedCredential("claw1")?.seenAt;
    await runLoginHealthProbe([ACCOUNTS[0]], logger, {
      resolver: resolverThat({ failure: "empty_result" }),
      nowMs: start + 15 * MIN,
    });
    const second = storedCredential("claw1")?.seenAt;
    expect(second).toBeGreaterThan(first!);
  });

  test("a healthy probe writes no credential record at all", async () => {
    // Presence of a credential is not proof the session works — clearing on a
    // probe success would un-bench a dead login on the next tick and restore
    // the original bug. The probe may only ever bench, never absolve.
    await runLoginHealthProbe([ACCOUNTS[0]], logs().logger, {
      resolver: resolverThat({ value: "sk-ant-oat01-x" }),
      nowMs: Date.now(),
    });
    expect(storedCredential("claw1")).toBeUndefined();
    expect(await bothResolve()).toBe("claw1");
  });
});

describe("a host outage is not a broken account (#8 case 2, gap c)", () => {
  /** Drive one account's tracker to a matured provider-error streak. */
  async function outage(logger: ReturnType<typeof logs>["logger"], start: number): Promise<void> {
    const resolver = resolverThat({ failure: "provider_error" });
    for (const at of [start, start + 5 * MIN, start + 11 * MIN]) {
      await runLoginHealthProbe([ACCOUNTS[0]], logger, { resolver, nowMs: at });
    }
  }

  test("a sustained resolver outage never benches the account", async () => {
    const { logger } = logs();
    await outage(logger, Date.now());
    expect(storedCredential("claw1")).toBeUndefined();
    expect(await bothResolve()).toBe("claw1");
  });

  test("it still alerts — and says host, not login", async () => {
    // The operator wording is the fix's whole point of contact with a human at
    // 3am: "login looks dead" sends them to re-authenticate an account that was
    // never broken. This must name the resolver and say selection is unchanged.
    const { out, logger } = logs();
    await outage(logger, Date.now());
    const alert = out.error.join("\n");
    expect(alert).toContain("claw1");
    expect(alert).toMatch(/resolver|network|host/i);
    expect(alert).not.toMatch(/login looks dead/i);
    expect(alert).toMatch(/selection is unchanged/i);
  });
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

/**
 * The merge conflict between #8 (a resolver outage is a HOST problem, so the
 * account must not be benched) and 1.7.3 (an unresolvable credential must
 * never launch on the box's default login). Held apart, each is right; held
 * together they deadlock — the pool keeps electing an account whose every
 * launch then throws.
 *
 * The resolution is neither: an account whose credential will not resolve is
 * skipped at LAUNCH time and the next pool member is tried. Nothing is
 * benched, nothing runs on the wrong login, and the turn only fails when the
 * whole pool is unresolvable — at which point OpenClaw's chain takes over.
 */
describe("an unresolvable credential rotates rather than throwing (1.7.3 × #8)", () => {
  test("the launch skips past an account whose token will not resolve", async () => {
    const account = await chosenAccountWith({ claw1: undefined, claw2: "sk-ant-oat01-two" });
    expect(account).toBe("claw2");
  });

  test("a resolvable home account is still preferred", async () => {
    const account = await chosenAccountWith({ claw1: "sk-ant-oat01-one", claw2: "sk-ant-oat01-two" });
    expect(account).toBe("claw1");
  });

  test("when no account resolves the launch fails loudly, naming the pool", async () => {
    await expect(chosenAccountWith({ claw1: undefined, claw2: undefined })).rejects.toThrow(
      /clawd/,
    );
  });
});
