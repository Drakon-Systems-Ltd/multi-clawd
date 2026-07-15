import { describe, expect, test } from "vitest";
import { resolveBaseModelIds, loadBundledCatalogIds } from "../src/catalog-source";
import { FALLBACK_MODEL_IDS } from "../src/models";

describe("resolveBaseModelIds", () => {
  test("uses mirrored bundled ids when the loader returns them", async () => {
    const ids = await resolveBaseModelIds(async () => [
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    expect(ids).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  test("falls back to the built-in list when the loader returns null", async () => {
    const ids = await resolveBaseModelIds(async () => null);
    expect(ids).toEqual([...FALLBACK_MODEL_IDS]);
  });

  test("falls back when the loader throws", async () => {
    const ids = await resolveBaseModelIds(async () => {
      throw new Error("exports map said no");
    });
    expect(ids).toEqual([...FALLBACK_MODEL_IDS]);
  });

  test("falls back when the loader returns an empty or junk list", async () => {
    expect(await resolveBaseModelIds(async () => [])).toEqual([
      ...FALLBACK_MODEL_IDS,
    ]);
    expect(
      await resolveBaseModelIds(async () => ["GPT-6", ""] as string[]),
    ).toEqual([...FALLBACK_MODEL_IDS]);
  });

  test("filters junk out of an otherwise good mirrored list", async () => {
    const ids = await resolveBaseModelIds(async () => [
      "claude-opus-5",
      "not a model",
    ]);
    expect(ids).toEqual(["claude-opus-5"]);
  });
});

describe("loadBundledCatalogIds (real environment)", () => {
  test("never throws; returns null or a list of modern claude ids", async () => {
    const result = await loadBundledCatalogIds();
    if (result !== null) {
      expect(Array.isArray(result)).toBe(true);
      for (const id of result) {
        expect(id).toMatch(/^claude-/);
      }
    }
  });
});
