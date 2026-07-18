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
 * SCOPE (case 1): the CONFIG-LEVEL check only — every Claude ref written into
 * openclaw.json. CASE 2 (`auditSessionOverrides`, below) closes the adjacent
 * gap: a persisted per-session `/model` override lives in session state, not
 * openclaw.json, yet bypasses the pool exactly like a config pin. Both share
 * ONE off-pool predicate (`offPoolClaudeRef`) so the two cases can never drift.
 * (A truly live per-turn `ctx.activeModel` assertion — env / per-launch
 * `--model` on a running request — remains out of scope for both.)
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
 * THE off-pool predicate — the single source of truth shared by case 1
 * (`auditEffectiveChain`, config refs) and case 2 (`auditSessionOverrides`,
 * session `/model` pins). Classifies one `provider/model` reference against the
 * pool provider id:
 *   - `<poolId>/…`            → null  (correct pool routing)
 *   - `anthropic/…`, `claude-cli/…` → "strong" (off-pool Claude, no failover)
 *   - `claw<N>/…`             → "warn" (single pool account, no cross-account failover)
 *   - non-Claude / bare id / unrelated provider → null
 * Returns null whenever the ref is fine or routing is ambiguous. Reason strings
 * are built by the callers from this severity + the parsed provider, so the two
 * cases can never disagree on WHAT bypasses the pool.
 */
export function offPoolClaudeRef(ref: string, poolId: string): "strong" | "warn" | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const { provider, modelId } = parseRef(ref);
  if (!isClaudeModelId(modelId)) return null; // not a Claude tier → nothing to fail over
  if (provider === undefined) return null; // bare id: routing is ambiguous, don't cry wolf
  if (provider === poolId) return null; // correct pool routing
  if (provider === "anthropic" || provider === "claude-cli") return "strong";
  if (ACCOUNT_PIN_RE.test(provider)) return "warn";
  // Some other provider prefix on a Claude id (e.g. a custom gateway): out of
  // scope for this check — do not warn.
  return null;
}

/**
 * Classify one config reference against the pool id. Returns a reason string
 * when the ref is a Claude model that BYPASSES the pool, or null when it is fine
 * (pool-routed, non-Claude, a bare/ambiguous id, or an unrelated provider).
 * Delegates the WHAT to `offPoolClaudeRef`; owns only the reason wording.
 */
function classifyBypass(ref: string, poolId: string): string | null {
  const severity = offPoolClaudeRef(ref, poolId);
  if (!severity) return null;
  const { provider } = parseRef(ref);
  if (provider === "anthropic") {
    return `routes direct to the Anthropic API/native, bypassing the ${poolId} pool — no cross-account failover`;
  }
  if (provider === "claude-cli") {
    return `routes direct to the claude CLI, bypassing the ${poolId} pool — no cross-account failover`;
  }
  // severity === "warn": a single pool-account pin (claw<N>).
  return `pins a single pool account; cross-account failover won't fire — use ${poolId}/ for the pool`;
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

// ── CASE 2 — session-override audit ──────────────────────────────────────────

/**
 * The provider prefix that routes through the clawd pool. Case 2 only receives
 * a `poolConfigured` boolean (a session store carries no pool id), so the pool
 * provider name is fixed here — it is `clawd` by construction across every
 * multi-clawd deployment. `offPoolClaudeRef` still does the comparison, so this
 * stays the ONE predicate shared with case 1.
 */
const POOL_PROVIDER = "clawd";

/**
 * One entry in `~/.openclaw/agents/<agent>/sessions/sessions.json`, keyed by
 * session_key. Only the fields that determine pool routing are typed; real
 * entries carry more (auth-profile overrides, compaction counts, …).
 */
export interface SessionOverrideEntry {
  /** Bare provider of a manual `/model` pin, e.g. "anthropic" / "claw2" / "clawd". */
  providerOverride?: string;
  /** Provider of the resolved model — present on auto-fallback entries lacking `providerOverride`. */
  modelProvider?: string;
  /** Bare model id, no provider prefix, e.g. "claude-opus-4-8". */
  modelOverride?: string;
  /** "auto" = auto-fallback; "user" = the known manual /model pin; absent = config-level/cron/probe. */
  modelOverrideSource?: string;
  [key: string]: unknown;
}

/**
 * Audit persisted per-session `/model` overrides for pool bypass. A manual pin
 * to a non-pool provider lives in session state, not openclaw.json, yet defeats
 * cross-account failover exactly like a config pin — invisible to case 1.
 *
 * @param sessions the parsed `sessions.json` object (keyed by session_key)
 * @param poolConfigured whether a clawd pool exists (no pool ⇒ nothing to bypass ⇒ [])
 * @returns all-`warn` findings (informational; never flips doctor's exit code).
 */
export function auditSessionOverrides(
  sessions: Record<string, SessionOverrideEntry> | null | undefined,
  poolConfigured: boolean,
): ChainFinding[] {
  if (!poolConfigured) return []; // no pool ⇒ nothing to bypass ⇒ skip
  const findings: ChainFinding[] = [];
  for (const [sessionKey, entry] of Object.entries(sessions ?? {})) {
    if (!entry || typeof entry !== "object") continue;

    // 1. SOURCE GATE (first, mandatory). Consider ONLY deliberate overrides.
    //    "user" is the known manual /model literal, but we test `!== "auto"`
    //    (not `=== "user"`) so any future deliberate source — "api"/"operator"/…
    //    — is still caught; auto-fallback is the ONLY thing to exclude. Absent
    //    source = a config-level/cron/probe entry, never a session pin.
    const source = entry.modelOverrideSource;
    if (typeof source !== "string" || source === "auto") continue;

    // 2. PROVIDER. `providerOverride` is the manual pin; fall back to the
    //    resolved `modelProvider`. Passing the source gate with no provider at
    //    all is SCHEMA DRIFT — surface it rather than silently skip (a
    //    false-negative in a safety doctor is worse than a false-positive).
    const provider = entry.providerOverride ?? entry.modelProvider;
    if (!provider) {
      findings.push({
        surface: `session ${sessionKey}`,
        ref: entry.modelOverride ?? "(no model)",
        severity: "warn",
        reason: `session override present (source=${source}) but provider field missing — schema drift, cannot verify pool routing`,
      });
      continue;
    }

    // 3. OFF-POOL CLASSIFY via the shared case-1 predicate.
    const ref = `${provider}/${entry.modelOverride ?? ""}`;
    const severity = offPoolClaudeRef(ref, POOL_PROVIDER);
    if (!severity) continue; // clawd/ (in-pool) or non-Claude → fine

    // 4. Emit — all `warn` for doctor (informational; never flips READY).
    const reason =
      severity === "strong"
        ? `off-pool /model pin — routes direct to ${provider}, bypassing the ${POOL_PROVIDER} pool; no cross-account failover`
        : `/model pin to a single pool account (${provider}); cross-account failover won't fire — use ${POOL_PROVIDER}/ for the pool`;
    findings.push({ surface: `session ${sessionKey}`, ref, severity: "warn", reason });
  }
  return findings;
}
