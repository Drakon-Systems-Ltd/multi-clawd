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
  direct?: unknown;
}

export interface ExplainPool {
  id: string;
  accounts: string[];
  utilizationThreshold?: number;
  minDwellMs?: number;
  degrade?: { ladder?: string[]; pins?: unknown[] };
}

export interface ExplainUsage {
  window: string;
  utilization: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface ExplainModel {
  accounts: ExplainAccount[];
  pool?: ExplainPool;
  chain?: { primary?: string; fallbacks?: string[] };
  health: Array<{ id: string; verdict: string; detail?: string; usage?: ExplainUsage[] }>;
  stickyAccount?: string;
  /** Clock for usage reset countdowns; defaults to Date.now() at render time. */
  nowMs?: number;
  /** The direct `anthropic/*` route; absent when no account opted in. */
  direct?: ExplainDirect;
}

/**
 * What the gateway's direct Anthropic route looks like from the pool's side.
 * Every field is observed (auth store, stored order, cooldown state) except
 * `members`, which is the plugin config's intent.
 */
export interface ExplainDirect {
  members: Array<{
    accountId: string;
    profileId: string;
    /** Where the setup-token comes from, in words — never the value. */
    source: string;
    /** Whether OpenClaw's store holds the profile; undefined = not checked. */
    stored?: boolean;
    /** Epoch ms the profile is cooling down until, when it is. */
    cooldownUntil?: number;
    cooldownReason?: string;
  }>;
  problems: Array<{ accountId: string; reason: string }>;
  /** Effective `anthropic` order, where it came from; undefined = not read. */
  order?: string[];
  orderSource?: string;
}

/** Human name for a shim window key. Unknown keys pass through as-is. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_overage_included: "weekly incl. overage",
};

/** "~42m" / "~7h" / "~3d" until an epoch-ms timestamp. */
export function relativeUntil(ms: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((ms - nowMs) / 60000));
  if (mins < 90) return `~${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}

/** One usage line: "weekly 12% (resets ~3d) · 5-hour 4% (resets ~2h)". */
export function renderUsageLine(usage: ExplainUsage[], nowMs: number): string {
  return usage
    .map((u) => {
      const label = WINDOW_LABELS[u.window] ?? u.window;
      const pct = `${Math.round(u.utilization * 100)}%`;
      const reset = u.resetsAt !== undefined ? ` (resets ${relativeUntil(u.resetsAt, nowMs)})` : "";
      return `${label} ${pct}${reset}`;
    })
    .join(" · ");
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
export function annotateChainRef(
  ref: string,
  pool: ExplainPool | undefined,
  direct?: ExplainDirect,
): string {
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
  if (provider === "anthropic" && direct && direct.members.length > 0) {
    const order = direct.members.map((m) => m.accountId).join(", then ");
    return `direct to Anthropic — pooled by auth-profile order (${order}), health-sorted by the plugin`;
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
  // Distinct from EXHAUSTED on purpose: exhausted is "wait for the window",
  // credential_failed is "go and log this account back in". Same-looking
  // wording would send the operator to the wrong fix.
  credential_failed: "LOGIN REJECTED — excluded from the pool until it is re-authenticated",
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

  if (model.direct) {
    lines.push(...renderDirectSection(model.direct, model.nowMs ?? Date.now()));
    lines.push("");
  }

  if (model.chain?.primary || model.chain?.fallbacks?.length) {
    lines.push("FAILOVER CHAIN  (agents.defaults)");
    const rungs = [model.chain.primary, ...(model.chain.fallbacks ?? [])].filter(
      (r): r is string => typeof r === "string",
    );
    rungs.forEach((ref, i) => {
      lines.push(`  ${i + 1}. ${ref}`);
      lines.push(`       ${annotateChainRef(ref, model.pool, model.direct)}`);
    });
  } else {
    lines.push("FAILOVER CHAIN  (none found under agents.defaults)");
  }
  lines.push("");

  if (model.health.length > 0) {
    const nowMs = model.nowMs ?? Date.now();
    lines.push("RIGHT NOW");
    for (const h of model.health) {
      const word = VERDICT_WORDS[h.verdict] ?? h.verdict;
      lines.push(`  ${h.id}: ${word}${h.detail ? ` — ${h.detail}` : ""}`);
      lines.push(
        `      usage: ${h.usage?.length ? renderUsageLine(h.usage, nowMs) : "no live telemetry"}`,
      );
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

/**
 * The DIRECT ROUTE block: which OpenClaw profile serves `anthropic/*` for
 * each account, whether it is actually stored, whether it is cooling down,
 * and the order OpenClaw will try them in right now.
 */
export function renderDirectSection(direct: ExplainDirect, nowMs: number): string[] {
  const lines: string[] = [];
  lines.push("DIRECT ROUTE  anthropic/*  (gateway → Anthropic API with each account's setup-token)");
  if (direct.members.length === 0) {
    lines.push("  no account has a usable direct credential yet");
  }
  for (const m of direct.members) {
    const bits = [m.source];
    if (m.stored === true) bits.push("stored in OpenClaw");
    else if (m.stored === false) bits.push("NOT STORED — run `multi-clawd update` (or setup) to sync it");
    if (m.cooldownUntil !== undefined && m.cooldownUntil > nowMs) {
      bits.push(
        `COOLING DOWN${m.cooldownReason ? ` (${m.cooldownReason})` : ""} for ${relativeUntil(m.cooldownUntil, nowMs)}`,
      );
    }
    lines.push(`  ${m.accountId} → ${m.profileId}`);
    lines.push(`      ${bits.join(" · ")}`);
  }
  for (const p of direct.problems) {
    lines.push(`  ${p.accountId}: NOT on the direct route — ${p.reason}`);
  }
  if (direct.order) {
    const managed = new Set(direct.members.map((m) => m.profileId));
    const rendered = direct.order.map((id) => (managed.has(id) ? id : `${id} (not managed)`));
    lines.push(
      `  order${direct.orderSource ? ` (${direct.orderSource})` : ""}: ${
        rendered.length > 0 ? rendered.join(" → ") : "none set — OpenClaw's round-robin decides"
      }`,
    );
  }
  lines.push("  The plugin keeps this order in pool-health order, so a nearly-maxed account");
  lines.push("  drops back BEFORE it errors; OpenClaw's own rotation covers the rest in-turn.");
  return lines;
}
