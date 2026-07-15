/**
 * Best-effort mirror of the bundled claude-cli model catalog, so a new
 * subscription model shipped by OpenClaw (a future Opus 5) appears on our
 * backends automatically. The bundled builder lives at a semi-internal path
 * (dist/extensions/anthropic/cli-catalog.js) that the openclaw exports map
 * does not expose, so we resolve it by file path from the plugin-sdk's
 * resolved location — and fall back to our built-in list whenever any part
 * of that fails. The fallback is always safe: unknown modern claude-* ids
 * still resolve through our permissive resolveDynamicModel.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { FALLBACK_MODEL_IDS, isModernClaudeModelId } from "./models.js";

export type BundledCatalogLoader = () => Promise<string[] | null>;

/** Mirror the bundled catalog's model ids; null when unavailable. Never throws. */
export async function loadBundledCatalogIds(): Promise<string[] | null> {
  try {
    const require = createRequire(import.meta.url);
    // Resolve a path we know exists (the SDK entry we already import), then
    // walk to the bundled anthropic extension relative to the dist root.
    const sdkPath = require.resolve("openclaw/plugin-sdk/plugin-entry");
    const distRoot = sdkPath.slice(0, sdkPath.lastIndexOf("/dist/") + "/dist".length);
    const catalogPath = join(
      dirname(distRoot),
      "dist",
      "extensions",
      "anthropic",
      "cli-catalog.js",
    );
    const mod = (await import(pathToFileURL(catalogPath).href)) as {
      buildClaudeCliCatalogEntries?: () => Array<{ id?: unknown }>;
    };
    const entries = mod.buildClaudeCliCatalogEntries?.();
    if (!Array.isArray(entries)) return null;
    const ids = entries
      .map((e) => (typeof e?.id === "string" ? e.id : ""))
      .filter((id) => id.length > 0);
    return ids.length > 0 ? ids : null;
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
