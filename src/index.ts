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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_ALIASES,
  buildCatalogEntries,
  canonicalModelId,
  resolveModelSpec,
} from "./models.js";
import { resolveBaseModelIds } from "./catalog-source.js";
import { classifyAccountHealth, pickPoolAccountForLaunch } from "./health.js";
import type { AccountHealthState } from "./shim-core.js";

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
 * Resolve this account's setup-token. Never logged; passed only via child env.
 * Returns undefined for config-dir-only accounts: those use the native login
 * already present in that CLAUDE_CONFIG_DIR (this is how the machine's main
 * account joins the pool without duplicating its credentials).
 */
function resolveToken(account: AccountConfig): string | undefined {
  if (account.native) return undefined;
  if (account.oauthTokenFile) {
    return readFileSync(expandHome(account.oauthTokenFile), "utf8").trim();
  }
  if (account.oauthTokenRef) {
    // Roadmap v0.3: resolve via a secret-manager reference (e.g. 1Password).
    throw new Error(
      `[multi-clawd] oauthTokenRef not yet implemented for account "${account.id}" — use oauthTokenFile`,
    );
  }
  if (account.configDir) return undefined;
  throw new Error(
    `[multi-clawd] account "${account.id}" needs oauthTokenFile, oauthTokenRef, or configDir`,
  );
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
    prepareExecution(
      _ctx: CliBackendPrepareExecutionContext,
    ): CliBackendPreparedExecution {
      return { env: buildAccountEnv(account) };
    },
  };
}

/**
 * Child-process env for one account. Token-file accounts authenticate via
 * env; config-dir accounts rely on the file-based login in that
 * CLAUDE_CONFIG_DIR; native accounts set NEITHER — the child falls back to
 * the default config dir, which is the only mode where the OS keychain login
 * is consulted (macOS).
 */
function buildAccountEnv(account: AccountConfig): Record<string, string> {
  const env: Record<string, string> = {
    MULTI_CLAWD_ACCOUNT_ID: account.id,
    MULTI_CLAWD_STATE_FILE: healthStateFile(account.id),
  };
  const token = resolveToken(account);
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (!account.native && account.configDir) {
    env.CLAUDE_CONFIG_DIR = expandHome(account.configDir);
  }
  return env;
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
        const token = resolveToken(account);
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
    const seen = new Set<string>();
    for (const account of accounts) {
      const id = account?.id?.trim();
      if (!id) {
        api.logger.warn("[multi-clawd] skipping account without id");
        continue;
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
  models?: string[];
  defaultModel?: string;
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
  if (members.length < 2) {
    logger.warn(
      `[multi-clawd] pool "${poolId}" has ${members.length} registered account(s) — need at least 2; pool not registered`,
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
  const backend = buildBackend(poolAccount);
  backend.prepareExecution = () => {
    const now = Date.now();
    const verdicts = members.map((a) => ({
      id: a.id,
      health: classifyAccountHealth(readHealthState(a.id), options, now),
    }));
    const chosenId = pickPoolAccountForLaunch(
      verdicts.map((v) => ({ id: v.id, verdict: v.health.verdict })),
    );
    const chosen = members.find((a) => a.id === chosenId) ?? members[0];
    if (chosenId !== members[0].id) {
      const home = verdicts[0];
      logger.info(
        `[multi-clawd] pool ${poolId}: launching on ${chosenId} instead of ${home.id} (${home.health.reason ?? home.health.verdict})`,
      );
    }
    return { env: buildAccountEnv(chosen) };
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

