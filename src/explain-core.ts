/**
 * Pure rendering for `multi-clawd explain` — the whole configuration in plain
 * English: what each account IS, how the pool decides, what every fallback
 * rung actually means, and what's happening right now. No IO here; the CLI
 * gathers config + health state and this module turns it into prose.
 *
 * Secret references are never printed — only the provider name.
 */

export interface ExplainAccount {
  id: string;
  label?: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: { provider?: string; [k: string]: unknown };
}

export interface ExplainPool {
  id: string;
  accounts: string[];
  utilizationThreshold?: number;
  minDwellMs?: number;
  degrade?: { ladder?: string[]; pins?: unknown[] };
}

export interface ExplainModel {
  accounts: ExplainAccount[];
  pool?: ExplainPool;
  chain?: { primary?: string; fallbacks?: string[] };
  health: Array<{ id: string; verdict: string; detail?: string }>;
  stickyAccount?: string;
}

/** One-line plain-English description of where an account's login lives. */
export function describeAccount(acc: ExplainAccount): string {
  if (acc.native) {
    return "the machine's main `claude` login (default config dir; OS keychain on macOS)";
  }
  const parts: string[] = [];
  if (acc.configDir) parts.push(`its own isolated login dir: ${acc.configDir}`);
  if (acc.oauthTokenRef) {
    parts.push(
      `token resolved from ${acc.oauthTokenRef.provider ?? "a secret provider"} via a secret reference (never stored in plain text)`,
    );
  } else if (acc.oauthTokenFile) {
    parts.push(`token file at ${acc.oauthTokenFile}`);
  } else if (acc.configDir) {
    parts.push(`uses the login stored inside that dir`);
  }
  return parts.join("; ") || "no credential source configured";
}

/** Annotate one chain rung with what it MEANS. */
export function annotateChainRef(ref: string, pool: ExplainPool | undefined): string {
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash) : undefined;
  if (pool && provider === pool.id) {
    const order = pool.accounts.join(", then ");
    return `pool → ${order} (same model, next account before any tier drop)`;
  }
  if (!pool && provider && /^claw/.test(provider)) {
    return `no pool configured — runs on the single account "${provider}"`;
  }
  if (provider && /^claw\d+$/.test(provider)) {
    return `pinned to only ${provider} — no cross-account failover on this rung`;
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "direct to Anthropic — bypasses the pool (no cross-account failover)";
  }
  if (provider && provider.startsWith("claw")) {
    return `runs on "${provider}"`;
  }
  return "leaves Claude — a different provider entirely";
}

const VERDICT_WORDS: Record<string, string> = {
  ok: "OK — ready to serve",
  no_data: "no recent telemetry — treated as healthy",
  near_limit: "NEAR ITS LIMIT — the pool will hand over before it hard-fails",
  exhausted: "EXHAUSTED",
};

export function renderExplanation(model: ExplainModel): string {
  const lines: string[] = [];
  lines.push("ACCOUNTS");
  for (const acc of model.accounts) {
    lines.push(`  ${acc.id}${acc.label ? `  "${acc.label}"` : ""}`);
    lines.push(`    → ${describeAccount(acc)}`);
  }
  lines.push("");

  if (model.pool) {
    const pct = Math.round((model.pool.utilizationThreshold ?? 0.85) * 100);
    lines.push(`POOL  ${model.pool.id}  (${model.pool.accounts.join(" → ")})`);
    lines.push(
      `  Every Claude launch runs on the first account that is NOT nearly maxed`,
    );
    lines.push(
      `  out — hand-over at ${pct}% of any rate window, home account reclaims`,
    );
    lines.push(`  automatically once its window resets.`);
    const ladder = model.pool.degrade?.ladder ?? [];
    if (ladder.length > 0) {
      lines.push(`  If the WHOLE pool is exhausted: step down to ${ladder.join(" → ")} first.`);
    }
    if ((model.pool.degrade?.pins?.length ?? 0) > 0) {
      lines.push(`  ${model.pool.degrade?.pins?.length} pinned lane(s) never tier-drop.`);
    }
  } else {
    lines.push("POOL  (no pool configured — each account is a standalone backend)");
  }
  lines.push("");

  if (model.chain?.primary || model.chain?.fallbacks?.length) {
    lines.push("FAILOVER CHAIN  (agents.defaults)");
    const rungs = [model.chain.primary, ...(model.chain.fallbacks ?? [])].filter(
      (r): r is string => typeof r === "string",
    );
    rungs.forEach((ref, i) => {
      lines.push(`  ${i + 1}. ${ref}`);
      lines.push(`       ${annotateChainRef(ref, model.pool)}`);
    });
  } else {
    lines.push("FAILOVER CHAIN  (none found under agents.defaults)");
  }
  lines.push("");

  if (model.health.length > 0) {
    lines.push("RIGHT NOW");
    for (const h of model.health) {
      const word = VERDICT_WORDS[h.verdict] ?? h.verdict;
      lines.push(`  ${h.id}: ${word}${h.detail ? ` — ${h.detail}` : ""}`);
    }
    if (model.pool) {
      lines.push(
        model.stickyAccount
          ? `  pool is rotated onto ${model.stickyAccount} (returns home when the home window resets)`
          : `  pool is on its home account (no rotation active)`,
      );
    }
  }
  return lines.join("\n");
}
