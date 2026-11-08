import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadBundledCatalog,
  loadBundledCatalogIds,
  loadCliCatalogModuleIds,
  readManifestCatalogIds,
  resolveBaseModelIds,
  resolveOpenClawDistRoot,
} from "../src/catalog-source";
import { FALLBACK_MODEL_IDS, isModernClaudeModelId } from "../src/models";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Manifest fixtures: the bundled Anthropic manifest's `modelCatalog` at each tag. */
const MANIFEST_FIXTURES = {
  "2026.8.1": "anthropic-manifest-2026.8.1.json",
  "2026.10.10": "anthropic-manifest-2026.10.10.json",
  "2026.11.1": "anthropic-manifest-2026.11.1.json",
} as const;

type ManifestFixture = { modelCatalog: { providers: Record<string, { models: Array<{ id: string }> }> } };

function readFixture(name: string): ManifestFixture {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as ManifestFixture;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway `dist/` tree shaped like an installed OpenClaw: the bundled
 * Anthropic extension dir with an optional manifest and optional legacy
 * catalog module. Nothing real is touched.
 */
function fakeDist(opts: { manifest?: unknown; cliCatalogIds?: string[]; cliCatalogSource?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "multi-clawd-dist-"));
  tempDirs.push(root);
  const distRoot = join(root, "dist");
  const ext = join(distRoot, "extensions", "anthropic");
  mkdirSync(ext, { recursive: true });
  if (opts.manifest !== undefined) {
    writeFileSync(
      join(ext, "openclaw.plugin.json"),
      typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest),
    );
  }
  if (opts.cliCatalogSource !== undefined) {
    writeFileSync(join(ext, "cli-catalog.js"), opts.cliCatalogSource);
  } else if (opts.cliCatalogIds) {
    writeFileSync(
      join(ext, "cli-catalog.js"),
      `export function buildClaudeCliCatalogEntries() { return ${JSON.stringify(
        opts.cliCatalogIds.map((id) => ({ id, name: id })),
      )}; }\n`,
    );
  }
  return distRoot;
}

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

describe("bundled catalog mirror across OpenClaw layouts (fixture dist trees)", () => {
  test("OpenClaw 2026.8.1 layout: the legacy cli-catalog module wins over the manifest", async () => {
    const distRoot = fakeDist({
      manifest: readFixture(MANIFEST_FIXTURES["2026.8.1"]),
      cliCatalogIds: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"],
    });
    const catalog = await loadBundledCatalog({ distRoot });
    expect(catalog?.source).toBe("cli-catalog");
    expect(catalog?.ids).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
  });

  test.each(["2026.10.10", "2026.11.1"] as const)(
    "OpenClaw %s layout (no cli-catalog.js): the manifest's anthropic list is mirrored, not the static fallback",
    async (version) => {
      const fixture = readFixture(MANIFEST_FIXTURES[version]);
      // The premise of the regression: claude-cli is runtime-discovered, so its static list is empty.
      expect(fixture.modelCatalog.providers["claude-cli"].models).toEqual([]);
      const distRoot = fakeDist({ manifest: fixture });

      const catalog = await loadBundledCatalog({ distRoot });
      expect(catalog?.source).toBe("manifest");
      expect(catalog?.ids).toEqual(fixture.modelCatalog.providers.anthropic.models.map((m) => m.id));
      expect(catalog?.ids).toContain("claude-haiku-5-5");

      const base = await resolveBaseModelIds(() => loadBundledCatalogIds({ distRoot }));
      expect(base).toEqual(catalog?.ids);
      expect(base.every(isModernClaudeModelId)).toBe(true);
    },
  );

  test("the manifest's claude-cli list is preferred when it is non-empty", () => {
    const distRoot = fakeDist({
      manifest: {
        modelCatalog: {
          providers: {
            "claude-cli": { models: [{ id: "claude-opus-5" }, { id: "claude-opus-5" }] },
            anthropic: { models: [{ id: "claude-haiku-5-5" }] },
          },
        },
      },
    });
    expect(readManifestCatalogIds(distRoot)).toEqual(["claude-opus-5"]);
  });

  test("a manifest without any model declarations yields null, so the static fallback applies", async () => {
    const distRoot = fakeDist({
      manifest: {
        modelCatalog: {
          providers: { "claude-cli": { models: [] }, anthropic: { models: [{ name: "no id" }] } },
        },
      },
    });
    expect(readManifestCatalogIds(distRoot)).toBeNull();
    expect(await loadBundledCatalog({ distRoot })).toBeNull();
    expect(await resolveBaseModelIds(() => loadBundledCatalogIds({ distRoot }))).toEqual([
      ...FALLBACK_MODEL_IDS,
    ]);
  });

  test("a corrupt manifest, a missing extension dir and a broken cli-catalog module never throw", async () => {
    expect(readManifestCatalogIds(fakeDist({ manifest: "{ not json" }))).toBeNull();
    expect(await loadBundledCatalog({ distRoot: fakeDist({}) })).toBeNull();
    expect(await loadBundledCatalog({ distRoot: join(tmpdir(), "multi-clawd-missing-dist") })).toBeNull();

    const broken = fakeDist({
      cliCatalogSource: "export function buildClaudeCliCatalogEntries() { throw new Error('boom'); }\n",
      manifest: readFixture(MANIFEST_FIXTURES["2026.11.1"]),
    });
    expect(await loadCliCatalogModuleIds(broken)).toBeNull();
    // The manifest still rescues the mirror when the legacy module is unusable.
    expect((await loadBundledCatalog({ distRoot: broken }))?.source).toBe("manifest");
  });
});

describe("static fallback covers the bundled Anthropic manifest", () => {
  test.each(Object.entries(MANIFEST_FIXTURES))(
    "every id the OpenClaw %s manifest declares for claude-cli/anthropic is in FALLBACK_MODEL_IDS",
    (_version, file) => {
      const providers = readFixture(file).modelCatalog.providers;
      const declared = ["claude-cli", "anthropic"].flatMap((p) => providers[p]?.models.map((m) => m.id) ?? []);
      expect(declared.length).toBeGreaterThan(0);
      const missing = declared.filter((id) => !FALLBACK_MODEL_IDS.includes(id));
      expect(missing).toEqual([]);
    },
  );

  test("every id the installed OpenClaw's manifest declares is in FALLBACK_MODEL_IDS", () => {
    const distRoot = resolveOpenClawDistRoot();
    expect(distRoot).not.toBeNull();
    const ids = readManifestCatalogIds(distRoot!);
    expect(ids).not.toBeNull();
    expect(ids!.filter((id) => !FALLBACK_MODEL_IDS.includes(id))).toEqual([]);
  });
});

describe("loadBundledCatalogIds (real environment)", () => {
  test("loads the packaged OpenClaw catalog as a list of modern claude ids", async () => {
    const result = await loadBundledCatalogIds();
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    for (const id of result ?? []) {
      expect(id).toMatch(/^claude-/);
    }
  });

  // Opt-in contract run against another installed OpenClaw, e.g.
  // MULTI_CLAWD_TEST_OPENCLAW_DIST=/path/to/node_modules/openclaw/dist.
  // Read-only: the manifest is parsed and the legacy module, if present, is
  // imported; the Claude CLI is never spawned.
  const externalDist = process.env.MULTI_CLAWD_TEST_OPENCLAW_DIST;
  test.skipIf(!externalDist)(
    "mirrors the catalog of the OpenClaw dist named by MULTI_CLAWD_TEST_OPENCLAW_DIST",
    async () => {
      const catalog = await loadBundledCatalog({ distRoot: externalDist! });
      expect(catalog).not.toBeNull();
      expect(catalog!.ids.length).toBeGreaterThan(0);
      expect(catalog!.ids.every(isModernClaudeModelId)).toBe(true);
      const base = await resolveBaseModelIds(() => loadBundledCatalogIds({ distRoot: externalDist! }));
      expect(base).toEqual(catalog!.ids);
    },
  );
});
