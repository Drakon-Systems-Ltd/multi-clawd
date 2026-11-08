/**
 * Best-effort mirror of the bundled Claude model catalog, so a new
 * subscription model shipped by OpenClaw appears on our backends
 * automatically. Two public artifacts of the installed OpenClaw are tried:
 *
 * 1. The legacy catalog builder (`dist/extensions/anthropic/cli-catalog.js`,
 *    `buildClaudeCliCatalogEntries`), which OpenClaw <= 2026.8 shipped and
 *    2026.9 and later removed. Preferred where present because it is the CLI
 *    menu itself.
 * 2. The bundled Anthropic extension's plugin manifest
 *    (`dist/extensions/anthropic/openclaw.plugin.json`, `modelCatalog`).
 *    OpenClaw >= 2026.9 declares its Claude models there and discovers the
 *    CLI's own menu at runtime, so the manifest is the only static
 *    declaration left.
 *
 * Neither path is on the openclaw exports map, so both are resolved by file
 * path from the plugin-sdk's resolved location. Nothing here spawns the
 * Claude CLI or reads credentials: the manifest is JSON and the builder is a
 * pure function. Every failure falls back to our built-in list, which is
 * always safe: unknown modern claude-* ids still resolve through our
 * permissive resolveDynamicModel.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { FALLBACK_MODEL_IDS, isModernClaudeModelId } from "./models.js";

export type BundledCatalogLoader = () => Promise<string[] | null>;

/** Where the mirrored ids came from. */
export type BundledCatalogSource = "cli-catalog" | "manifest";

export interface BundledCatalog {
  ids: string[];
  source: BundledCatalogSource;
}

export interface BundledCatalogOptions {
  /**
   * The installed OpenClaw `dist/` directory. Defaults to the one the
   * plugin-sdk import resolves to; tests point it at a fixture tree.
   */
  distRoot?: string;
}

/** The installed OpenClaw `dist/` directory, or null when it cannot be found. */
export function resolveOpenClawDistRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // Resolve a path we know exists (the SDK entry we already import), then
    // walk up to the dist root that the bundled extensions live under.
    const sdkPath = require.resolve("openclaw/plugin-sdk/plugin-entry");
    const marker = sdkPath.lastIndexOf("/dist/");
    if (marker < 0) return null;
    return sdkPath.slice(0, marker + "/dist".length);
  } catch {
    return null;
  }
}

function anthropicExtensionDir(distRoot: string): string {
  return join(distRoot, "extensions", "anthropic");
}

function cleanIds(raw: unknown[]): string[] {
  const ids = raw
    .map((entry) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return typeof id === "string" ? id : "";
    })
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

/**
 * Model ids from the legacy bundled catalog builder (OpenClaw <= 2026.8).
 * Null when the module is absent or does not produce a list. Never throws.
 */
export async function loadCliCatalogModuleIds(distRoot: string): Promise<string[] | null> {
  try {
    const catalogPath = join(anthropicExtensionDir(distRoot), "cli-catalog.js");
    if (!existsSync(catalogPath)) return null;
    const mod = (await import(pathToFileURL(catalogPath).href)) as {
      buildClaudeCliCatalogEntries?: () => Array<{ id?: unknown }>;
    };
    const entries = mod.buildClaudeCliCatalogEntries?.();
    if (!Array.isArray(entries)) return null;
    const ids = cleanIds(entries);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

interface ManifestModelCatalog {
  modelCatalog?: {
    providers?: Record<string, { models?: Array<{ id?: unknown }> } | undefined>;
  };
}

/**
 * Model ids declared by the bundled Anthropic extension manifest. The
 * `claude-cli` provider's static list wins when it is non-empty (it is the
 * CLI menu); otherwise the `anthropic` provider's list, which is the only
 * static declaration once OpenClaw discovers the CLI menu at runtime. Null
 * when the manifest is absent, unreadable or declares nothing. Never throws.
 */
export function readManifestCatalogIds(distRoot: string): string[] | null {
  try {
    const manifestPath = join(anthropicExtensionDir(distRoot), "openclaw.plugin.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestModelCatalog;
    const providers = manifest?.modelCatalog?.providers;
    if (!providers || typeof providers !== "object") return null;
    for (const provider of ["claude-cli", "anthropic"]) {
      const models = providers[provider]?.models;
      if (!Array.isArray(models)) continue;
      const ids = cleanIds(models);
      if (ids.length > 0) return ids;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Mirror the bundled catalog: the legacy builder where it still ships, else
 * the manifest. Null when neither yields anything. Never throws.
 */
export async function loadBundledCatalog(
  options: BundledCatalogOptions = {},
): Promise<BundledCatalog | null> {
  const distRoot = options.distRoot ?? resolveOpenClawDistRoot();
  if (!distRoot) return null;
  const fromModule = await loadCliCatalogModuleIds(distRoot);
  if (fromModule) return { ids: fromModule, source: "cli-catalog" };
  const fromManifest = readManifestCatalogIds(distRoot);
  if (fromManifest) return { ids: fromManifest, source: "manifest" };
  return null;
}

/** Mirror the bundled catalog's model ids; null when unavailable. Never throws. */
export async function loadBundledCatalogIds(
  options: BundledCatalogOptions = {},
): Promise<string[] | null> {
  try {
    return (await loadBundledCatalog(options))?.ids ?? null;
  } catch {
    return null;
  }
}

/**
 * The base model-id list for our backends: the mirrored bundled catalog when
 * available and sane, otherwise the built-in fallback list.
 */
export async function resolveBaseModelIds(
  loader: BundledCatalogLoader = loadBundledCatalogIds,
): Promise<string[]> {
  let mirrored: string[] | null = null;
  try {
    mirrored = await loader();
  } catch {
    mirrored = null;
  }
  const clean = (mirrored ?? []).filter(isModernClaudeModelId);
  return clean.length > 0 ? clean : [...FALLBACK_MODEL_IDS];
}
