/**
 * Model-id logic for multi-clawd, deliberately permissive about model ids it
 * has never seen: the failover pool must keep working when Anthropic replaces
 * the flagship subscription model (e.g. Fable 5 → Opus 5) without a plugin
 * release. Mirrors the spirit of OpenClaw core's Anthropic forward-compat
 * resolver: any modern lowercase `claude-*` id is accepted; known ids get
 * their real specs, unknown ones get conservative defaults.
 */

export interface AccountModelsConfig {
  id: string;
  label?: string;
  /** Extra model ids to expose for this account (beyond the mirrored base list). */
  models?: string[];
}

export interface ModelSpec {
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Max image side accepted, mirroring the bundled catalog's mediaInput. */
  imageMaxSidePx: number;
}

export interface CatalogEntry {
  id: string;
  name: string;
  provider: string;
  reasoning: true;
  input: ["text", "image"];
  contextWindow: number;
  mediaInput: {
    image: { maxSidePx: number; preferredSidePx: number; tokenMode: "provider" };
  };
}

/** Aliases the claude CLI itself accepts; short forms pass through unchanged. */
export const MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  sonnet: "sonnet",
  "sonnet-4.6": "claude-sonnet-4-6",
  haiku: "haiku",
};

/** Known specs — used when available; unknown modern ids fall back to defaults. */
const KNOWN_SPECS: Record<string, Omit<ModelSpec, "imageMaxSidePx">> = {
  "claude-opus-4-8": { name: "Claude Opus 4.8", contextWindow: 1048576, maxTokens: 128000 },
  "claude-opus-4-7": { name: "Claude Opus 4.7", contextWindow: 1048576, maxTokens: 64000 },
  "claude-opus-4-6": { name: "Claude Opus 4.6", contextWindow: 1048576, maxTokens: 64000 },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", contextWindow: 1048576, maxTokens: 64000 },
  "claude-sonnet-5": { name: "Claude Sonnet 5", contextWindow: 200000, maxTokens: 64000 },
  "claude-fable-5": { name: "Claude Fable 5", contextWindow: 1000000, maxTokens: 128000 },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 64000 },
};

/** Base ids exposed when the bundled catalog cannot be mirrored at runtime. */
export const FALLBACK_MODEL_IDS: readonly string[] = Object.keys(KNOWN_SPECS);

const MODERN_CLAUDE_ID_RE = /^claude(-[a-z0-9]+(\.[a-z0-9]+)*)+$/;

export function isModernClaudeModelId(id: string): boolean {
  return MODERN_CLAUDE_ID_RE.test(id);
}

const CLI_SHORT_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/**
 * Canonicalize a requested model id. Aliases map to canonical ids; short CLI
 * aliases pass through (the claude binary resolves them); any modern
 * `claude-*` id passes through even if unknown. Everything else is rejected.
 */
export function canonicalModelId(modelId: string): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  const aliased = MODEL_ALIASES[trimmed] ?? trimmed;
  if (CLI_SHORT_ALIASES.has(aliased)) return aliased;
  return isModernClaudeModelId(aliased) ? aliased : undefined;
}

/** Derive "Claude Opus 5 20270301" from "claude-opus-5-20270301". */
function deriveName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
    .replace(/^Claude (\w+) (\d+) (\d)$/, "Claude $1 $2.$3");
}

export function resolveModelSpec(id: string): ModelSpec {
  const known = KNOWN_SPECS[id];
  const imageMaxSidePx = id === "claude-opus-4-8" || id === "claude-opus-4-7" ? 2576 : 1568;
  if (known) return { ...known, imageMaxSidePx };
  return { name: deriveName(id), contextWindow: 200000, maxTokens: 64000, imageMaxSidePx };
}

/**
 * Catalog rows for one account: the mirrored base list plus any account-config
 * extras (junk ids filtered), deduped, labelled with the account.
 */
export function buildCatalogEntries(
  account: AccountModelsConfig,
  baseIds: readonly string[],
): CatalogEntry[] {
  const label = account.label ?? account.id;
  const ids = [...new Set([...baseIds, ...(account.models ?? [])])].filter(
    isModernClaudeModelId,
  );
  return ids.map((id) => {
    const spec = resolveModelSpec(id);
    return {
      id,
      name: `${spec.name} (${label})`,
      provider: account.id,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: spec.contextWindow,
      mediaInput: {
        image: {
          maxSidePx: spec.imageMaxSidePx,
          preferredSidePx: spec.imageMaxSidePx,
          tokenMode: "provider",
        },
      },
    };
  });
}
