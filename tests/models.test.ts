import { describe, expect, test } from "vitest";
import {
  canonicalModelId,
  isModernClaudeModelId,
  resolveModelSpec,
  buildCatalogEntries,
} from "../src/models";

describe("isModernClaudeModelId", () => {
  test("accepts today's subscription models", () => {
    expect(isModernClaudeModelId("claude-fable-5")).toBe(true);
    expect(isModernClaudeModelId("claude-opus-4-8")).toBe(true);
    expect(isModernClaudeModelId("claude-haiku-4-5")).toBe(true);
  });

  test("accepts future models it has never heard of (Opus 5 era)", () => {
    expect(isModernClaudeModelId("claude-opus-5")).toBe(true);
    expect(isModernClaudeModelId("claude-opus-5-1")).toBe(true);
    expect(isModernClaudeModelId("claude-mythos-5")).toBe(true);
    expect(isModernClaudeModelId("claude-fable-5-20270101")).toBe(true);
  });

  test("rejects non-Claude and malformed ids", () => {
    expect(isModernClaudeModelId("gpt-5.6-sol")).toBe(false);
    expect(isModernClaudeModelId("claude")).toBe(false);
    expect(isModernClaudeModelId("claude-")).toBe(false);
    expect(isModernClaudeModelId("Claude-Opus-5")).toBe(false);
    expect(isModernClaudeModelId("claude-opus-5;rm -rf")).toBe(false);
    expect(isModernClaudeModelId("")).toBe(false);
  });
});

describe("canonicalModelId", () => {
  test("maps CLI aliases to canonical ids", () => {
    expect(canonicalModelId("opus-4.8")).toBe("claude-opus-4-8");
    expect(canonicalModelId("sonnet-4.6")).toBe("claude-sonnet-4-6");
  });

  test("passes through short CLI aliases the claude binary resolves itself", () => {
    expect(canonicalModelId("opus")).toBe("opus");
    expect(canonicalModelId("sonnet")).toBe("sonnet");
    expect(canonicalModelId("haiku")).toBe("haiku");
  });

  test("passes through unknown modern claude ids instead of rejecting them", () => {
    expect(canonicalModelId("claude-opus-5")).toBe("claude-opus-5");
    expect(canonicalModelId("claude-opus-5-20270301")).toBe(
      "claude-opus-5-20270301",
    );
  });

  test("rejects non-claude ids and junk", () => {
    expect(canonicalModelId("gpt-5.6-sol")).toBeUndefined();
    expect(canonicalModelId("")).toBeUndefined();
    expect(canonicalModelId("  ")).toBeUndefined();
  });
});

describe("resolveModelSpec", () => {
  test("known models keep their real context windows and names", () => {
    const fable = resolveModelSpec("claude-fable-5");
    expect(fable.contextWindow).toBe(1000000);
    expect(fable.maxTokens).toBe(128000);
    expect(fable.name).toBe("Claude Fable 5");
  });

  test("unknown modern ids get conservative defaults and a derived name", () => {
    const spec = resolveModelSpec("claude-opus-5");
    expect(spec.contextWindow).toBe(200000);
    expect(spec.maxTokens).toBe(64000);
    expect(spec.name).toBe("Claude Opus 5");
  });

  test("derived names handle date suffixes", () => {
    expect(resolveModelSpec("claude-opus-5-20270301").name).toBe(
      "Claude Opus 5 20270301",
    );
  });
});

describe("buildCatalogEntries", () => {
  test("includes account label and account-configured extra models", () => {
    const entries = buildCatalogEntries(
      { id: "claw2", label: "Second Claude", models: ["claude-opus-5"] },
      ["claude-fable-5"],
    );
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("claude-fable-5");
    expect(ids).toContain("claude-opus-5");
    const fable = entries.find((e) => e.id === "claude-fable-5")!;
    expect(fable.name).toBe("Claude Fable 5 (Second Claude)");
    expect(fable.provider).toBe("claw2");
  });

  test("dedupes when a configured model is already in the base list", () => {
    const entries = buildCatalogEntries(
      { id: "claw2", models: ["claude-fable-5"] },
      ["claude-fable-5"],
    );
    expect(entries.filter((e) => e.id === "claude-fable-5")).toHaveLength(1);
  });

  test("ignores configured models that are not modern claude ids", () => {
    const entries = buildCatalogEntries(
      { id: "claw2", models: ["gpt-5.6-sol"] },
      ["claude-fable-5"],
    );
    expect(entries.map((e) => e.id)).not.toContain("gpt-5.6-sol");
  });
});
