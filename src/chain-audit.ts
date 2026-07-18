/**
 * Effective-chain audit (case 1 of the pool-bypass sweep) — a PURE, at-rest
 * scan of a parsed openclaw.json. multi-clawd exists so that Claude tiers route
 * through the `clawd/` pool, where cross-account failover fires when one account
 * hits its rate limit. If a model chain instead routes Claude via a NON-pool
 * provider (`anthropic/…`, `claude-cli/…`, or a single `claw<N>/…` account),
 * that failover silently never fires — and until now `doctor` still said READY
 * (the 17–18 Jul incident: clawdbot1 pinned `anthropic/claude-fable-5`).
 *
 * This module classifies every Claude model reference under `agents` (plus any
 * cron/scheduled sections) as pool-routed or bypassing. It is deliberately
 * side-effect free and deterministic so it can be unit-tested against fixtures;
 * `scripts/doctor.mjs` imports it and renders the findings.
 *
 * SCOPE: this is the CONFIG-LEVEL check only. It cannot see runtime overrides
 * (env, per-launch `--model`, dynamic selection). Closing that gap is CASE 2 —
 * a live per-session `ctx.activeModel` assertion — which a separate change adds;
 * see the seam in doctor.mjs.
 */
import { isModernClaudeModelId } from "./models.js";

export type ChainSeverity = "warn" | "note";

export interface ChainFinding {
  /** Dotted path to the offending field, e.g. `agents.defaults.model.fallbacks[1]`. */
  surface: string;
  /** The raw model reference, e.g. `anthropic/claude-fable-5`. */
  ref: string;
  /** `warn` = a live tier bypasses the pool; `note` = a registered-but-unused allowlist rung. */
  severity: ChainSeverity;
  /** Human-readable explanation of why this reference bypasses the pool. */
  reason: string;
}

/** Short CLI aliases the claude binary resolves to Claude models. */
const CLAUDE_SHORT_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** A pool-member account prefix like `claw2`, `claw3` — but NOT `clawd` (the pool). */
const ACCOUNT_PIN_RE = /^claw\d+$/;

/**
 * Is this model id (already stripped of any provider prefix) a Claude model?
 * Permissive by design, mirroring models.ts: any modern `claude-*` id counts,
 * as do the short CLI aliases and their versioned forms.
 */
export function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  if (CLAUDE_SHORT_ALIASES.has(id)) return true;
  if (/^(opus|sonnet|haiku)-/.test(id)) return true;
  return isModernClaudeModelId(id);
}

/** Split `provider/model-id` into its parts; a bare id has no provider. */
function parseRef(ref: string): { provider?: string; modelId: string } {
  const idx = ref.indexOf("/");
  if (idx < 0) return { modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/**
 * Classify one reference against the pool id. Returns a reason string when the
 * ref is a Claude model that BYPASSES the pool, or null when it is fine
 * (pool-routed, non-Claude, a bare/ambiguous id, or an unrelated provider).
 */
function classifyBypass(ref: string, poolId: string): string | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const { provider, modelId } = parseRef(ref);
  if (!isClaudeModelId(modelId)) return null; // not a Claude tier → nothing to fail over
  if (provider === undefined) return null; // bare id: routing is ambiguous, don't cry wolf
  if (provider === poolId) return null; // correct pool routing

  if (provider === "anthropic") {
    return `routes direct to the Anthropic API/native, bypassing the ${poolId} pool — no cross-account failover`;
  }
  if (provider === "claude-cli") {
    return `routes direct to the claude CLI, bypassing the ${poolId} pool — no cross-account failover`;
  }
  if (ACCOUNT_PIN_RE.test(provider)) {
    return `pins a single pool account; cross-account failover won't fire — use ${poolId}/ for the pool`;
  }
  // Some other provider prefix on a Claude id (e.g. a custom gateway): out of
  // scope for this check — do not warn.
  return null;
}

interface CollectedRef {
  surface: string;
  ref: string;
  /** True for `agents.defaults.models` allowlist keys: report at note level only. */
  allowlist: boolean;
}

/**
 * Pull model references out of a "model field" value, which may be either a
 * bare string ref or a `{ primary, fallbacks[] }` object.
 */
function extractModelRefs(surface: string, value: unknown): Array<{ surface: string; ref: string }> {
  if (typeof value === "string") return [{ surface, ref: value }];
  if (value && typeof value === "object") {
    const out: Array<{ surface: string; ref: string }> = [];
    const v = value as { primary?: unknown; fallbacks?: unknown };
    if (typeof v.primary === "string") out.push({ surface: `${surface}.primary`, ref: v.primary });
    if (Array.isArray(v.fallbacks)) {
      v.fallbacks.forEach((f, i) => {
        if (typeof f === "string") out.push({ surface: `${surface}.fallbacks[${i}]`, ref: f });
      });
    }
    return out;
  }
  return [];
}

/** Walk cron/scheduled containers (unknown shape) and surface any `model` fields. */
function collectCronRefs(surface: string, node: unknown, depth: number, out: CollectedRef[]): void {
  if (!node || depth > 4) return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectCronRefs(`${surface}[${i}]`, item, depth + 1, out));
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if ("model" in obj) {
    for (const r of extractModelRefs(`${surface}.model`, obj.model)) {
      out.push({ ...r, allowlist: false });
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "model") continue;
    if (v && typeof v === "object") collectCronRefs(`${surface}.${k}`, v, depth + 1, out);
  }
}

/** Reserved keys under `agents` that are not per-agent override objects. */
const RESERVED_AGENT_KEYS = new Set(["defaults", "list", "models"]);

/**
 * Collect every model reference under `agents` (plus cron/scheduled sections)
 * as flat {surface, ref, allowlist} records — no classification yet.
 */
function collectChainRefs(config: unknown): CollectedRef[] {
  const out: CollectedRef[] = [];
  const push = (surface: string, value: unknown) => {
    for (const r of extractModelRefs(surface, value)) out.push({ ...r, allowlist: false });
  };

  const cfg = (config ?? {}) as Record<string, unknown>;
  const agents = (cfg.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;

  // agents.defaults.model.{primary,fallbacks[]}
  push("agents.defaults.model", defaults.model);

  // agents.defaults.subagents.model  and  agents.defaults.subagents.*.model
  const subagents = (defaults.subagents ?? {}) as Record<string, unknown>;
  if (subagents.model !== undefined) push("agents.defaults.subagents.model", subagents.model);
  for (const [k, v] of Object.entries(subagents)) {
    if (k === "model") continue;
    if (v && typeof v === "object" && "model" in (v as Record<string, unknown>)) {
      push(`agents.defaults.subagents.${k}.model`, (v as Record<string, unknown>).model);
    }
  }

  // per-agent overrides — object-keyed form: agents.<name>.model / .cron
  for (const [name, v] of Object.entries(agents)) {
    if (RESERVED_AGENT_KEYS.has(name)) continue;
    if (!v || typeof v !== "object") continue;
    const agent = v as Record<string, unknown>;
    if ("model" in agent) push(`agents.${name}.model`, agent.model);
    if ("cron" in agent) collectCronRefs(`agents.${name}.cron`, agent.cron, 0, out);
  }

  // per-agent overrides — array form: agents.list[].model / .cron
  if (Array.isArray(agents.list)) {
    agents.list.forEach((a, i) => {
      if (!a || typeof a !== "object") return;
      const agent = a as Record<string, unknown>;
      const label = typeof agent.id === "string" ? agent.id : String(i);
      if ("model" in agent) push(`agents.list[${label}].model`, agent.model);
      if ("cron" in agent) collectCronRefs(`agents.list[${label}].cron`, agent.cron, 0, out);
    });
  }

  // cron / scheduled-job sections (scanned defensively; absence is normal)
  for (const section of ["crons", "schedules", "jobs", "scheduled"]) {
    if (cfg[section] !== undefined) collectCronRefs(section, cfg[section], 0, out);
  }

  // agents.defaults.models allowlist keys — note level only (registered ≠ live)
  const allowlist = defaults.models;
  if (allowlist && typeof allowlist === "object") {
    for (const key of Object.keys(allowlist)) {
      out.push({ surface: `agents.defaults.models["${key}"]`, ref: key, allowlist: true });
    }
  }

  return out;
}

/**
 * Audit every Claude model reference in a parsed openclaw.json against the pool.
 *
 * @param config parsed openclaw.json (the whole object; `agents` lives at top level)
 * @param poolId the clawd pool's id (the provider prefix that routes through the pool)
 * @returns findings for references that bypass the pool. `warn` findings are live
 *          tiers; `note` findings are registered-but-unused allowlist rungs. Returns
 *          an empty array when no pool id is given (nothing to bypass → skip).
 */
export function auditEffectiveChain(config: unknown, poolId: string | undefined | null): ChainFinding[] {
  if (!poolId) return [];
  const findings: ChainFinding[] = [];
  for (const { surface, ref, allowlist } of collectChainRefs(config)) {
    const reason = classifyBypass(ref, poolId);
    if (!reason) continue;
    findings.push({ surface, ref, severity: allowlist ? "note" : "warn", reason });
  }
  return findings;
}
