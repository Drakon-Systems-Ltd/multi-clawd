/**
 * The one gatherer behind explain / doctor / `multi-clawd direct`. Pinned:
 * nothing is gathered (and nothing spawned) without `direct`; stored state,
 * order source, cooldowns and the pending order come from the CLI; a secret
 * reference is described by provider name only.
 */
import { describe, expect, test } from "vitest";
import { describeDirectSource, gatherDirectStatus, parseProbeResults, probeArgs } from "../src/direct-report";
import type { OpenclawRunner } from "../src/direct-sync";

const REF = { source: "exec", provider: "vault", id: "op://Vault/Item/field" };
const NOW = 1_800_000_000_000;

function runner(stored: string[], storedOrder: string[] | null, unusable: unknown[] = []) {
  const calls: string[][] = [];
  const run: OpenclawRunner = async (args) => {
    calls.push(args);
    if (args[2] === "list") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ profiles: stored.map((id) => ({ id, provider: "anthropic" })) }) };
    }
    if (args[3] === "get") return { code: 0, stderr: "", stdout: JSON.stringify({ order: storedOrder }) };
    if (args[1] === "status") return { code: 0, stderr: "", stdout: JSON.stringify({ auth: { unusableProfiles: unusable } }) };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

describe("gatherDirectStatus", () => {
  test("no `direct` anywhere: undefined and no CLI call", async () => {
    const { run, calls } = runner([], null);
    const out = await gatherDirectStatus({
      accounts: [{ id: "claw1", native: true }, { id: "claw2", oauthTokenRef: REF }],
      agentId: "main",
      runner: run,
      readHealth: () => undefined,
      healthOptions: {},
      nowMs: NOW,
    });
    expect(out).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("stored flags, config-order source, cooldown, pending order, no ref id", async () => {
    const { run } = runner(["anthropic:claw2", "anthropic:hand"], null, [
      { profileId: "anthropic:claw2", provider: "anthropic", kind: "cooldown", reason: "rate_limit", until: NOW + 60_000 },
    ]);
    const out = await gatherDirectStatus({
      accounts: [
        { id: "claw1", native: true, direct: { tokenRef: REF } },
        { id: "claw2", oauthTokenRef: REF, direct: true },
        { id: "claw3", native: true, direct: true },
      ],
      poolAccounts: ["claw1", "claw2"],
      agentId: "main",
      runner: run,
      readHealth: () => undefined,
      healthOptions: {},
      configOrder: ["anthropic:hand"],
      nowMs: NOW,
    });
    expect(out?.explain.members).toEqual([
      expect.objectContaining({ accountId: "claw1", stored: false, source: "setup-token via vault secret reference" }),
      expect.objectContaining({
        accountId: "claw2",
        stored: true,
        cooldownUntil: NOW + 60_000,
        cooldownReason: "rate_limit",
        source: "setup-token via vault secret reference (the same one its CLI login uses)",
      }),
    ]);
    expect(out?.explain.problems[0]).toMatchObject({ accountId: "claw3" });
    expect(out?.explain.order).toEqual(["anthropic:hand"]);
    expect(out?.explain.orderSource).toBe("config auth.order");
    expect(out?.pendingOrder).toEqual(["anthropic:claw2", "anthropic:hand"]);
    expect(JSON.stringify(out)).not.toContain("op://");
  });

  test("a stored order in health order has nothing pending", async () => {
    const { run } = runner(["anthropic:claw1", "anthropic:claw2"], ["anthropic:claw1", "anthropic:claw2"]);
    const out = await gatherDirectStatus({
      accounts: [
        { id: "claw1", oauthTokenFile: "~/t", direct: true },
        { id: "claw2", oauthTokenRef: REF, direct: true },
      ],
      agentId: "main",
      runner: run,
      readHealth: () => undefined,
      healthOptions: {},
      nowMs: NOW,
      skipCooldowns: true,
    });
    expect(out?.pendingOrder).toBeUndefined();
    expect(out?.explain.orderSource).toBe("stored for agent main");
  });
});

describe("probe parsing", () => {
  test("anthropic results only, token-shaped text masked", () => {
    const out = parseProbeResults(
      JSON.stringify({
        auth: {
          probes: {
            results: [
              { provider: "anthropic", profileId: "anthropic:claw1", status: "ok" },
              { provider: "anthropic", profileId: "anthropic:claw2", status: "rate_limit", error: "limit on sk-ant-oat01-abc" },
              { provider: "openai", profileId: "openai:x", status: "ok" },
            ],
          },
        },
      }),
    );
    expect(out).toEqual([
      { profileId: "anthropic:claw1", status: "ok" },
      { profileId: "anthropic:claw2", status: "rate_limit", error: "limit on sk-ant-…" },
    ]);
    expect(parseProbeResults("nope")).toBeUndefined();
  });

  test("probe args name exactly the managed profiles", () => {
    expect(probeArgs("main", ["anthropic:a", "anthropic:b"])).toContain("anthropic:a,anthropic:b");
  });

  test("source descriptions", () => {
    expect(describeDirectSource({ accountId: "a", profileId: "anthropic:a", source: { kind: "existing" } })).toMatch(/adopted/);
    expect(
      describeDirectSource({ accountId: "a", profileId: "anthropic:a", source: { kind: "file", path: "~/t", reused: false } }),
    ).toBe("setup-token file ~/t");
  });
});
