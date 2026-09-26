/**
 * The direct Anthropic route's pure half: which setup-token an account offers
 * `anthropic/*` turns, what its OpenClaw profile is called, and the profile
 * order that matches pool health. The compatibility contract is tested first:
 * an account that never says `direct` is invisible to all of it.
 */
import { describe, expect, test } from "vitest";
import {
  DIRECT_SETUP_TOKEN_GUIDANCE,
  collectDirectMembers,
  directCredentialSource,
  directEnabled,
  directProfileId,
  planDirectOrder,
} from "../src/direct-route";

const REF = { source: "exec", provider: "vault", id: "op://Vault/Item/field" };
const REF2 = { source: "exec", provider: "vault", id: "op://Vault/Other/field" };

describe("opt-in is explicit", () => {
  test("an account without `direct` takes no part", () => {
    for (const account of [
      { id: "claw1", native: true },
      { id: "claw2", configDir: "~/.claw2", oauthTokenRef: REF },
      { id: "claw3", oauthTokenFile: "~/.claw3/token" },
      { id: "claw4", oauthTokenRef: REF, direct: false as const },
    ]) {
      expect(directEnabled(account)).toBe(false);
      expect(directCredentialSource(account)).toEqual({ kind: "none" });
    }
    const { members, problems } = collectDirectMembers([
      { id: "claw1", native: true },
      { id: "claw2", oauthTokenRef: REF },
    ]);
    expect(members).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe("credential source", () => {
  test("direct: true reuses a setup-token the account already has", () => {
    expect(directCredentialSource({ id: "a", oauthTokenRef: REF, direct: true })).toEqual({
      kind: "ref",
      ref: REF,
      reused: true,
    });
    expect(directCredentialSource({ id: "a", oauthTokenFile: "~/t", direct: true })).toEqual({
      kind: "file",
      path: "~/t",
      reused: true,
    });
  });

  test("a native or config-dir login is never read — it needs its own setup-token", () => {
    for (const account of [
      { id: "claw1", native: true, direct: true },
      { id: "claw2", configDir: "~/.claw2", direct: true },
      { id: "claw3", configDir: "~/.claw3", direct: {} },
    ]) {
      const source = directCredentialSource(account);
      expect(source.kind).toBe("unsupported");
      if (source.kind === "unsupported") {
        expect(source.code).toBe("direct_setup_token_required");
        expect(source.reason).toBe(DIRECT_SETUP_TOKEN_GUIDANCE);
        expect(source.reason).toContain("claude setup-token");
      }
    }
  });

  test("native + stray oauthTokenRef is still native: the ref is not the native login", () => {
    expect(directCredentialSource({ id: "claw1", native: true, oauthTokenRef: REF, direct: true }).kind).toBe(
      "unsupported",
    );
  });

  test("an explicit direct token wins over the CLI token and serves a native account", () => {
    expect(
      directCredentialSource({ id: "claw1", native: true, direct: { tokenRef: REF2 } }),
    ).toEqual({ kind: "ref", ref: REF2, reused: false });
    expect(
      directCredentialSource({ id: "claw2", oauthTokenRef: REF, direct: { tokenFile: " ~/d " } }),
    ).toEqual({ kind: "file", path: "~/d", reused: false });
  });

  test("conflicting or malformed explicit sources are reported, not guessed", () => {
    const both = directCredentialSource({ id: "a", direct: { tokenRef: REF, tokenFile: "~/t" } });
    expect(both).toMatchObject({ kind: "unsupported", code: "direct_sources_conflict" });
    const bad = directCredentialSource({ id: "a", direct: { tokenRef: { id: "x" } } });
    expect(bad).toMatchObject({ kind: "unsupported", code: "direct_ref_malformed" });
  });
});

describe("profile ids", () => {
  test("stable default under the anthropic provider", () => {
    expect(directProfileId({ id: "claw1" })).toBe("anthropic:claw1");
    expect(directProfileId({ id: " claw2 " })).toBe("anthropic:claw2");
  });

  test("an override must stay inside the anthropic provider", () => {
    expect(directProfileId({ id: "a", direct: { profileId: "anthropic:main" } })).toBe("anthropic:main");
    expect(() => directProfileId({ id: "a", direct: { profileId: "openai:main" } })).toThrow(/anthropic:/);
    expect(() => directProfileId({ id: "a", direct: { profileId: "anthropic:" } })).toThrow();
    expect(() => directProfileId({ id: "a", direct: { profileId: "anthropic:a b" } })).toThrow();
  });
});

describe("collectDirectMembers", () => {
  test("pool order first, then remaining accounts; problems reported, not dropped silently", () => {
    const { members, problems } = collectDirectMembers(
      [
        { id: "claw3", oauthTokenFile: "~/t3", direct: true },
        { id: "claw1", native: true, direct: { tokenRef: REF } },
        { id: "claw2", configDir: "~/.claw2", direct: true },
        { id: "claw4", native: true },
      ],
      ["claw1", "claw2"],
    );
    expect(members.map((m) => [m.accountId, m.profileId])).toEqual([
      ["claw1", "anthropic:claw1"],
      ["claw3", "anthropic:claw3"],
    ]);
    expect(problems).toEqual([
      expect.objectContaining({ accountId: "claw2", code: "direct_setup_token_required" }),
    ]);
  });

  test("two accounts cannot share one profile", () => {
    const { members, problems } = collectDirectMembers([
      { id: "a", oauthTokenRef: REF, direct: { profileId: "anthropic:x" } },
      { id: "b", oauthTokenRef: REF2, direct: { profileId: "anthropic:x" } },
    ]);
    expect(members.map((m) => m.accountId)).toEqual(["a"]);
    expect(problems[0]).toMatchObject({ accountId: "b", code: "direct_profile_duplicate" });
  });
});

describe("planDirectOrder", () => {
  const NOW = 1_800_000_000_000;
  const m = (accountId: string, verdict: Parameters<typeof planDirectOrder>[0]["members"][number]["verdict"]) => ({
    accountId,
    profileId: `anthropic:${accountId}`,
    verdict,
  });

  test("healthy pool keeps home first", () => {
    const plan = planDirectOrder({ members: [m("claw1", "ok"), m("claw2", "no_data")], nowMs: NOW });
    expect(plan?.order).toEqual(["anthropic:claw1", "anthropic:claw2"]);
    expect(plan?.firstAccount).toBe("claw1");
    expect(plan?.sticky).toBeUndefined();
    expect(plan?.changed).toBe(true);
  });

  test("a near-limit home is deprioritised BEFORE it errors, and still tried last", () => {
    const plan = planDirectOrder({ members: [m("claw1", "near_limit"), m("claw2", "ok")], nowMs: NOW });
    expect(plan?.order).toEqual(["anthropic:claw2", "anthropic:claw1"]);
    expect(plan?.sticky).toEqual({ account: "claw2", since: NOW });
  });

  test("rank behind the leader: usable, near-limit, exhausted, rejected login", () => {
    const plan = planDirectOrder({
      members: [m("a", "credential_failed"), m("b", "exhausted"), m("c", "near_limit"), m("d", "ok")],
      nowMs: NOW,
    });
    expect(plan?.order).toEqual(["anthropic:d", "anthropic:c", "anthropic:b", "anthropic:a"]);
  });

  test("dwell: a recovered home waits out minDwellMs, then reclaims the lead", () => {
    const sticky = { account: "claw2", since: NOW - 60_000 };
    const held = planDirectOrder({
      members: [m("claw1", "ok"), m("claw2", "ok")],
      sticky,
      nowMs: NOW,
      minDwellMs: 600_000,
    });
    expect(held?.firstAccount).toBe("claw2");
    const back = planDirectOrder({
      members: [m("claw1", "ok"), m("claw2", "ok")],
      sticky,
      nowMs: NOW + 600_000,
      minDwellMs: 600_000,
    });
    expect(back?.firstAccount).toBe("claw1");
    expect(back?.sticky).toBeUndefined();
  });

  test("health beats stickiness", () => {
    const plan = planDirectOrder({
      members: [m("claw1", "ok"), m("claw2", "exhausted")],
      sticky: { account: "claw2", since: NOW - 1000 },
      nowMs: NOW,
    });
    expect(plan?.firstAccount).toBe("claw1");
  });

  test("hand-added profiles are kept, after the managed ones, in their own order", () => {
    const plan = planDirectOrder({
      members: [m("claw1", "near_limit"), m("claw2", "ok")],
      currentOrder: ["anthropic:backup-key", "anthropic:claw1", "anthropic:other", "anthropic:backup-key"],
      nowMs: NOW,
    });
    expect(plan?.order).toEqual([
      "anthropic:claw2",
      "anthropic:claw1",
      "anthropic:backup-key",
      "anthropic:other",
    ]);
  });

  test("changed is false when the store already matches, so no write happens", () => {
    const plan = planDirectOrder({
      members: [m("claw1", "ok"), m("claw2", "ok")],
      currentOrder: ["anthropic:claw1", "anthropic:claw2"],
      nowMs: NOW,
    });
    expect(plan?.changed).toBe(false);
  });

  test("no members, no plan", () => {
    expect(planDirectOrder({ members: [], nowMs: NOW })).toBeUndefined();
  });
});

describe("adopting a profile the operator already stored", () => {
  test("direct.profileId with no token adopts, for any account kind", () => {
    for (const account of [
      { id: "claw1", native: true, direct: { profileId: "anthropic:manual" } },
      { id: "claw2", configDir: "~/.claw2", direct: { profileId: "anthropic:someone" } },
      { id: "claw3", oauthTokenRef: REF, direct: { profileId: "anthropic:x" } },
    ]) {
      expect(directCredentialSource(account)).toEqual({ kind: "existing" });
    }
  });

  test("a token source next to profileId still means sync-under-that-id", () => {
    expect(
      directCredentialSource({ id: "a", native: true, direct: { profileId: "anthropic:a1", tokenRef: REF } }),
    ).toEqual({ kind: "ref", ref: REF, reused: false });
  });

  test("the guidance names the adopt option", () => {
    expect(DIRECT_SETUP_TOKEN_GUIDANCE).toContain("direct.profileId");
  });
});

describe("directRoutePools", () => {
  test("two members pool; one does not; manageOrder:false does not", async () => {
    const { directRoutePools } = await import("../src/direct-route");
    const two = [
      { id: "a", oauthTokenRef: REF, direct: true },
      { id: "b", native: true, direct: { profileId: "anthropic:b" } },
    ];
    expect(directRoutePools(two)).toBe(true);
    expect(directRoutePools(two.slice(0, 1))).toBe(false);
    expect(directRoutePools([...two.slice(0, 1), { id: "c", native: true, direct: true }])).toBe(false);
    expect(directRoutePools(two, { manageOrder: false })).toBe(false);
    expect(directRoutePools([{ id: "a", oauthTokenRef: REF }, { id: "b", oauthTokenRef: REF2 }])).toBe(false);
  });
});
