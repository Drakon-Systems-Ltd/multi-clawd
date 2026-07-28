import { describe, expect, test } from "vitest";
import { diffCatalogModels, formatNewModelNotice } from "../src/model-currency";

const NOW = 1_785_000_000_000;

describe("diffCatalogModels", () => {
  test("first run records a baseline and stays silent", () => {
    // Alerting here would dump the whole catalog into the operator's chat for
    // no reason — nothing is genuinely "new" the first time we look.
    const r = diffCatalogModels(undefined, ["claude-opus-5", "claude-fable-5"], [], NOW);
    expect(r.firstRun).toBe(true);
    expect(r.newIds).toEqual([]);
    expect(r.unusedNewIds).toEqual([]);
    expect(r.nextState.ids).toEqual(["claude-fable-5", "claude-opus-5"]);
    expect(r.nextState.updatedAt).toBe(NOW);
  });

  test("an empty stored set counts as a first run, not as 'everything is new'", () => {
    const r = diffCatalogModels({ ids: [] }, ["claude-opus-5"], [], NOW);
    expect(r.firstRun).toBe(true);
    expect(r.newIds).toEqual([]);
  });

  test("a genuinely new id is reported once and then remembered", () => {
    const stored = { ids: ["claude-fable-5"] };
    const catalog = ["claude-fable-5", "claude-opus-5"];
    const first = diffCatalogModels(stored, catalog, ["clawd/claude-fable-5"], NOW);
    expect(first.newIds).toEqual(["claude-opus-5"]);
    expect(first.unusedNewIds).toEqual(["claude-opus-5"]);

    // Second run with the persisted state: no longer new.
    const second = diffCatalogModels(first.nextState, catalog, ["clawd/claude-fable-5"], NOW);
    expect(second.newIds).toEqual([]);
    expect(second.unusedNewIds).toEqual([]);
  });

  test("a new model already in the chain is new but NOT worth raising", () => {
    const r = diffCatalogModels(
      { ids: ["claude-fable-5"] },
      ["claude-fable-5", "claude-opus-5"],
      ["clawd/claude-opus-5", "clawd/claude-fable-5"],
      NOW,
    );
    expect(r.newIds).toEqual(["claude-opus-5"]);
    expect(r.unusedNewIds).toEqual([]);
  });

  test("chain refs match on the bare id, whatever the provider prefix", () => {
    const r = diffCatalogModels(
      { ids: ["claude-fable-5"] },
      ["claude-fable-5", "claude-opus-5"],
      ["anthropic/claude-opus-5"],
      NOW,
    );
    expect(r.unusedNewIds).toEqual([]);
  });

  test("non-Claude catalog entries are ignored entirely", () => {
    const r = diffCatalogModels(
      { ids: ["claude-fable-5"] },
      ["claude-fable-5", "gpt-5.6-sol", "grok-4.5"],
      [],
      NOW,
    );
    expect(r.newIds).toEqual([]);
    expect(r.nextState.ids).toEqual(["claude-fable-5"]);
  });

  test("a model disappearing from the catalog is not reported as new", () => {
    const r = diffCatalogModels({ ids: ["claude-opus-4-6", "claude-fable-5"] }, ["claude-fable-5"], [], NOW);
    expect(r.newIds).toEqual([]);
    expect(r.nextState.ids).toEqual(["claude-fable-5"]);
  });
});

describe("formatNewModelNotice", () => {
  test("says nothing when there is nothing new", () => {
    expect(formatNewModelNotice([], "clawd")).toBeUndefined();
  });

  test("offers rather than recommends, and never ranks the models", () => {
    const msg = formatNewModelNotice(["claude-opus-5"], "clawd")!;
    expect(msg).toContain("clawd/claude-opus-5");
    expect(msg).toContain("your call");
    expect(msg).toContain("multi-clawd chain");
    // The whole design stance: no "better", "best", "upgrade", "recommended".
    expect(msg).not.toMatch(/\b(better|best|upgrade|recommend|should switch)\b/i);
  });

  test("pluralises honestly", () => {
    expect(formatNewModelNotice(["a-1"], "clawd")).toMatch(/^A new Claude model is/);
    expect(formatNewModelNotice(["a-1", "b-2"], "clawd")).toMatch(/^New Claude models are/);
  });
});
