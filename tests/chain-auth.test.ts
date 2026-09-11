import { describe, expect, test } from "vitest";
import { auditChainAuth, STALE_OAUTH_GRACE_MS, type AuthProfileRecord } from "../src/chain-auth";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

function ref(ref: string, allowlist = false) {
  return { surface: "agents.defaults.model.fallbacks[0]", ref, allowlist };
}

function oauth(id: string, provider: string, expiresAt: string): AuthProfileRecord {
  return { id, provider, type: "oauth", expiresAt };
}

describe("auditChainAuth", () => {
  test("a provider with an eligible, unexpired profile is silent", () => {
    expect(
      auditChainAuth({
        refs: [ref("openai/gpt-6")],
        profiles: [oauth("openai:one", "openai", "2026-09-20T00:00:00.000Z")],
        order: { openai: ["openai:one"] },
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  test("pool, pool-member and CLI-backed rungs are skipped", () => {
    expect(
      auditChainAuth({
        refs: [ref("clawd/claude-fable-5"), ref("claw2/claude-haiku-4-5"), ref("claude-cli/opus")],
        profiles: [],
        poolId: "clawd",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  test("allowlist-only rungs never produce findings", () => {
    expect(
      auditChainAuth({ refs: [ref("openai/gpt-6", true)], profiles: [], nowMs: NOW }),
    ).toEqual([]);
  });

  test("an order that excludes every stored profile fails", () => {
    const findings = auditChainAuth({
      refs: [ref("xai/grok-4.6")],
      profiles: [
        { id: "xai:default", provider: "xai", type: "api_key" },
        oauth("xai:person", "xai", "2026-09-20T00:00:00.000Z"),
      ],
      order: { xai: ["xai:gone"] },
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("bad");
    expect(findings[0].reason).toContain("xai:gone");
    expect(findings[0].surfaces).toEqual(["agents.defaults.model.fallbacks[0]"]);
  });

  test("an order entry that matches nothing warns while a working entry remains", () => {
    const findings = auditChainAuth({
      refs: [ref("openai/gpt-6")],
      profiles: [oauth("openai:one", "openai", "2026-09-20T00:00:00.000Z")],
      order: { openai: ["openai:one", "openai:typo"] },
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].reason).toContain("openai:typo");
  });

  test("a just-expired OAuth token warns — refresh is normal, not breakage", () => {
    const findings = auditChainAuth({
      refs: [ref("xai/grok-4.6")],
      profiles: [oauth("xai:person", "xai", "2026-09-11T11:40:00.000Z")],
      order: { xai: ["xai:person"] },
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].reason).toContain("past expiry");
  });

  test("an expiry stale beyond the refresh grace fails", () => {
    const stale = new Date(NOW - STALE_OAUTH_GRACE_MS - 86_400_000).toISOString();
    const findings = auditChainAuth({
      refs: [ref("xai/grok-4.6")],
      profiles: [oauth("xai:person", "xai", stale)],
      order: { xai: ["xai:person"] },
      nowMs: NOW,
    });
    expect(findings[0].severity).toBe("bad");
    expect(findings[0].reason).toContain("refresh has stopped working");
  });

  test("a non-expiring eligible profile rescues an expired sibling", () => {
    // An api_key profile alongside a dead OAuth one means the rung still
    // authenticates — flagging it would be a false positive.
    expect(
      auditChainAuth({
        refs: [ref("xai/grok-4.6")],
        profiles: [
          oauth("xai:person", "xai", "2026-01-01T00:00:00.000Z"),
          { id: "xai:default", provider: "xai", type: "api_key" },
        ],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  test("no profile at all warns rather than fails (env API keys are invisible here)", () => {
    const findings = auditChainAuth({ refs: [ref("google/gemini-3")], profiles: [], nowMs: NOW });
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].provider).toBe("google");
  });

  test("surfaces from several rungs collapse into one finding per provider", () => {
    const findings = auditChainAuth({
      refs: [
        { surface: "agents.defaults.model.fallbacks[0]", ref: "openai/gpt-6", allowlist: false },
        { surface: "agents.entries.other.model.primary", ref: "openai/gpt-5.6", allowlist: false },
      ],
      profiles: [],
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].surfaces).toHaveLength(2);
  });
});
