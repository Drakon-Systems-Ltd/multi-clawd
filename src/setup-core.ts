/**
 * Pure scaffolding logic for the interactive setup wizard (scripts/setup.mjs).
 *
 * The wizard's value is that a user never hand-merges JSON: given their
 * answers, these functions build the exact multi-clawd account/pool entries
 * and merge them into an existing openclaw.json non-destructively. Everything
 * here is pure and unit-tested; the .mjs shell owns prompts and file IO.
 *
 * The account model this scaffolds (the standard multi-account shape):
 * - main account = NATIVE: uses the machine's default Claude config dir
 *   (`~/.claude`, plus OS keychain on macOS) — no configDir, no token.
 * - each extra account = its own ISOLATED config dir (a separate Claude
 *   "app", e.g. `~/.claw2`), so logins can never clobber each other, plus a
 *   token source: a secret-manager ref (preferred), a token file, or the
 *   dir's own stored login.
 */
import { isSecretRefShape } from "./token-resolution.js";

export interface SetupAccount {
  id: string;
  label?: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TokenSource =
  | { kind: "ref"; ref: Record<string, unknown> }
  | { kind: "file"; path: string }
  | { kind: "dir-login" };

export interface SetupPlan {
  accounts: SetupAccount[];
  pool?: { id: string; accounts: string[] };
  /** Model refs to register under agents.defaults.models, e.g. "clawd/claude-fable-5". */
  modelRungs: string[];
}

const PLUGIN_ID = "multi-clawd";

function assertAccountId(id: string): string {
  const trimmed = id?.trim();
  if (!trimmed) throw new Error("account id must be non-empty");
  if (trimmed === "claude-cli") {
    throw new Error(`account id "${trimmed}" collides with the bundled backend id`);
  }
  return trimmed;
}

export function buildMainAccount(opts: { id: string; label?: string }): SetupAccount {
  return { id: assertAccountId(opts.id), label: opts.label, native: true };
}

export function buildSecondAccount(opts: {
  id: string;
  label?: string;
  configDir: string;
  tokenSource: TokenSource;
}): SetupAccount {
  const id = assertAccountId(opts.id);
  const dirError = validateSecondConfigDir(opts.configDir);
  if (dirError) throw new Error(dirError);
  const account: SetupAccount = { id, label: opts.label, configDir: opts.configDir };
  switch (opts.tokenSource.kind) {
    case "ref":
      if (!isSecretRefShape(opts.tokenSource.ref)) {
        throw new Error(
          'secret ref must be { "source": "...", "provider": "...", "id": "..." } — e.g. { "source": "exec", "provider": "onepassword", "id": "op://Vault/Item/field" }',
        );
      }
      account.oauthTokenRef = opts.tokenSource.ref;
      break;
    case "file":
      account.oauthTokenFile = opts.tokenSource.path;
      break;
    case "dir-login":
      break; // the isolated dir's own stored login is the credential
  }
  return account;
}

/**
 * The second account's config dir must be an isolated path — pointing it at
 * (or inside) the default `~/.claude` would silently share or clobber the
 * main login the wizard promises to keep separate.
 */
export function validateSecondConfigDir(dir: string): string | undefined {
  const d = (dir ?? "").trim().replace(/\/+$/, "");
  if (!d.startsWith("~/") && !d.startsWith("/")) {
    return `config dir must be an absolute path or start with ~/ (got "${dir}")`;
  }
  if (d === "~/.claude" || /\/\.claude$/.test(d)) {
    return "that's the DEFAULT Claude config dir — it belongs to your main (native) login; pick an isolated dir like ~/.claw2";
  }
  if (d.startsWith("~/.claude/") || d.includes("/.claude/")) {
    return "the second account's dir must not live inside ~/.claude — it must be fully isolated from the main login";
  }
  return undefined;
}

export function buildPool(
  accountIds: string[],
  opts?: { id?: string; label?: string },
): { id: string; accounts: string[]; label?: string } {
  const pool: { id: string; accounts: string[]; label?: string } = {
    id: opts?.id?.trim() || "clawd",
    accounts: accountIds,
  };
  if (opts?.label) pool.label = opts.label;
  return pool;
}

export interface ExistingState {
  hasPluginEntry: boolean;
  accountIds: string[];
  hasPool: boolean;
  hasAllowList: boolean;
  allowListed: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Tolerantly read what a config already has so the wizard can skip steps. */
export function planFromExisting(config: unknown): ExistingState {
  const cfg = asRecord(config) ?? {};
  const plugins = asRecord(cfg.plugins);
  const allow = Array.isArray(plugins?.allow) ? (plugins?.allow as unknown[]) : undefined;
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.[PLUGIN_ID]);
  const entryConfig = asRecord(entry?.config);
  const accounts = Array.isArray(entryConfig?.accounts)
    ? (entryConfig?.accounts as unknown[])
    : [];
  return {
    hasPluginEntry: entry !== undefined,
    accountIds: accounts
      .map((a) => asRecord(a)?.id)
      .filter((id): id is string => typeof id === "string"),
    hasPool: asRecord(entryConfig?.pool) !== undefined,
    hasAllowList: allow !== undefined,
    allowListed: allow?.includes(PLUGIN_ID) ?? false,
  };
}

/**
 * Merge the wizard's plan into an existing openclaw.json object.
 * Non-destructive by construction: unknown keys are preserved, accounts merge
 * by id (existing extra fields kept), an existing pool is never overwritten,
 * and re-running the same plan is a no-op (empty change list).
 */
export function mergeSetupIntoConfig(
  existing: unknown,
  plan: SetupPlan,
): { config: unknown; changes: string[] } {
  const config = JSON.parse(JSON.stringify(asRecord(existing) ?? {})) as Record<string, unknown>;
  const changes: string[] = [];

  const plugins = (config.plugins = asRecord(config.plugins) ?? {});
  const entries = (plugins.entries = asRecord(plugins.entries) ?? {});
  const entry = (entries[PLUGIN_ID] = asRecord(entries[PLUGIN_ID]) ?? {});
  if (entry.enabled !== true) {
    entry.enabled = true;
    changes.push(`enable plugins.entries["${PLUGIN_ID}"]`);
  }
  const entryConfig = (entry.config = asRecord(entry.config) ?? {});
  const accounts = (entryConfig.accounts = Array.isArray(entryConfig.accounts)
    ? (entryConfig.accounts as unknown[])
    : []);

  for (const planned of plan.accounts) {
    const existingIdx = accounts.findIndex((a) => asRecord(a)?.id === planned.id);
    // Drop undefined optional fields so merges stay clean JSON.
    const plannedClean = Object.fromEntries(
      Object.entries(planned).filter(([, v]) => v !== undefined),
    );
    if (existingIdx === -1) {
      accounts.push(plannedClean);
      changes.push(`add account "${planned.id}"`);
    } else {
      const current = asRecord(accounts[existingIdx]) ?? {};
      const merged = { ...current, ...plannedClean };
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        accounts[existingIdx] = merged;
        changes.push(`update account "${planned.id}"`);
      }
    }
  }

  if (plan.pool) {
    if (asRecord(entryConfig.pool)) {
      const samePool = JSON.stringify(entryConfig.pool) === JSON.stringify(plan.pool);
      if (!samePool) changes.push(`pool already exists — skipped (edit it by hand if you want changes)`);
    } else {
      entryConfig.pool = plan.pool;
      changes.push(`add pool "${plan.pool.id}" over [${plan.pool.accounts.join(", ")}]`);
    }
  }

  if (Array.isArray(plugins.allow) && !(plugins.allow as unknown[]).includes(PLUGIN_ID)) {
    (plugins.allow as unknown[]).push(PLUGIN_ID);
    changes.push(`append "${PLUGIN_ID}" to plugins.allow`);
  }

  if (plan.modelRungs.length > 0) {
    const agents = (config.agents = asRecord(config.agents) ?? {});
    const defaults = (agents.defaults = asRecord(agents.defaults) ?? {});
    const models = (defaults.models = asRecord(defaults.models) ?? {});
    for (const rung of plan.modelRungs) {
      if (!(rung in models)) {
        models[rung] = {};
        changes.push(`register model "${rung}"`);
      }
    }
  }

  return { config, changes };
}

/**
 * Defaults for an account id that already exists in the config, so the wizard
 * prefills reality instead of generic placeholders — pressing Enter through
 * the prompts must never overwrite a working account with defaults.
 */
export function existingAccountDefaults(
  config: unknown,
  id: string,
): { configDir?: string; label?: string; hasCredentials: boolean } | undefined {
  const entries = asRecord(asRecord(asRecord(config)?.plugins)?.entries);
  const entryConfig = asRecord(asRecord(entries?.["multi-clawd"])?.config);
  const accounts = Array.isArray(entryConfig?.accounts) ? (entryConfig?.accounts as unknown[]) : [];
  const acc = accounts.map(asRecord).find((a) => a?.id === id);
  if (!acc) return undefined;
  return {
    configDir: typeof acc.configDir === "string" ? acc.configDir : undefined,
    label: typeof acc.label === "string" ? acc.label : undefined,
    hasCredentials:
      acc.native === true ||
      acc.oauthTokenRef !== undefined ||
      acc.oauthTokenFile !== undefined ||
      typeof acc.configDir === "string",
  };
}

/**
 * Sanity heuristic for secret-reference INPUT: real references are URI-ish
 * (`op://Vault/Item/field`, `vault://…`). A bare word is almost certainly a
 * mistake — the wizard warns before accepting one.
 */
export function looksLikeSecretRef(id: string): boolean {
  return id.includes("://");
}
