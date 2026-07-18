/**
 * multi-clawd
 * Register additional Claude Code logins as first-class OpenClaw CLI backends,
 * so failover can pool multiple Claude accounts before dropping a model tier —
 * with the full skills/MCP harness intact on every account.
 *
 * How it works (verified against openclaw 2026.6.11):
 * - `api.registerCliBackend(...)` mirrors the bundled `claude-cli` backend
 *   (same argv, jsonl stream parsing, `bundleMcp` claude-config-file bridge,
 *   always-on native tools, native compaction) but scoped to one account id.
 * - `registerCliBackend` does NOT contribute a model catalog. The bundled
 *   Anthropic plugin makes `claude-cli/*` resolvable through its manifest
 *   `modelCatalog.providers` static rows — but the resolver only reads
 *   manifest static rows from plugins with origin "bundled"
 *   (model.static-catalog listBundledStaticCatalogPlugins), so an installed
 *   extension cannot use that path. Instead we register a minimal
 *   `ProviderPlugin` per account that implements `resolveDynamicModel` —
 *   the plugin dynamic-model hook the resolver consults on every lookup
 *   (resolvePluginDynamicModelWithRegistry → runProviderDynamicModel). This
 *   is what makes `claw2/claude-fable-5` resolvable without any
 *   `baseUrl`/API key. `augmentModelCatalog` additionally feeds the model
 *   catalog list (`openclaw models list`).
 * - `prepareExecution(ctx)` injects the account's own login into the child
 *   process env (`CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_OAUTH_TOKEN`). The runner
 *   applies `clearEnv` to the host env first and merges prepared env after,
 *   so stripping the main account's ambient Claude vars is safe.
 * - `resolveSyntheticAuth` mirrors the bundled backend's synthetic auth so
 *   status/failover surfaces treat the backend as authenticated (mode
 *   "token") without an OpenClaw auth profile.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolvePluginConfigObject,
  resolveLivePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  type CliBackendPlugin,
  type CliBackendPrepareExecutionContext,
  type CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_ALIASES,
  buildCatalogEntries,
  canonicalModelId,
  isModernClaudeModelId,
  resolveModelSpec,
} from "./models.js";
import { decideDegradation, matchesPin } from "./degrade.js";
import { resolveBaseModelIds } from "./catalog-source.js";
import { classifyAccountHealth, pickPoolAccountForLaunch } from "./health.js";
import { decideStickySelection, type StickyEntry } from "./sticky.js";
import type { AccountHealthState } from "./shim-core.js";
import {
  createTokenRefResolver,
  isSecretRefShape,
  type TokenRefResolver,
} from "./token-resolution.js";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { addAlert, clearAlert, pendingAlertText, type AlertState } from "./alerts.js";
import { buildAccountChildEnv, validateAccountTokenSources } from "./account-env.js";
import {
  checkAccountCredential,
  createRefProbeTracker,
  type CredentialIo,
  type RefProbeTracker,
} from "./login-health.js";
import { execFileSync } from "node:child_process";

interface AccountConfig {
  id: string;
  label?: string;
  /**
   * Use the machine's native Claude login (default config dir + OS keychain).
   * No configDir/token: on macOS the keychain is only consulted when
   * CLAUDE_CONFIG_DIR is unset, so a native account must not override it.
   */
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
  /** Extra model ids to expose for this account beyond the mirrored catalog. */
  models?: string[];
  /** Model used for live probes (openclaw models status). */
  defaultModel?: string;
}

/** Mirrors the bundled claude-cli backend argv (extensions/anthropic/cli-backend.ts). */
const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
  "--allowedTools",
  "mcp__openclaw__*",
  "--disallowedTools",
  "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
];

/**
 * Mirrors CLAUDE_CLI_CLEAR_ENV from the bundled backend: strip the host's own
 * Claude/Anthropic auth env so the child only sees this account's login.
 * The runner deletes these from the inherited env BEFORE merging the env
 * returned by prepareExecution, so our injected vars survive.
 */
const CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Token plumbing (v0.3): tokens come from a plaintext file (`oauthTokenFile`,
 * legacy), a secret reference resolved through the gateway's own configured
 * secret providers (`oauthTokenRef`, preferred — same `{source, provider, id}`
 * shape OpenClaw uses for every other secret in openclaw.json), or nowhere
 * (native / config-dir logins). Values are never logged; they ride only in
 * the child process env.
 *
 * The ref resolver is created per register() pass and bound to the live
 * runtime config so provider changes are picked up on rebuilds. The launch
 * path resolves asynchronously with a short cache; sync-only surfaces
 * (resolveSyntheticAuth) peek the warm cache instead of blocking.
 */
let activeTokenResolver: TokenRefResolver | undefined;

/**
 * Operator-alert state, surfaced via the heartbeat_prompt_contribution hook:
 * the agent's next heartbeat carries pending alerts, so they reach the
 * operator through the normal channel (e.g. Telegram) instead of dying as
 * journal lines. Module-level on purpose — registry rebuilds re-run
 * register(), and alerts must survive them.
 */
let alertState: AlertState = { alerts: [] };
let loginProbeTimer: ReturnType<typeof setInterval> | undefined;

function raiseAlert(alert: Parameters<typeof addAlert>[1]): void {
  alertState = addAlert(alertState, alert, Date.now());
}

/**
 * Out-of-process components (the eviction watchdog) can't reach alertState,
 * so they append alerts to a spool file; each heartbeat ingests and clears it.
 */
function ingestAlertSpool(): void {
  const spool = join(homedir(), ".openclaw", "state", "multi-clawd", "alerts-spool.jsonl");
  let raw: string;
  try {
    raw = readFileSync(spool, "utf8");
  } catch {
    return;
  }
  try {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const alert = JSON.parse(line) as {
          key?: string;
          severity?: string;
          text?: string;
          at?: number;
        };
        if (typeof alert.key === "string" && typeof alert.text === "string") {
          alertState = addAlert(
            alertState,
            {
              key: alert.key,
              severity: alert.severity === "error" ? "error" : "info",
              text: alert.text,
            },
            alert.at ?? Date.now(),
          );
        }
      } catch {
        // one bad line must not block the rest
      }
    }
    rmSync(spool, { force: true });
  } catch {
    // spool ingest is best-effort
  }
}

const LOGIN_PROBE_INTERVAL_MS = 15 * 60 * 1000;
const LOGIN_PROBE_INITIAL_DELAY_MS = 45 * 1000;

const realCredentialIo: CredentialIo = {
  readFile: (p) => readFileSync(expandHome(p), "utf8"),
  keychainHasClaudeCredentials: () => {
    try {
      execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  },
  platform: process.platform,
};

/**
 * Periodic login-health probe: credential *sources* are checked (file shape,
 * keychain presence, credentials.json token) so a dead login raises an
 * operator alert instead of silently failing every turn behind a
 * successfully-registered backend. Ref-backed accounts are validated through
 * the async resolver. No quota is spent.
 */
function startLoginHealthProbe(
  accounts: AccountConfig[],
  logger: { error: (m: string) => void; info: (m: string) => void },
): void {
  if (loginProbeTimer) clearInterval(loginProbeTimer);
  const lastStatus = new Map<string, string>();
  // Per-account backoff for ref-backed accounts: a transient provider blip
  // (op timeout, ENETUNREACH) must not be mistaken for a dead login. Only a
  // resolver that ran and returned nothing, or a sustained provider-error
  // streak, raises the operator alert. See createRefProbeTracker.
  const refTrackers = new Map<string, RefProbeTracker>();
  const probe = async () => {
    const now = Date.now();
    for (const account of accounts) {
      let status: string;
      let reason: string | undefined;
      if (isSecretRefShape(account.oauthTokenRef) && !account.oauthTokenFile && !account.native) {
        let tracker = refTrackers.get(account.id);
        if (!tracker) {
          tracker = createRefProbeTracker();
          refTrackers.set(account.id, tracker);
        }
        // A missing resolver counts as transient (degrade+retry), never a
        // credential problem — resolveDetailed classifies the real outcomes.
        const result =
          (await activeTokenResolver?.resolveDetailed(account.oauthTokenRef)) ?? {
            failure: "provider_error" as const,
          };
        const outcome = tracker.observe(result, now);
        status = outcome.status;
        reason = outcome.reason;
      } else {
        const check = checkAccountCredential(account, realCredentialIo);
        status = check.status;
        reason = check.reason;
      }
      const previous = lastStatus.get(account.id);
      lastStatus.set(account.id, status);
      if (status === "broken" && previous !== "broken") {
        const text = `account "${account.id}" login looks dead (${reason ?? "unknown"}) — turns on it will fail until fixed`;
        logger.error(`[multi-clawd] ${text}`);
        raiseAlert({ key: `login:${account.id}`, severity: "error", text });
      } else if (status === "degraded" && previous !== "degraded") {
        // Transient — one operator-visible info line per transition, no alert.
        logger.info(`[multi-clawd] account "${account.id}" login degraded: ${reason ?? "resolver error"}`);
      } else if (status === "ok" && (previous === "broken" || previous === "degraded")) {
        logger.info(`[multi-clawd] account "${account.id}" login recovered`);
        alertState = clearAlert(alertState, `login:${account.id}`);
      }
    }
  };
  const initial = setTimeout(() => void probe().catch(() => {}), LOGIN_PROBE_INITIAL_DELAY_MS);
  initial.unref?.();
  loginProbeTimer = setInterval(() => void probe().catch(() => {}), LOGIN_PROBE_INTERVAL_MS);
  loginProbeTimer.unref?.();
}

/** Sync token access: file reads and warm ref-cache hits only. */
function peekToken(account: AccountConfig): string | undefined {
  if (account.native) return undefined;
  if (account.oauthTokenFile) {
    return readFileSync(expandHome(account.oauthTokenFile), "utf8").trim();
  }
  if (isSecretRefShape(account.oauthTokenRef)) {
    return activeTokenResolver?.peek(account.oauthTokenRef);
  }
  if (account.configDir) return undefined;
  throw new Error(
    `[multi-clawd] account "${account.id}" needs oauthTokenFile, oauthTokenRef, or configDir`,
  );
}

/** Launch-path token access: resolves refs via the gateway's secret providers. */
async function resolveTokenAsync(account: AccountConfig): Promise<string | undefined> {
  if (isSecretRefShape(account.oauthTokenRef) && !account.native && !account.oauthTokenFile) {
    return activeTokenResolver?.resolve(account.oauthTokenRef);
  }
  return peekToken(account);
}

/**
 * Runtime model record for the resolver's plugin dynamic-model hook.
 * Mirrors the bundled anthropic plugin's forward-compat model shape
 * (buildAnthropicForwardCompatModel): anthropic-messages transport against
 * api.anthropic.com. Full agent turns never use that transport — the run
 * executor routes this provider through the CLI-backend registry
 * (isCliProvider) and drives the Claude Code subprocess — but the local
 * simple-completion transport (`openclaw infer model run`) calls the
 * Anthropic API directly with this account's setup token (sk-ant-oat…
 * tokens get the OAuth beta headers automatically).
 */
function buildRuntimeModel(
  account: AccountConfig,
  modelId: string,
): ProviderRuntimeModel | undefined {
  const id = canonicalModelId(modelId);
  if (!id) return undefined;
  const label = account.label ?? account.id;
  const spec = resolveModelSpec(id);
  return {
    id,
    name: `${spec.name} (${label})`,
    provider: account.id,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(id === "claude-fable-5" || id === "claude-mythos-5"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    mediaInput: {
      image: {
        maxSidePx: spec.imageMaxSidePx,
        preferredSidePx: spec.imageMaxSidePx,
        tokenMode: "provider",
      },
    },
  };
}

/** dist/shim.js sits next to dist/index.js in the installed extension. */
const SHIM_PATH = fileURLToPath(new URL("./shim.js", import.meta.url));

/** Per-account health state written by the shim, read by the steering hook. */
export function healthStateFile(accountId: string): string {
  return join(homedir(), ".openclaw", "state", "multi-clawd", `${accountId}.json`);
}

function buildBackend(account: AccountConfig): CliBackendPlugin {
  return {
    id: account.id,
    liveTest: {
      defaultModelRef: `${account.id}/${account.defaultModel ?? "claude-fable-5"}`,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    // Full harness — mirror the bundled claude-cli backend.
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    ownsNativeCompaction: true,
    config: {
      // Spawn our transparent shim (which spawns `claude`) so the plugin can
      // observe rate_limit_event records for near-limit account rotation.
      // process.execPath = the node running the gateway; always present.
      command: process.execPath,
      args: [SHIM_PATH, ...BASE_ARGS],
      resumeArgs: [SHIM_PATH, ...BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
      // The bundled claude-cli backend is recognised as a Claude stream-json
      // source by its provider id alone. A plugin-registered backend has a
      // different id (claw2), so core's isClaudeStreamJson checks
      // (supportsCliJsonlToolEvents / shouldUseClaudeLiveSession) fall through
      // and the batch parser dumps the RAW stream — SessionStart hook events
      // and all — straight to the channel. Declaring the dialect explicitly is
      // the supported non-id path (same mechanism gemini-cli uses) and makes
      // the parser strip the envelope down to assistant text. Without it every
      // live chat turn on this backend leaks raw JSONL. See DESIGN.md.
      jsonlDialect: "claude-stream-json",
      modelArg: "--model",
      modelAliases: { ...MODEL_ALIASES },
      imageArg: "@",
      imagePathScope: "workspace",
      sessionArg: "--session-id",
      sessionMode: "always",
      reseedFromRawTranscriptWhenUncompacted: false,
      sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "always",
      clearEnv: [...CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
    // The crux: point this backend's Claude Code process at its own login.
    async prepareExecution(
      _ctx: CliBackendPrepareExecutionContext,
    ): Promise<CliBackendPreparedExecution> {
      return { env: await buildAccountEnv(account) };
    },
  };
}

/** Child env for one account: tested contract lives in account-env.ts. */
async function buildAccountEnv(account: AccountConfig): Promise<Record<string, string>> {
  const token = await resolveTokenAsync(account);
  return buildAccountChildEnv(account, token, healthStateFile(account.id));
}

/**
 * Minimal provider registration whose only jobs are (a) contributing the
 * model catalog rows for this account's provider id and (b) synthetic auth
 * so status surfaces show the backend as authenticated. Model runs never
 * route through an API transport: the run executor checks the CLI-backend
 * registry first (isCliProvider) and drives the Claude Code subprocess.
 */
function buildCatalogProvider(account: AccountConfig): ProviderPlugin {
  return {
    id: account.id,
    label: account.label ?? `Claude Code (${account.id})`,
    auth: [],
    resolveSyntheticAuth: () => {
      try {
        // Sync surface: warm ref-cache or file read only — never blocks.
        const token = peekToken(account);
        if (!token) return undefined;
        return {
          apiKey: token,
          source: `multi-clawd ${account.id} token`,
          mode: "token",
        };
      } catch {
        return undefined;
      }
    },
    // Async on purpose: mirrors the bundled claude-cli catalog at catalog-build
    // time (falling back to the built-in list), so new subscription models
    // shipped by OpenClaw appear on this account automatically.
    augmentModelCatalog: async () =>
      buildCatalogEntries(
        account,
        await resolveBaseModelIds(),
      ) as unknown as ModelCatalogEntry[],
    // The hook the model resolver actually consults for provider-owned model
    // ids that are absent from models.json / generated catalogs. Manifest
    // modelCatalog static rows only resolve for bundled plugins, so an
    // installed extension must answer here (resolvePluginDynamicModelWithRegistry
    // → runProviderDynamicModel → this hook).
    resolveDynamicModel: (ctx) => buildRuntimeModel(account, ctx.modelId),
  };
}

export default definePluginEntry({
  id: "multi-clawd",
  name: "multi-clawd",
  description:
    "Register additional Claude Code logins as first-class OpenClaw CLI backends for cross-account failover.",
  register(api) {
    // Resolve this plugin's config defensively across OpenClaw versions.
    //
    // `api.pluginConfig` has been observed arriving empty on some registration
    // passes even though plugins.entries["multi-clawd"].config is present and
    // schema-valid. Historically we fell back to `resolvePluginConfigObject(
    // api.config, …)`, but 2026.7.x builds the register() api with `api.config`
    // empty in the real registration pass and expose the live config behind
    // `api.runtime.config.current()` instead (mirrors the bundled active-memory
    // / thread-ownership plugins). Reading only `api.config` therefore silently
    // no-ops the plugin on 2026.7.x — claw2 never registers (incident 2026-07-14
    // after the 2026.6.11 → 2026.7.1 upgrade).
    //
    // Preference order, robust on both 2026.6.x and 2026.7.x:
    //   1. live runtime config via api.runtime.config.current()  (2026.7.x)
    //   2. the injected startup pluginConfig                     (both)
    //   3. the static api.config snapshot                        (2026.6.x)
    // The runtime config accessor returns a deeply-readonly config; the
    // resolver only reads it, so cast to its exact expected loader type
    // (readonly→mutable variance is cosmetic here).
    const runtimeConfigLoader = (
      api.runtime?.config?.current
        ? () => api.runtime.config.current()
        : undefined
    ) as Parameters<typeof resolveLivePluginConfigObject>[0];
    // Try each config source in order and take the FIRST that actually carries
    // accounts. A plain ?? chain doesn't work here: resolveLivePluginConfigObject
    // returns {} (not undefined) when it falls back to an empty startup config,
    // which would short-circuit the chain before the api.config fallback runs.
    const candidates: Array<Record<string, unknown> | undefined> = [
      resolveLivePluginConfigObject(runtimeConfigLoader, "multi-clawd", api.pluginConfig),
      resolvePluginConfigObject(api.config, "multi-clawd"),
      api.pluginConfig,
    ];
    const hasAccounts = (c: Record<string, unknown> | undefined): boolean =>
      Array.isArray((c as { accounts?: unknown } | undefined)?.accounts) &&
      ((c as { accounts?: unknown[] }).accounts?.length ?? 0) > 0;
    const cfg = (candidates.find(hasAccounts) ?? {}) as {
      accounts?: AccountConfig[];
      pool?: PoolConfig;
    };
    const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    const sourceNames = [
      "runtime-live",
      "static-api-config",
      "startup-pluginConfig",
    ];
    if (accounts.length === 0) {
      api.logger.warn(
        `[multi-clawd] no accounts configured — nothing to register (sources: ${candidates
          .map(
            (c, i) =>
              `${sourceNames[i]}=${hasAccounts(c) ? "ok" : c ? "empty" : "absent"}`,
          )
          .join(", ")})`,
      );
      return;
    }
    api.logger.info(
      `[multi-clawd] register() pass — config source: ${
        sourceNames[candidates.findIndex(hasAccounts)] ?? "unknown"
      }, accounts: ${accounts.length}`,
    );
    // oauthTokenRef resolution rides the gateway's own secret providers.
    // Bound to the live config accessor so provider changes apply on rebuild;
    // logger captured now because `api` goes inert after register() returns.
    {
      const logger = api.logger;
      const currentConfig = api.runtime?.config?.current;
      activeTokenResolver = createTokenRefResolver({
        resolveRefs: (refs) =>
          resolveSecretRefValues(refs as Parameters<typeof resolveSecretRefValues>[0], {
            config: (currentConfig ? currentConfig() : api.config) as Parameters<
              typeof resolveSecretRefValues
            >[1]["config"],
          }),
        // Redacted: fixed reason code + error class only. No token values, no
        // ref metadata (provider/id can be sensitive), no provider text.
        redact: true,
        onError: (_ref, error) => logger.error(`[multi-clawd] ${String(error)}`),
      });
    }
    const seen = new Set<string>();
    for (const account of accounts) {
      const id = account?.id?.trim();
      if (!id) {
        api.logger.warn("[multi-clawd] skipping account without id");
        continue;
      }
      for (const warning of validateAccountTokenSources(account)) {
        api.logger.warn(`[multi-clawd] ${warning}`);
      }
      if (id === "claude-cli" || seen.has(id)) {
        api.logger.warn(
          `[multi-clawd] skipping account "${id}" — id collides with an existing backend`,
        );
        continue;
      }
      seen.add(id);
      const normalized = { ...account, id };
      api.registerCliBackend(buildBackend(normalized));
      api.registerProvider(buildCatalogProvider(normalized));
    }
    registerPoolBackend(api, cfg.pool, accounts, seen);

    // Operator alerts ride the agent's heartbeat prompt; login probe fills them.
    {
      const logger = api.logger;
      try {
        api.on("heartbeat_prompt_contribution", () => {
          ingestAlertSpool();
          const text = pendingAlertText(alertState, Date.now());
          return text ? { appendContext: text } : undefined;
        });
      } catch (err) {
        logger.warn(`[multi-clawd] heartbeat alert hook unavailable: ${String(err)}`);
      }
      startLoginHealthProbe(
        accounts.filter((a) => seen.has(a.id.trim())),
        logger,
      );
    }

    api.logger.info(
      `[multi-clawd] registered ${seen.size} backend(s)+provider(s): ${[...seen].join(", ")}`,
    );
  },
});

interface PoolConfig {
  /** Backend id for the pooled backend (e.g. "clawd"). */
  id?: string;
  label?: string;
  /** Account ids in preference order; the first is the home account. */
  accounts?: string[];
  utilizationThreshold?: number;
  staleAfterMs?: number;
  /** Minimum ms to stay on a rotated-to account before returning home. Default 600000. */
  minDwellMs?: number;
  models?: string[];
  defaultModel?: string;
  /** Tier-aware degradation (v0.3.5): step down a model tier when the whole pool is exhausted. */
  degrade?: {
    /** Same-provider models to fall back to, best first (e.g. ["claude-opus-4-8"]). */
    ladder?: string[];
    /** Never-degrade lanes: launches matching any pin keep their requested model. */
    pins?: Array<{ agentDirIncludes?: string; workspaceDirIncludes?: string }>;
  };
}

function readHealthState(accountId: string): AccountHealthState | undefined {
  try {
    return JSON.parse(
      readFileSync(healthStateFile(accountId), "utf8"),
    ) as AccountHealthState;
  } catch {
    return undefined;
  }
}

function readStickyEntry(file: string): StickyEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StickyEntry;
    if (typeof parsed?.account === "string" && typeof parsed?.since === "number") {
      return parsed;
    }
  } catch {
    // absent or corrupt — treated as no sticky
  }
  return undefined;
}

function writeStickyEntry(
  file: string,
  entry: StickyEntry | undefined,
  logger: { warn: (msg: string) => void },
): void {
  try {
    if (!entry) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    logger.warn(`[multi-clawd] sticky state write failed: ${String(err)}`);
  }
}

/**
 * The pooled backend: one backend id (default "clawd") that fronts several
 * Claude accounts. Every launch, prepareExecution reads the health state the
 * shim captured for each pooled account (rate_limit_event: status,
 * utilization, resetsAt) and injects the login of the first account that is
 * not nearly maxed out. The home account naturally reclaims the pool when its
 * window resets (its "rejected" verdict un-binds once resetsAt passes).
 *
 * This deliberately does NOT use plugin hooks: on OpenClaw 2026.7.1 the
 * before_model_resolve hook never fires for gateway RPC turns and
 * before_agent_start's overrides are ignored on the prompt path (verified
 * 2026-07-15). prepareExecution runs on every subprocess launch on every
 * turn path, so account choice lives here instead.
 *
 * When the whole pool is exhausted the home account is used anyway — the
 * launch fails with a real limit error and OpenClaw's reactive chain drops
 * to the next provider (e.g. OpenAI → xAI), exactly as configured.
 *
 * Known limitation: switching accounts mid-conversation loses the Claude CLI
 * session (it lives in the previous account's config dir); OpenClaw's
 * fresh-session retry recovers the turn. Rotation only happens at limit
 * boundaries, so this is rare by construction.
 */
function registerPoolBackend(
  api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0],
  pool: PoolConfig | undefined,
  accounts: AccountConfig[],
  registeredIds: Set<string>,
): void {
  const logger = api.logger;
  if (!pool) return;
  const poolId = pool.id?.trim() || "clawd";
  const memberIds = (pool.accounts ?? []).filter((id) => registeredIds.has(id));
  const members = memberIds
    .map((id) => accounts.find((a) => a.id.trim() === id))
    .filter((a): a is AccountConfig => a !== undefined);
  const ladder = (pool.degrade?.ladder ?? []).filter((m) => {
    if (isModernClaudeModelId(m)) return true;
    logger.warn(`[multi-clawd] pool "${poolId}": ignoring invalid degrade ladder entry "${m}"`);
    return false;
  });
  const pins = pool.degrade?.pins ?? [];
  // A single-account pool is meaningful with a degrade ladder: the pool then
  // exists purely to step tiers on that one account (single-account hosts).
  if (members.length < 2 && !(members.length === 1 && ladder.length > 0)) {
    logger.warn(
      `[multi-clawd] pool "${poolId}" has ${members.length} registered account(s) — need at least 2 (or 1 with a degrade ladder); pool not registered`,
    );
    return;
  }
  if (poolId === "claude-cli" || registeredIds.has(poolId)) {
    logger.warn(
      `[multi-clawd] pool id "${poolId}" collides with an existing backend — pool not registered`,
    );
    return;
  }
  const options = {
    utilizationThreshold: pool.utilizationThreshold,
    staleAfterMs: pool.staleAfterMs,
  };
  const poolAccount: AccountConfig = {
    id: poolId,
    label: pool.label ?? `Claude pool (${memberIds.join("+")})`,
    models: pool.models,
    defaultModel: pool.defaultModel,
  };
  const minDwellMs = pool.minDwellMs;
  const stickyFile = join(
    homedir(), ".openclaw", "state", "multi-clawd", `pool-${poolId}.sticky.json`,
  );
  const backend = buildBackend(poolAccount);
  backend.prepareExecution = async (ctx: CliBackendPrepareExecutionContext) => {
    const now = Date.now();
    // Model-aware (v0.3.6): a model-scoped rejected window (reactive 429
    // capture) exhausts an account only for the model this launch requests.
    const requestedModel = canonicalModelId(ctx.modelId) ?? ctx.modelId;
    const verdicts = members.map((a) => ({
      id: a.id,
      health: classifyAccountHealth(readHealthState(a.id), options, now, requestedModel),
    }));
    const previousSticky = readStickyEntry(stickyFile);
    const decision = decideStickySelection({
      verdicts: verdicts.map((v) => ({ id: v.id, verdict: v.health.verdict })),
      sticky: previousSticky,
      nowMs: now,
      minDwellMs,
    });
    const chosen = members.find((a) => a.id === decision.account) ?? members[0];
    const previousAccount = previousSticky?.account ?? members[0].id;
    if (decision.account !== previousAccount) {
      const home = verdicts[0];
      const line =
        decision.account === members[0].id
          ? `pool ${poolId}: returning home to ${decision.account}`
          : `pool ${poolId}: rotated to ${decision.account} from ${previousAccount} (${home.health.reason ?? home.health.verdict})`;
      logger.info(`[multi-clawd] ${line}`);
      raiseAlert({ key: `rotation:${poolId}`, severity: "info", text: line });
    }
    if (verdicts.every((v) => v.health.verdict === "exhausted")) {
      raiseAlert({
        key: `pool-exhausted:${poolId}:${requestedModel}`,
        severity: "error",
        text: `pool ${poolId}: every account is exhausted for ${requestedModel} — turns are degrading or falling through the chain`,
      });
    }
    writeStickyEntry(stickyFile, decision.sticky, logger);
    const env = await buildAccountEnv(chosen);
    // Tier degradation: only when the whole pool is exhausted and the launch
    // is not a pinned (contractual) lane. The shim enforces the swap.
    if (ladder.length > 0) {
      const pinned = matchesPin(pins, {
        agentDir: ctx.agentDir ?? "",
        workspaceDir: ctx.workspaceDir,
      });
      const degradation = pinned
        ? undefined
        : decideDegradation({
            verdicts: verdicts.map((v) => ({ id: v.id, verdict: v.health.verdict })),
            requestedModel: ctx.modelId,
            ladder,
          });
      if (degradation) {
        env.MULTI_CLAWD_MODEL_OVERRIDE = degradation.model;
        const line = `pool ${poolId}: degrading ${ctx.modelId} → ${degradation.model} on ${chosen.id} (${degradation.reason})`;
        logger.info(`[multi-clawd] ${line}`);
        raiseAlert({ key: `degrade:${poolId}`, severity: "info", text: line });
      } else if (pinned && verdicts.every((v) => v.health.verdict === "exhausted")) {
        logger.info(
          `[multi-clawd] pool ${poolId}: pinned lane keeps ${ctx.modelId} despite exhausted pool (will fail over via the chain)`,
        );
      }
    }
    return { env };
  };
  api.registerCliBackend(backend);
  api.registerProvider(buildCatalogProvider(poolAccount));
  registeredIds.add(poolId);
  logger.info(
    `[multi-clawd] pool "${poolId}" active — accounts: ${memberIds.join(" → ")}, threshold: ${
      options.utilizationThreshold ?? 0.85
    }`,
  );
}

