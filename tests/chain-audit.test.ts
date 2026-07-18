import { describe, expect, test } from "vitest";
import { auditEffectiveChain, isClaudeModelId, type ChainFinding } from "../src/chain-audit";

const POOL = "clawd";

/** aiquant's real shape: non-Claude primary, clawd/ fallbacks, non-Claude subagents. */
const aiquantConfig = {
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

/** clawdbot1's regression: a Claude fallback pinned direct to the Anthropic API. */
const clawdbot1Config = {
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
  test("aiquant shape (openai primary, clawd/ fallbacks, openai subagents) → ZERO warnings", () => {
    const findings = auditEffectiveChain(aiquantConfig, POOL);
    expect(findings).toEqual([]);
  });

  test("clawdbot1 shape (anthropic/ Claude fallback) → one strong warn naming the ref", () => {
    const findings = auditEffectiveChain(clawdbot1Config, POOL);
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
    expect(auditEffectiveChain(clawdbot1Config, undefined)).toEqual([]);
    expect(auditEffectiveChain(clawdbot1Config, null)).toEqual([]);
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
