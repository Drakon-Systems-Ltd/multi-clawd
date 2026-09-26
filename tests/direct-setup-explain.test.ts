/**
 * The direct route's wizard and explain surfaces. Two promises are pinned:
 * the wizard never offers to reuse a login that is a rotating grant, and
 * explain says which profile serves `anthropic/*`, whether it is really
 * stored, and whether it is cooling down — without ever printing a secret.
 */
import { describe, expect, test } from "vitest";
import { buildDirectSetting, canReuseCliTokenForDirect } from "../src/setup-core";
import { annotateChainRef, renderDirectSection, renderExplanation } from "../src/explain-core";

const REF = { source: "exec", provider: "vault", id: "op://Vault/Item/field" };

describe("buildDirectSetting", () => {
  test("skip leaves the account alone", () => {
    expect(buildDirectSetting({ id: "claw1", native: true }, { kind: "skip" })).toBeUndefined();
  });

  test("reuse is only possible when the CLI credential is a setup-token", () => {
    expect(buildDirectSetting({ id: "claw2", oauthTokenRef: REF }, { kind: "reuse" })).toBe(true);
    expect(buildDirectSetting({ id: "claw2", oauthTokenFile: "~/t" }, { kind: "reuse" })).toBe(true);
    expect(() => buildDirectSetting({ id: "claw1", native: true }, { kind: "reuse" })).toThrow(/setup-token/);
    expect(() => buildDirectSetting({ id: "claw2", configDir: "~/.claw2" }, { kind: "reuse" })).toThrow();
    expect(canReuseCliTokenForDirect({ id: "claw1", native: true, oauthTokenRef: REF })).toBe(false);
    expect(canReuseCliTokenForDirect({ id: "claw2", oauthTokenFile: "~/t" })).toBe(true);
  });

  test("explicit ref / file", () => {
    expect(buildDirectSetting({ id: "claw1", native: true }, { kind: "ref", ref: REF })).toEqual({ tokenRef: REF });
    expect(buildDirectSetting({ id: "claw1", native: true }, { kind: "file", path: " ~/d " })).toEqual({
      tokenFile: "~/d",
    });
    expect(() => buildDirectSetting({ id: "a" }, { kind: "ref", ref: { id: "x" } })).toThrow();
    expect(() => buildDirectSetting({ id: "a" }, { kind: "file", path: " " })).toThrow();
  });
});

describe("explain: direct route", () => {
  const NOW = 1_800_000_000_000;
  const direct = {
    members: [
      { accountId: "claw1", profileId: "anthropic:claw1", source: "setup-token via vault", stored: true },
      {
        accountId: "claw2",
        profileId: "anthropic:claw2",
        source: "reuses its CLI token",
        stored: false,
        cooldownUntil: NOW + 5 * 60_000,
        cooldownReason: "rate_limit",
      },
    ],
    problems: [{ accountId: "claw3", reason: "needs its own setup-token" }],
    order: ["anthropic:claw2", "anthropic:claw1", "anthropic:backup"],
    orderSource: "stored override",
  };

  test("per-account profile, stored state, cooldown, order with unmanaged marked", () => {
    const text = renderDirectSection(direct, NOW).join("\n");
    expect(text).toContain("claw1 → anthropic:claw1");
    expect(text).toContain("stored in OpenClaw");
    expect(text).toMatch(/NOT STORED — run `multi-clawd direct sync`/);
    expect(text).toMatch(/COOLING DOWN \(rate_limit\) for ~5m/);
    expect(text).toContain("claw3: NOT on the direct route — needs its own setup-token");
    expect(text).toContain(
      "order (stored override): anthropic:claw2 → anthropic:claw1 → anthropic:backup (not managed)",
    );
  });

  test("an expired cooldown is not reported", () => {
    const text = renderDirectSection(direct, NOW + 10 * 60_000).join("\n");
    expect(text).not.toContain("COOLING DOWN");
  });

  test("anthropic rungs read as pooled only when the direct route is configured", () => {
    expect(annotateChainRef("anthropic/claude-sonnet-5", undefined)).toMatch(/bypasses the pool/);
    expect(annotateChainRef("anthropic/claude-sonnet-5", undefined, direct)).toMatch(
      /pooled by auth-profile order \(claw1, then claw2\)/,
    );
    expect(annotateChainRef("claude-cli/claude-sonnet-5", undefined, direct)).toMatch(/bypasses the pool/);
  });

  test("renderExplanation is unchanged for a setup without the direct route", () => {
    const base = {
      accounts: [{ id: "claw1", native: true }],
      chain: { primary: "anthropic/claude-sonnet-5" },
      health: [],
    };
    const text = renderExplanation(base);
    expect(text).not.toContain("DIRECT ROUTE");
    expect(text).toMatch(/bypasses the pool/);
    const withDirect = renderExplanation({ ...base, direct, nowMs: NOW });
    expect(withDirect).toContain("DIRECT ROUTE");
    expect(withDirect).not.toContain("op://");
  });
});

describe("explain: adopted profiles", () => {
  test("a missing adopted profile points at paste-token, not at direct sync", () => {
    const text = renderDirectSection(
      {
        members: [{ accountId: "claw1", profileId: "anthropic:mine", source: "adopted", stored: false, adopted: true }],
        problems: [],
      },
      0,
    ).join("\n");
    expect(text).toContain("paste-token --provider anthropic --profile-id anthropic:mine");
    expect(text).not.toContain("direct sync");
  });
});
