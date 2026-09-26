/**
 * The direct route's IO half, against a scripted `openclaw`. What is pinned:
 * - a setup-token only ever travels on stdin — never argv, never a message;
 * - a ref is stored as a tokenRef through `secrets apply`, dry-run first,
 *   with the provider-wide scrub pass OFF (it would wipe the operator's own
 *   anthropic profiles);
 * - the gateway loop writes the order only when it would change, keeps
 *   unmanaged profiles, never names a profile the store lacks, and backs off
 *   after a failure instead of hammering the CLI every minute.
 */
import { describe, expect, test } from "vitest";
import {
  buildTokenRefPlan,
  createDirectOrderController,
  orderSetArgs,
  parseAuthList,
  parseOrderGet,
  parseUnusableProfiles,
  planAgentOrder,
  safeCliError,
  syncDirectProfiles,
  type OpenclawRunner,
  type RunResult,
} from "../src/direct-sync";
import type { DirectMember } from "../src/direct-route";
import type { AccountHealthState } from "../src/shim-core";

const TOKEN = `sk-ant-oat01-${"a".repeat(90)}`;
const REF = { source: "exec", provider: "vault", id: "op://Vault/Item/field" };
const NOW = 1_800_000_000_000;

function scripted(
  handler: (args: string[], input?: string) => Partial<RunResult> | undefined,
): { runner: OpenclawRunner; calls: Array<{ args: string[]; input?: string }> } {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: OpenclawRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = handler(args, opts?.input) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

const listJson = (ids: string[]) =>
  JSON.stringify({ agentId: "main", provider: "anthropic", profiles: ids.map((id) => ({ id, provider: "anthropic", type: "token" })) });
const orderJson = (order: string[] | null) => `banner line\n${JSON.stringify({ provider: "anthropic", order })}`;

const member = (accountId: string, source: DirectMember["source"]): DirectMember => ({
  accountId,
  profileId: `anthropic:${accountId}`,
  source,
});

describe("parsers", () => {
  test("auth list, order get (banner-tolerant), unusable profiles", () => {
    expect(parseAuthList(listJson(["anthropic:a", "anthropic:b"]))?.map((p) => p.id)).toEqual([
      "anthropic:a",
      "anthropic:b",
    ]);
    expect(parseAuthList("not json")).toBeUndefined();
    expect(parseOrderGet(orderJson(null))).toEqual({ order: null });
    expect(parseOrderGet(orderJson(["anthropic:a"]))).toEqual({ order: ["anthropic:a"] });
    const status = JSON.stringify({
      auth: {
        unusableProfiles: [
          { profileId: "anthropic:a", provider: "anthropic", kind: "cooldown", reason: "rate_limit", until: NOW + 1 },
          { profileId: "openai:x", provider: "openai", kind: "cooldown", until: NOW + 1 },
        ],
      },
    });
    expect(parseUnusableProfiles(status)).toEqual([
      { profileId: "anthropic:a", kind: "cooldown", reason: "rate_limit", until: NOW + 1 },
    ]);
  });

  test("safeCliError masks anything token-shaped", () => {
    const msg = safeCliError({ code: 1, stdout: "", stderr: `Error: token ${TOKEN} rejected` });
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("aaaaaaaaaa");
    expect(msg).toMatch(/^exit 1: Error: token sk-ant-… rejected/);
  });

  test("orderSetArgs refuses empty orders and foreign providers", () => {
    expect(() => orderSetArgs("main", [])).toThrow();
    expect(() => orderSetArgs("main", ["openai:x"])).toThrow();
    expect(() => orderSetArgs("../x", ["anthropic:a"])).toThrow();
    expect(orderSetArgs("main", ["anthropic:a"])).toEqual([
      "models", "auth", "order", "set", "--agent", "main", "--provider", "anthropic", "anthropic:a",
    ]);
  });
});

describe("buildTokenRefPlan", () => {
  test("targets the token profile with a sibling ref, scrubs off", () => {
    const plan = buildTokenRefPlan({ agentId: "main", profileId: "anthropic:claw1", ref: REF });
    expect(plan).toMatchObject({
      scrubEnv: false,
      scrubAuthProfilesForProviderTargets: false,
      targets: [
        {
          type: "auth-profiles.token.token",
          path: "profiles.anthropic:claw1.token",
          pathSegments: ["profiles", "anthropic:claw1", "token"],
          agentId: "main",
          authProfileProvider: "anthropic",
          ref: REF,
        },
      ],
    });
  });

  test("a dotted profile id cannot be a plan path", () => {
    expect(() => buildTokenRefPlan({ agentId: "main", profileId: "anthropic:a.b", ref: REF })).toThrow(/"\."/);
  });
});

describe("syncDirectProfiles", () => {
  const planFiles: Array<Record<string, unknown>> = [];
  const writePlanFile = (plan: Record<string, unknown>) => {
    planFiles.push(plan);
    return { path: "/tmp/plan.json", cleanup: () => {} };
  };

  test("file source: token on stdin only; present profiles untouched", async () => {
    const { runner, calls } = scripted((args) =>
      args[2] === "list" ? { stdout: listJson(["anthropic:claw2"]) } : { code: 0 },
    );
    const { results } = await syncDirectProfiles({
      members: [member("claw1", { kind: "file", path: "~/t1", reused: false }), member("claw2", { kind: "file", path: "~/t2", reused: true })],
      agentId: "main",
      runner,
      readTokenFile: () => `${TOKEN}\n`,
      writePlanFile,
    });
    expect(results.map((r) => [r.accountId, r.action])).toEqual([
      ["claw1", "stored"],
      ["claw2", "present"],
    ]);
    const paste = calls.find((c) => c.args.includes("paste-token"));
    expect(paste?.input).toBe(TOKEN);
    for (const c of calls) expect(c.args.join(" ")).not.toContain("sk-ant");
    for (const r of results) expect(JSON.stringify(r)).not.toContain("sk-ant-oat");
  });

  test("resync rewrites a present profile; dry-run writes nothing", async () => {
    const { runner, calls } = scripted((args) => (args[2] === "list" ? { stdout: listJson(["anthropic:claw1"]) } : {}));
    const members = [member("claw1", { kind: "file", path: "~/t1", reused: false })];
    const dry = await syncDirectProfiles({ members, agentId: "main", runner, readTokenFile: () => TOKEN, writePlanFile, resync: true, dryRun: true });
    expect(dry.results[0].action).toBe("would-store");
    expect(calls.some((c) => c.args.includes("paste-token"))).toBe(false);
    const wet = await syncDirectProfiles({ members, agentId: "main", runner, readTokenFile: () => TOKEN, writePlanFile, resync: true });
    expect(wet.results[0].action).toBe("stored");
  });

  test("a malformed token file fails without echoing it", async () => {
    const { runner, calls } = scripted((args) => (args[2] === "list" ? { stdout: listJson([]) } : {}));
    const secretish = "sk-ant-api03-not-a-setup-token-xyz";
    const { results } = await syncDirectProfiles({
      members: [member("claw1", { kind: "file", path: "~/t1", reused: false })],
      agentId: "main",
      runner,
      readTokenFile: () => secretish,
      writePlanFile,
    });
    expect(results[0].action).toBe("failed");
    expect(results[0].detail).not.toContain(secretish);
    expect(calls.some((c) => c.args.includes("paste-token"))).toBe(false);
  });

  test("ref source: secrets apply dry-run, then apply, with --allow-exec for exec refs", async () => {
    planFiles.length = 0;
    const { runner, calls } = scripted((args) => (args[2] === "list" ? { stdout: listJson([]) } : {}));
    const { results } = await syncDirectProfiles({
      members: [member("claw1", { kind: "ref", ref: REF, reused: false })],
      agentId: "main",
      runner,
      readTokenFile: () => {
        throw new Error("must not read files for a ref");
      },
      writePlanFile,
    });
    expect(results[0]).toMatchObject({ action: "stored" });
    const applies = calls.filter((c) => c.args[0] === "secrets");
    expect(applies.map((c) => c.args)).toEqual([
      ["secrets", "apply", "--from", "/tmp/plan.json", "--dry-run", "--allow-exec"],
      ["secrets", "apply", "--from", "/tmp/plan.json", "--allow-exec"],
    ]);
    expect(planFiles[0]).toMatchObject({ scrubAuthProfilesForProviderTargets: false });
  });

  test("a failed dry-run stops before the write", async () => {
    const { runner, calls } = scripted((args) =>
      args[2] === "list" ? { stdout: listJson([]) } : args.includes("--dry-run") ? { code: 1, stderr: "Error: unresolved ref" } : {},
    );
    const { results } = await syncDirectProfiles({
      members: [member("claw1", { kind: "ref", ref: { ...REF, source: "env" }, reused: false })],
      agentId: "main",
      runner,
      readTokenFile: () => "",
      writePlanFile,
    });
    expect(results[0].action).toBe("failed");
    expect(results[0].detail).toMatch(/unresolved ref/);
    expect(calls.filter((c) => c.args[0] === "secrets")).toHaveLength(1);
    expect(calls[1].args).not.toContain("--allow-exec");
  });

  test("adopted profiles are reported, never written", async () => {
    const { runner, calls } = scripted((args) => (args[2] === "list" ? { stdout: listJson(["anthropic:claw2"]) } : {}));
    const { results } = await syncDirectProfiles({
      members: [member("claw2", { kind: "existing" }), member("claw3", { kind: "existing" })],
      agentId: "main",
      runner,
      readTokenFile: () => "",
      writePlanFile,
    });
    expect(results.map((r) => r.action)).toEqual(["adopted", "adopt-missing"]);
    expect(calls).toHaveLength(1);
  });

  test("an unreadable store aborts the sync with a reason", async () => {
    const { runner } = scripted(() => ({ code: 1, stderr: "Error: store locked" }));
    const out = await syncDirectProfiles({ members: [], agentId: "main", runner, readTokenFile: () => "", writePlanFile });
    expect(out.listError).toMatch(/store locked/);
  });
});

describe("planAgentOrder", () => {
  const verdicts = [
    { accountId: "claw1", profileId: "anthropic:claw1", verdict: "near_limit" as const },
    { accountId: "claw2", profileId: "anthropic:claw2", verdict: "ok" as const },
  ];

  test("config order is the base when nothing is stored; unmanaged kept, missing excluded", () => {
    const plan = planAgentOrder({
      members: [...verdicts, { accountId: "claw3", profileId: "anthropic:claw3", verdict: "ok" }],
      snapshot: { stored: new Set(["anthropic:claw1", "anthropic:claw2", "anthropic:hand"]), storedOrder: null },
      configOrder: ["anthropic:hand"],
      nowMs: NOW,
    });
    expect(plan.order).toEqual(["anthropic:claw2", "anthropic:claw1", "anthropic:hand"]);
    expect(plan.missing).toEqual(["anthropic:claw3"]);
  });

  test("no explicit order anywhere: every stored profile stays in rotation", () => {
    const plan = planAgentOrder({
      members: verdicts,
      snapshot: { stored: new Set(["anthropic:x", "anthropic:claw1", "anthropic:claw2"]), storedOrder: null },
      nowMs: NOW,
    });
    expect(plan.order).toEqual(["anthropic:claw2", "anthropic:claw1", "anthropic:x"]);
  });

  test("an order already in force is not rewritten", () => {
    const stored = planAgentOrder({
      members: verdicts,
      snapshot: { stored: new Set(["anthropic:claw1", "anthropic:claw2"]), storedOrder: ["anthropic:claw2", "anthropic:claw1"] },
      nowMs: NOW,
    });
    expect(stored.order).toBeUndefined();
    const viaConfig = planAgentOrder({
      members: verdicts,
      snapshot: { stored: new Set(["anthropic:claw1", "anthropic:claw2"]), storedOrder: null },
      configOrder: ["anthropic:claw2", "anthropic:claw1"],
      nowMs: NOW,
    });
    expect(viaConfig.order).toBeUndefined();
  });

  test("nothing stored yet: no order", () => {
    const plan = planAgentOrder({ members: verdicts, snapshot: { stored: new Set(), storedOrder: null }, nowMs: NOW });
    expect(plan.order).toBeUndefined();
    expect(plan.missing).toHaveLength(2);
  });
});

describe("createDirectOrderController", () => {
  const nearLimit: AccountHealthState = {
    accountId: "claw1",
    windows: {
      seven_day: { status: "allowed", utilization: 0.95, resetsAt: NOW / 1000 + 86_400, seenAt: NOW - 1000 },
    },
  } as unknown as AccountHealthState;

  function harness(opts: { health?: Record<string, AccountHealthState | undefined>; stored?: string[]; storedOrder?: string[] | null; setCode?: number }) {
    let storedOrder = opts.storedOrder ?? null;
    let clock = NOW;
    let sticky: unknown;
    const logs: string[] = [];
    const { runner, calls } = scripted((args) => {
      if (args[2] === "list") return { stdout: listJson(opts.stored ?? ["anthropic:claw1", "anthropic:claw2"]) };
      if (args[3] === "get") return { stdout: orderJson(storedOrder) };
      if (args[3] === "set") {
        if ((opts.setCode ?? 0) !== 0) return { code: opts.setCode, stderr: "Error: lock busy" };
        storedOrder = args.slice(8);
        return {};
      }
      return { code: 1 };
    });
    const controller = createDirectOrderController({
      members: [member("claw1", { kind: "existing" }), member("claw2", { kind: "existing" })],
      agents: ["main"],
      runner,
      readHealth: (id) => opts.health?.[id],
      healthOptions: {},
      configOrder: () => undefined,
      readSticky: () => sticky as never,
      writeSticky: (e) => {
        sticky = e;
      },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      now: () => clock,
    });
    return {
      controller,
      calls,
      logs,
      advance: (ms: number) => {
        clock += ms;
      },
      order: () => storedOrder,
      setOrder: (o: string[] | null) => {
        storedOrder = o;
      },
      sticky: () => sticky,
    };
  }

  test("near-limit home: writes claw2 first once, then stays quiet", async () => {
    const h = harness({ health: { claw1: nearLimit } });
    const first = await h.controller.tick();
    expect(first.agents[0]).toMatchObject({ outcome: "written", order: ["anthropic:claw2", "anthropic:claw1"] });
    expect(h.order()).toEqual(["anthropic:claw2", "anthropic:claw1"]);
    expect(h.sticky()).toEqual({ account: "claw2", since: NOW });
    const callsAfterFirst = h.calls.length;
    h.advance(60_000);
    const second = await h.controller.tick();
    expect(second.agents[0].outcome).toBe("skipped");
    expect(h.calls.length).toBe(callsAfterFirst);
  });

  test("a healthy pool with no explicit order gets an explicit home-first order", async () => {
    const h = harness({});
    const r = await h.controller.tick();
    expect(r.agents[0]).toMatchObject({ outcome: "written", order: ["anthropic:claw1", "anthropic:claw2"] });
  });

  test("reasserts after an hour, and rewrites if someone reordered by hand", async () => {
    const h = harness({ storedOrder: ["anthropic:claw1", "anthropic:claw2"] });
    expect((await h.controller.tick()).agents[0].outcome).toBe("unchanged");
    h.setOrder(["anthropic:claw2", "anthropic:claw1"]);
    h.advance(30 * 60_000);
    expect((await h.controller.tick()).agents[0].outcome).toBe("skipped");
    h.advance(31 * 60_000);
    expect((await h.controller.tick()).agents[0]).toMatchObject({
      outcome: "written",
      order: ["anthropic:claw1", "anthropic:claw2"],
    });
  });

  test("a failed write backs off for 10 minutes and logs once", async () => {
    const h = harness({ setCode: 1 });
    expect((await h.controller.tick()).agents[0].outcome).toBe("failed");
    h.advance(60_000);
    expect((await h.controller.tick()).agents[0]).toMatchObject({ outcome: "skipped" });
    h.advance(10 * 60_000);
    expect((await h.controller.tick()).agents[0].outcome).toBe("failed");
    expect(h.logs.filter((l) => l.includes("order set"))).toHaveLength(1);
  });

  test("a profile the store lacks is never named in order set, and warned once", async () => {
    const h = harness({ stored: ["anthropic:claw1"] });
    const r = await h.controller.tick();
    expect(r.agents[0]).toMatchObject({ outcome: "written", order: ["anthropic:claw1"] });
    h.advance(61 * 60_000);
    await h.controller.tick();
    expect(h.logs.filter((l) => l.includes("anthropic:claw2 is not stored"))).toHaveLength(1);
  });
});
