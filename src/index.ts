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
import { resolve } from "node:path";

interface AccountConfig {
  id: string;
  label?: string;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
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

/** Model aliases mirrored from the bundled backend (CLAUDE_CLI_MODEL_ALIASES). */
const MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  sonnet: "sonnet",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "haiku",
};

/** Mirror of the bundled Claude CLI catalog (extensions/anthropic/cli-catalog.ts). */
const MODEL_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-haiku-4-5",
] as const;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-8": 1048576,
  "claude-opus-4-7": 1048576,
  "claude-opus-4-6": 1048576,
  "claude-sonnet-4-6": 1048576,
  "claude-sonnet-5": 200000,
  "claude-fable-5": 1000000,
  "claude-haiku-4-5": 200000,
};

/** Mirrors the bundled anthropic manifest maxTokens per model. */
const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-opus-4-8": 128000,
  "claude-opus-4-7": 64000,
  "claude-opus-4-6": 64000,
  "claude-sonnet-4-6": 64000,
  "claude-sonnet-5": 64000,
  "claude-fable-5": 128000,
  "claude-haiku-4-5": 64000,
};

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5": "Claude Fable 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Resolve this account's setup-token. Never logged; passed only via child env. */
function resolveToken(account: AccountConfig): string {
  if (account.oauthTokenFile) {
    return readFileSync(expandHome(account.oauthTokenFile), "utf8").trim();
  }
  if (account.oauthTokenRef) {
    // Roadmap v0.3: resolve via a secret-manager reference (e.g. 1Password).
    throw new Error(
      `[multi-clawd] oauthTokenRef not yet implemented for account "${account.id}" — use oauthTokenFile`,
    );
  }
  throw new Error(
    `[multi-clawd] account "${account.id}" needs oauthTokenFile or oauthTokenRef`,
  );
}

/** Canonicalize a requested model id via the CLI alias table. */
function canonicalModelId(modelId: string): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  const aliased = MODEL_ALIASES[trimmed] ?? trimmed;
  return (MODEL_IDS as readonly string[]).includes(aliased) ? aliased : undefined;
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
  const maxSidePx =
    id === "claude-opus-4-8" || id === "claude-opus-4-7" ? 2576 : 1568;
  return {
    id,
    name: `${MODEL_NAMES[id] ?? id} (${label})`,
    provider: account.id,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: MODEL_CONTEXT_WINDOWS[id] ?? 200000,
    maxTokens: MODEL_MAX_TOKENS[id] ?? 64000,
    ...(id === "claude-fable-5"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    mediaInput: {
      image: { maxSidePx, preferredSidePx: maxSidePx, tokenMode: "provider" },
    },
  };
}

function buildCatalogEntries(account: AccountConfig): ModelCatalogEntry[] {
  const label = account.label ?? account.id;
  return MODEL_IDS.map((id) => {
    const maxSidePx =
      id === "claude-opus-4-8" || id === "claude-opus-4-7" ? 2576 : 1568;
    return {
      id,
      name: `${MODEL_NAMES[id] ?? id} (${label})`,
      provider: account.id,
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: { maxSidePx, preferredSidePx: maxSidePx, tokenMode: "provider" },
      },
      contextWindow: MODEL_CONTEXT_WINDOWS[id] ?? 200000,
    } as ModelCatalogEntry;
  });
}

function buildBackend(account: AccountConfig): CliBackendPlugin {
  return {
    id: account.id,
    liveTest: {
      defaultModelRef: `${account.id}/claude-fable-5`,
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
      command: "claude",
      args: [...BASE_ARGS],
      resumeArgs: [...BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
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
      const env: Record<string, string> = {
        CLAUDE_CODE_OAUTH_TOKEN: resolveToken(account),
      };
      if (account.configDir) {
        env.CLAUDE_CONFIG_DIR = expandHome(account.configDir);
      }
      return { env };
    },
  };
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
        return {
          apiKey: resolveToken(account),
          source: `multi-clawd ${account.id} token`,
          mode: "token",
        };
      } catch {
        return undefined;
      }
    },
    augmentModelCatalog: () => buildCatalogEntries(account),
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
    };
    const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    if (accounts.length === 0) {
      api.logger.warn(
        "[multi-clawd] no accounts configured — nothing to register",
      );
      return;
    }
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
  },
});
