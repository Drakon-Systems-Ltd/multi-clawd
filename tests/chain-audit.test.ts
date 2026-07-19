import { describe, expect, test } from "vitest";
import {
  auditEffectiveChain,
  auditSessionOverrides,
  isClaudeModelId,
  maskSessionKey,
  type ChainFinding,
  type SessionOverrideEntry,
} from "../src/chain-audit";

const POOL = "clawd";

/** Healthy shape: non-Claude primary, clawd/ fallbacks, non-Claude subagents. */
const nonClaudePrimaryConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.6-sol",
        fallbacks: ["clawd/claude-fable-5", "clawd/claude-opus-4-8", "xai/grok-4.5"],
      },
      subagents: { model: "openai/gpt-5.6-sol" },
    },
  },
};

/** The regression this guards against: a Claude fallback pinned direct to the Anthropic API. */
const anthropicPinnedConfig = {
  agents: {
    defaults: {
      model: {
        primary: "clawd/claude-opus-4-8",
        fallbacks: ["clawd/claude-fable-5", "anthropic/claude-fable-5"],
      },
    },
  },
};

const warnsOnly = (findings: ChainFinding[]) => findings.filter((f) => f.severity === "warn");

describe("isClaudeModelId", () => {
  test("accepts claude-* ids and short/versioned CLI aliases", () => {
    expect(isClaudeModelId("claude-fable-5")).toBe(true);
    expect(isClaudeModelId("claude-opus-4-8")).toBe(true);
    expect(isClaudeModelId("opus")).toBe(true);
    expect(isClaudeModelId("opus-4.8")).toBe(true);
    expect(isClaudeModelId("haiku")).toBe(true);
  });

  test("rejects non-Claude ids", () => {
    expect(isClaudeModelId("gpt-5.6-sol")).toBe(false);
    expect(isClaudeModelId("grok-4.5")).toBe(false);
    expect(isClaudeModelId("gemini-3-pro")).toBe(false);
  });
});

describe("auditEffectiveChain", () => {
  test("healthy shape (openai primary, clawd/ fallbacks, openai subagents) → ZERO warnings", () => {
    const findings = auditEffectiveChain(nonClaudePrimaryConfig, POOL);
    expect(findings).toEqual([]);
  });

  test("anthropic-pinned shape (Claude fallback) → one strong warn naming the ref", () => {
    const findings = auditEffectiveChain(anthropicPinnedConfig, POOL);
    const warns = warnsOnly(findings);
    expect(warns).toHaveLength(1);
    expect(warns[0].surface).toBe("agents.defaults.model.fallbacks[1]");
    expect(warns[0].ref).toBe("anthropic/claude-fable-5");
    expect(warns[0].reason).toContain("bypassing the clawd pool");
  });

  test("claw2/ account pin → one account-pin warn", () => {
    const config = {
      agents: { defaults: { model: { primary: "claw2/claude-opus-4-8" } } },
    };
    const warns = warnsOnly(auditEffectiveChain(config, POOL));
    expect(warns).toHaveLength(1);
    expect(warns[0].ref).toBe("claw2/claude-opus-4-8");
    expect(warns[0].reason).toContain("pins a single pool account");
  });

  test("claude-cli/ direct pin → strong warn", () => {
    const config = {
      agents: { defaults: { model: { primary: "claude-cli/claude-opus-4-8" } } },
    };
    const warns = warnsOnly(auditEffectiveChain(config, POOL));
    expect(warns).toHaveLength(1);
    expect(warns[0].reason).toContain("claude CLI");
  });

  test("no clawd pool configured → empty (section skipped)", () => {
    expect(auditEffectiveChain(anthropicPinnedConfig, undefined)).toEqual([]);
    expect(auditEffectiveChain(anthropicPinnedConfig, null)).toEqual([]);
  });

  test("clawd-only Claude tiers → empty", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "clawd/claude-opus-4-8",
            fallbacks: ["clawd/claude-fable-5", "clawd/claude-haiku-4-5"],
          },
          subagents: { model: "clawd/claude-haiku-4-5" },
        },
      },
    };
    expect(auditEffectiveChain(config, POOL)).toEqual([]);
  });

  test("non-Claude fallbacks are never flagged (openai/xai/google)", () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol", fallbacks: ["xai/grok-4.5", "google/gemini-3-pro"] } },
      },
    };
    expect(auditEffectiveChain(config, POOL)).toEqual([]);
  });

  test("bare Claude id (no provider) is not flagged — routing is ambiguous, don't cry wolf", () => {
    const config = { agents: { defaults: { model: { primary: "claude-opus-4-8" } } } };
    expect(auditEffectiveChain(config, POOL)).toEqual([]);
  });

  test("allowlist bypass entries report at note level, never as warnings", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol", fallbacks: ["clawd/claude-fable-5"] },
          models: {
            "clawd/claude-fable-5": {},
            "anthropic/claude-opus-4-8": { alias: "opus" },
            "claw2/claude-fable-5": {},
            "openai/gpt-5.6-sol": { alias: "sol" },
          },
        },
      },
    };
    const findings = auditEffectiveChain(config, POOL);
    expect(warnsOnly(findings)).toEqual([]);
    const notes = findings.filter((f) => f.severity === "note");
    expect(notes.map((n) => n.ref).sort()).toEqual(["anthropic/claude-opus-4-8", "claw2/claude-fable-5"]);
  });

  test("per-agent overrides and subagent profiles are scanned", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "clawd/claude-opus-4-8" },
          subagents: {
            model: "clawd/claude-haiku-4-5",
            researcher: { model: "anthropic/claude-fable-5" },
          },
        },
        list: [{ id: "main", model: { primary: "claw3/claude-opus-4-8" } }],
      },
    };
    const warns = warnsOnly(auditEffectiveChain(config, POOL));
    expect(warns.map((w) => w.surface).sort()).toEqual([
      "agents.defaults.subagents.researcher.model",
      "agents.list[main].model.primary",
    ]);
  });

  test("cron/scheduled sections are scanned defensively when present", () => {
    const config = {
      agents: { defaults: { model: { primary: "clawd/claude-opus-4-8" } } },
      crons: [{ id: "nightly", model: "anthropic/claude-opus-4-8" }],
    };
    const warns = warnsOnly(auditEffectiveChain(config, POOL));
    expect(warns).toHaveLength(1);
    expect(warns[0].surface).toBe("crons[0].model");
  });
});

describe("maskSessionKey", () => {
  test("masks a numeric channel-id tail to …last4 (Telegram chat id)", () => {
    expect(maskSessionKey("agent:main:telegram:direct:1000000001")).toBe("agent:main:telegram:direct:…0001");
  });
  test("masks a uuid/hex tail", () => {
    expect(maskSessionKey("agent:main:subagent:b29898de-b4e5-4446")).toBe("agent:main:subagent:…4446");
  });
  test("leaves a non-id tail intact (structural key)", () => {
    expect(maskSessionKey("agent:main:main")).toBe("agent:main:main");
  });
  test("leaves a long human session NAME intact (has non-hex letters → not an id)", () => {
    // Would be over-masked by a blunt length cap; must survive for actionability.
    expect(maskSessionKey("agent:main:mc-status-check")).toBe("agent:main:mc-status-check");
    expect(maskSessionKey("agent:main:explicit:case-smoke-20260713t222001")).toBe(
      "agent:main:explicit:case-smoke-20260713t222001",
    );
  });
  test("keeps the structural prefix so the warn stays actionable", () => {
    const masked = maskSessionKey("agent:main:telegram:direct:1000000001");
    expect(masked.startsWith("agent:main:telegram:direct:")).toBe(true);
    expect(masked).not.toContain("1000000001");
  });
});

describe("auditSessionOverrides", () => {
  // All fixtures below are real sessions.json entry shapes (Linux + macOS
  // hosts), not reconstructed.
  const store = (entries: Record<string, SessionOverrideEntry>) => entries;

  test("POSITIVE strong (live main session): anthropic/ user pin → one strong warn", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:x": { providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].surface).toBe("session agent:main:x");
    expect(findings[0].ref).toBe("anthropic/claude-opus-4-8");
    expect(findings[0].reason).toContain("bypassing the clawd pool");
    expect(findings[0].reason).toContain("no cross-account failover");
  });

  test("POSITIVE warn (live telegram session): claw2/ user pin → one account-pin warn", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:telegram": { providerOverride: "claw2", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].ref).toBe("claw2/claude-opus-4-8");
    expect(findings[0].reason).toContain("single pool account");
  });

  test("EPHEMERAL: subagent session with off-pool user pin → ZERO (per-run, not a standing bypass)", () => {
    // Live shape: a spawned coding subagent pinned to anthropic/opus.
    // Ephemeral per-run routing, re-resolved every spawn — must not warn, or
    // every coding-subagent run wolf-cries the section.
    const findings = auditSessionOverrides(
      store({
        "agent:main:subagent:b29898de-b4e5-4446-aaeb-d4442c7ea568": {
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-8",
          modelOverrideSource: "user",
        },
      }),
      true,
    );
    expect(findings).toEqual([]);
  });

  test("standing session audited even alongside skipped subagents (mixed store)", () => {
    const findings = auditSessionOverrides(
      store({
        "agent:main:main": { providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" },
        "agent:main:subagent:dead-uuid": { providerOverride: "anthropic", modelOverride: "claude-sonnet-5", modelOverrideSource: "user" },
      }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].surface).toBe("session agent:main:main");
  });

  test("NEGATIVE auto-fallback (live macOS host): clawd/ source=auto → ZERO (source gate excludes)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:mac": { providerOverride: "clawd", modelOverride: "claude-opus-4-8", modelOverrideSource: "auto" } }),
      true,
    );
    expect(findings).toEqual([]);
  });

  test("NEGATIVE clawd manual pin: clawd/ source=user → ZERO (clawd is in-pool)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:y": { providerOverride: "clawd", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toEqual([]);
  });

  test("SCHEMA DRIFT: source present but no provider field → one schema-drift warn", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:drift": { modelOverride: "claude-opus-4-8", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].surface).toBe("session agent:main:drift");
    expect(findings[0].reason).toContain("schema drift");
  });

  test("SCHEMA DRIFT: source+provider present but no model id → one schema-drift warn (not silent skip)", () => {
    // A present-but-empty model would classify as null in offPoolClaudeRef and
    // slip through silently — a false-negative. It must surface instead.
    const findings = auditSessionOverrides(
      store({ "agent:main:nomodel": { providerOverride: "anthropic", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].reason).toContain("schema drift");
    expect(findings[0].reason).toContain("model");
  });

  test("NO POOL: any override with poolConfigured=false → ZERO (skip)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:x": { providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" } }),
      false,
    );
    expect(findings).toEqual([]);
  });

  test("config-level entry (no modelOverrideSource) → ZERO (source gate excludes)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:cfg": { model: "claude-fable-5", modelProvider: "clawd" } as SessionOverrideEntry }),
      true,
    );
    expect(findings).toEqual([]);
  });

  test("future deliberate source (source=operator, off-pool) is still caught — gate is !== 'auto', not === 'user'", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:op": { providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "operator" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].ref).toBe("anthropic/claude-opus-4-8"); // classified strong despite novel source
    expect(findings[0].reason).toContain("bypassing the clawd pool");
  });

  test("modelProvider is used when providerOverride is absent (auto-fallback that drifted to user)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:mp": { modelProvider: "anthropic", modelOverride: "claude-opus-4-7", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].ref).toBe("anthropic/claude-opus-4-7");
  });

  test("non-Claude session pin (openai/) → ZERO (only Claude tiers need pool failover)", () => {
    const findings = auditSessionOverrides(
      store({ "agent:main:oai": { providerOverride: "openai", modelOverride: "gpt-5.6-sol", modelOverrideSource: "user" } }),
      true,
    );
    expect(findings).toEqual([]);
  });

  test("mixed real store: strong + account-pin warn, auto/clawd/openai entries clean", () => {
    const findings = auditSessionOverrides(
      store({
        "agent:main:strong": { providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" },
        "agent:main:pin": { providerOverride: "claw2", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" },
        "agent:main:auto": { providerOverride: "clawd", modelOverride: "claude-opus-4-8", modelOverrideSource: "auto" },
        "agent:main:pool": { providerOverride: "clawd", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" },
        "agent:main:oai": { modelProvider: "xai", model: "grok-4.5" } as SessionOverrideEntry,
        "agent:main:empty": {} as SessionOverrideEntry,
      }),
      true,
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.ref).sort()).toEqual(["anthropic/claude-opus-4-8", "claw2/claude-opus-4-8"]);
    expect(findings.every((f) => f.severity === "warn")).toBe(true);
  });
});
