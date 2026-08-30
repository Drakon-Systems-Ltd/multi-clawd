/**
 * multi-clawd
 * Register additional Claude Code logins as first-class OpenClaw CLI backends,
 * so failover can pool multiple Claude accounts before dropping a model tier —
 * with the full skills/MCP harness intact on every account.
 *
 * How it works (verified against OpenClaw 2026.7.1):
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
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { resolveExecMode, permissionModeArgs } from "./exec-policy.js";
import { resolveBaseModelIds } from "./catalog-source.js";
import { allCredentialFailed, classifyAccountHealth, pickPoolAccountForLaunch } from "./health.js";
import { decideStickySelection, type StickyEntry } from "./sticky.js";
import {
  clearCredentialFailure,
  mergeHealthStates,
  parseStoredState,
  recordCredentialFailure,
  type AccountHealthState,
} from "./shim-core.js";
import {
  createTokenRefResolver,
  isSecretRefShape,
  type TokenRefResolver,
} from "./token-resolution.js";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import {
  addAlert,
  alertKeysWithPrefix,
  clearAlert,
  pendingAlertText,
  type AlertState,
} from "./alerts.js";
import { healthStateFile, clearAccountCredentialFailure } from "./credential-state.js";
export { healthStateFile, clearAccountCredentialFailure };
import {
  buildAccountChildEnv,
  tokenFileModeWarning,
  validateAccountTokenSources,
} from "./account-env.js";
import {
  diffCatalogModels,
  formatNewModelNotice,
  type KnownModelsState,
} from "./model-currency.js";
import {
  checkAccountCredential,
  createRefProbeTracker,
  type CredentialIo,
  type RefProbeTracker,
} from "./login-health.js";
import { execFileSync } from "node:child_process";

export interface AccountConfig {
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
 * Mirrors CLAUDE_CLI_CLEAR_ENV from OpenClaw 2026.7.1's bundled backend: strip
 * the host's own Claude/Anthropic auth and telemetry env so the child only sees
 * this account's login.
 * The runner deletes these from the inherited env BEFORE merging the env
 * returned by prepareExecution, so our injected vars survive.
 */
export const CLEAR_ENV = [
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
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
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
 * Exactly what the operator's next heartbeat would carry — the one thing they
 * actually see of this module's alert state. Exported because a rendered line
 * that no longer matches reality is itself the bug (#15), so it has to be
 * assertable from a test rather than only observable in a live Telegram wake.
 */
export function pendingOperatorAlerts(nowMs: number): string | undefined {
  ingestAlertSpool();
  return pendingAlertText(alertState, nowMs);
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
/**
 * Probe state, deliberately at MODULE scope rather than inside
 * startLoginHealthProbe.
 *
 * These were per-call closures, and startLoginHealthProbe is re-called by every
 * register() pass — which the gateway runs on every config rebuild. So each
 * rebuild handed the probe a brand-new tracker and a brand-new "what did I say
 * last time" map. In the 8 Aug case three rebuilds landed inside one resolver
 * outage, and the streak that was supposed to mature after three consecutive
 * failures restarted at zero each time: the account's failure history was
 * erased by an event that has nothing to do with the account.
 *
 * Keyed by account id, pruned when an account leaves the config (below), so
 * history follows the account and not the process's registration cycle.
 */
const refProbeTrackers = new Map<string, RefProbeTracker>();
const lastProbeStatus = new Map<string, string>();

/**
 * Record a probe-observed credential failure so the NEXT pooled launch excludes
 * this account (#8 case 2, gap a). The probe used to log and alert and stop
 * there: selection read quota files only, so a login the probe had already
 * declared dead kept winning every rung for hours.
 *
 * Written on EVERY credential-broken observation, not just the transition into
 * it: the record is TTL-bounded (CREDENTIAL_FAILED_TTL_MS, 15m) and the probe
 * runs on the same 15m cadence, so a transition-only write would let the
 * exclusion lapse under a login that is still dead.
 *
 * Best-effort, like every other health write: no state file is worth a turn.
 */
function recordAccountCredentialFailure(
  accountId: string,
  reason: string,
  nowMs: number,
): void {
  const file = healthStateFile(accountId);
  let state: AccountHealthState;
  try {
    state = parseStoredState(readFileSync(file, "utf8")) ?? { accountId, windows: {} };
  } catch {
    state = { accountId, windows: {} };
  }
  const next = mergeHealthStates(
    state,
    recordCredentialFailure(state, reason, nowMs),
    nowMs,
  );
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // A health write that fails must never break the probe loop.
  }
}

/**
 * One probe pass over the given accounts. Exported (and dependency-injected)
 * so the wiring between a verdict and account selection is testable without
 * waiting out a 15-minute timer.
 */
export async function runLoginHealthProbe(
  accounts: AccountConfig[],
  logger: { error: (m: string) => void; info: (m: string) => void },
  deps: {
    resolver?: TokenRefResolver;
    io?: CredentialIo;
    nowMs?: number;
  } = {},
): Promise<void> {
  const now = deps.nowMs ?? Date.now();
  const resolver = deps.resolver ?? activeTokenResolver;
  const io = deps.io ?? realCredentialIo;
  for (const account of accounts) {
    let status: string;
    let reason: string | undefined;
    // Which evidence broke it — only `credential` may move selection. See
    // RefProbeStatus.cause; the sync source check leaves this unset.
    let cause: "credential" | "provider" | undefined;
    if (isSecretRefShape(account.oauthTokenRef) && !account.oauthTokenFile && !account.native) {
      let tracker = refProbeTrackers.get(account.id);
      if (!tracker) {
        tracker = createRefProbeTracker();
        refProbeTrackers.set(account.id, tracker);
      }
      // A missing resolver counts as transient (degrade+retry), never a
      // credential problem — resolveDetailed classifies the real outcomes.
      const result = (await resolver?.resolveDetailed(account.oauthTokenRef)) ?? {
        failure: "provider_error" as const,
      };
      const outcome = tracker.observe(result, now);
      status = outcome.status;
      reason = outcome.reason;
      cause = outcome.cause;
    } else {
      const check = checkAccountCredential(account, io);
      status = check.status;
      reason = check.reason;
    }
    const previous = lastProbeStatus.get(account.id);
    lastProbeStatus.set(account.id, status);
    if (status === "broken" && cause === "credential") {
      // Positive evidence against this account: the resolver ran and the
      // credential itself is wrong. Bench it.
      recordAccountCredentialFailure(account.id, reason ?? "login probe found no credential", now);
      if (previous !== "broken") {
        const text = `account "${account.id}" login looks dead (${reason ?? "unknown"}) — excluded from pool selection until it is fixed`;
        logger.error(`[multi-clawd] ${text}`);
        raiseAlert({ key: `login:${account.id}`, severity: "error", text });
      }
    } else if (status === "broken" && cause === "provider") {
      // Evidence about the HOST, not the account (#8 case 2, gap c). The 8 Aug
      // outage failed every account's resolver at once: benching on this would
      // have rotated away from a healthy login, or — with every member equally
      // "broken" — refused the launch outright with an auth error naming a
      // re-authentication that would have fixed nothing. Alert, and leave
      // selection alone; the network is the thing to fix.
      if (previous !== "broken") {
        const text =
          `account "${account.id}" credential resolver is unreachable (${reason ?? "unknown"}) — ` +
          `this looks like a host or network problem rather than a broken login, so account ` +
          `selection is unchanged. Check connectivity to the secret provider.`;
        logger.error(`[multi-clawd] ${text}`);
        raiseAlert({ key: `login-resolver:${account.id}`, severity: "error", text });
      }
    } else if (status === "broken" && previous !== "broken") {
      // Source check (file shape / keychain / credentials.json). Operator-
      // visible, but selection-neutral: it reports on the credential SOURCE,
      // and #8 is precisely the case where a present source is still a rejected
      // session. Only the reactive in-stream auth failure and a resolver that
      // came back empty are treated as proof against the account.
      const text = `account "${account.id}" login looks dead (${reason ?? "unknown"}) — turns on it will fail until fixed`;
      logger.error(`[multi-clawd] ${text}`);
      raiseAlert({ key: `login:${account.id}`, severity: "error", text });
    } else if (status === "degraded" && previous !== "degraded") {
      // Transient — one operator-visible info line per transition, no alert.
      logger.info(`[multi-clawd] account "${account.id}" login degraded: ${reason ?? "resolver error"}`);
    } else if (status === "ok" && (previous === "broken" || previous === "degraded")) {
      logger.info(`[multi-clawd] account "${account.id}" login recovered`);
      alertState = clearAlert(alertState, `login:${account.id}`);
      alertState = clearAlert(alertState, `login-resolver:${account.id}`);
      // NOT cleared here: any credential record this account carries. A probe
      // "ok" means the credential SOURCE resolves, which is not proof the
      // session is accepted — clearing on presence would un-bench a dead login
      // on the next tick and restore #8. The TTL, a successful turn through the
      // shim, or `multi-clawd login <id>` end the exclusion.
    }
  }
}

export function startLoginHealthProbe(
  accounts: AccountConfig[],
  logger: { error: (m: string) => void; info: (m: string) => void },
): void {
  if (loginProbeTimer) clearInterval(loginProbeTimer);
  // Drop history for accounts that have left the config; everything else
  // survives this re-registration on purpose (see refProbeTrackers).
  const live = new Set(accounts.map((a) => a.id));
  for (const id of [...refProbeTrackers.keys()]) {
    if (!live.has(id)) refProbeTrackers.delete(id);
  }
  for (const id of [...lastProbeStatus.keys()]) {
    if (!live.has(id)) lastProbeStatus.delete(id);
  }
  const probe = () => void runLoginHealthProbe(accounts, logger).catch(() => {});
  const initial = setTimeout(probe, LOGIN_PROBE_INITIAL_DELAY_MS);
  initial.unref?.();
  loginProbeTimer = setInterval(probe, LOGIN_PROBE_INTERVAL_MS);
  loginProbeTimer.unref?.();
}

/**
 * Paths already warned about this process, so a loose-permission token file
 * logs once at first use rather than on every single launch.
 */
const warnedTokenFileModes = new Set<string>();

/** Advisory permission check on a plaintext token file — never blocks the read. */
function warnIfTokenFileExposed(path: string): void {
  if (warnedTokenFileModes.has(path)) return;
  warnedTokenFileModes.add(path);
  try {
    const warning = tokenFileModeWarning(path, statSync(path).mode);
    if (warning) console.warn(`[multi-clawd] ${warning}`);
  } catch {
    // stat failed (races, odd filesystems) — the read below reports the real
    // problem; a hygiene check must never be the thing that breaks a launch.
  }
}

/** Sync token access: file reads and warm ref-cache hits only. */
function peekToken(account: AccountConfig): string | undefined {
  if (account.native) return undefined;
  if (account.oauthTokenFile) {
    const path = expandHome(account.oauthTokenFile);
    warnIfTokenFileExposed(path);
    return readFileSync(path, "utf8").trim();
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
async function resolveTokenAsync(
  account: AccountConfig,
  resolver?: TokenRefResolver,
): Promise<string | undefined> {
  if (isSecretRefShape(account.oauthTokenRef) && !account.native && !account.oauthTokenFile) {
    return (resolver ?? activeTokenResolver)?.resolve(account.oauthTokenRef);
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


/** Catalog ids observed on previous runs — the baseline for "this model is new". */
function knownModelsFile(): string {
  return join(homedir(), ".openclaw", "state", "multi-clawd", "known-models.json");
}

/**
 * Model refs in the operator's default chain, read from disk. Read here rather
 * than threaded through registration: this is a courtesy check off the hot
 * path, and it must not add a parameter to the launch-critical signatures.
 */
function readChainRefs(): string[] {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8"),
    ) as { agents?: { defaults?: { model?: { primary?: unknown; fallbacks?: unknown } } } };
    const m = cfg?.agents?.defaults?.model;
    const refs: string[] = [];
    if (typeof m?.primary === "string") refs.push(m.primary);
    if (Array.isArray(m?.fallbacks)) {
      for (const f of m.fallbacks) if (typeof f === "string") refs.push(f);
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Notice the operator when the provider ships a Claude model their chain does
 * not mention — and do nothing else about it. Which model belongs where is a
 * cost/quality decision that is theirs, so this offers and stops. Rides the
 * existing alert path, so it surfaces in their normal channel at the next
 * heartbeat rather than dying in the journal.
 *
 * Fully best-effort: any failure here must never affect registration.
 */
function checkModelCurrency(catalogIds: readonly string[], chainRefs: readonly string[], poolId: string): void {
  try {
    const file = knownModelsFile();
    let stored: KnownModelsState | undefined;
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as KnownModelsState;
    } catch {
      /* first run, or unreadable — diff treats both as "no baseline" */
    }
    const result = diffCatalogModels(stored, catalogIds, chainRefs, Date.now());

    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(result.nextState, null, 2), { mode: 0o600 });
    renameSync(tmp, file);

    const notice = formatNewModelNotice(result.unusedNewIds, poolId);
    if (notice) {
      // `key` is stable per model set, so re-registration during one gateway
      // lifetime cannot spam the same notice repeatedly.
      raiseAlert({
        key: `new-models:${result.unusedNewIds.join(",")}`,
        severity: "info",
        text: notice,
        ttlMs: 24 * 60 * 60 * 1000,
      });
    }
  } catch {
    /* never let a courtesy notice break a launch */
  }
}

export function buildBackend(account: AccountConfig, execMode?: string): CliBackendPlugin {
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
      args: [SHIM_PATH, ...BASE_ARGS, ...permissionModeArgs(execMode)],
      resumeArgs: [SHIM_PATH, ...BASE_ARGS, ...permissionModeArgs(execMode), "--resume", "{sessionId}"],
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
      // MUST stay true (parity with the bundled claude-cli backend). When a
      // pool rotation lands mid-conversation, the Claude CLI session being
      // resumed lives in the PREVIOUS account's config dir, so the resume
      // fails with session_expired. The gateway's fresh-session retry — the
      // only thing that keeps the turn on this backend instead of cascading
      // down the model-fallback chain to another provider — requires a
      // pre-built history prompt, and the gateway only builds one for a
      // resumable session when this flag is set. It was briefly false
      // (ce63bc9) because pre-jsonlDialect turns stored raw stream JSON in
      // the session history and reseeding replayed the garbage; the dialect
      // declaration above fixed the pollution at the source, and the reseed
      // reads OpenClaw's sanitized session store bounded by the auto history
      // char limit, so re-enabling is safe. Observed live 2026-07-21 07:37Z:
      // with false, a claw1→claw2 rotation "expired" four pooled Claude
      // rungs in 8s and the turn leaked to OpenAI.
      reseedFromRawTranscriptWhenUncompacted: true,
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
async function buildAccountEnv(
  account: AccountConfig,
  resolver?: TokenRefResolver,
): Promise<Record<string, string>> {
  const token = await resolveTokenAsync(account, resolver);
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
    // no-ops the plugin on 2026.7.x — claw2 never registers (observed after
    // the 2026.6.11 → 2026.7.1 upgrade).
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
    // Mirror core's permission-mode injection: core adds
    // --permission-mode bypassPermissions for the BUNDLED claude-cli backend
    // under a `full` exec policy (by provider id); a plugin backend gets no
    // flag and headless tool calls lock out. Derive it from the live policy so
    // a host on a stricter mode is never silently forced into bypass.
    const execMode = resolveExecMode(runtimeConfigLoader?.() ?? api.config);
    api.logger.info(
      `[multi-clawd] exec policy: ${execMode ?? "unknown"} → permission-mode ${
        permissionModeArgs(execMode).length ? "bypassPermissions" : "default (no override)"
      }`,
    );
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
      api.registerCliBackend(buildBackend(normalized, execMode));
      api.registerProvider(buildCatalogProvider(normalized));
    }
    registerPoolBackend(api, cfg.pool, accounts, seen, execMode);

    // Operator alerts ride the agent's heartbeat prompt; login probe fills them.
    {
      const logger = api.logger;
      try {
        api.on("heartbeat_prompt_contribution", () => {
          const text = pendingOperatorAlerts(Date.now());
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
  /**
   * Rotate on `seven_day_overage_included` utilization — spending against
   * purchased spill-over rather than quota. Off by default: the pool asks
   * rather than deciding how the operator's money is spent (#14).
   */
  rotateOnOverage?: boolean;
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

/**
 * End a recorded credential failure for one account (#8) — the explicit
 * re-authentication path (`multi-clawd login <id>`) and any surface that has
 * PROVEN the login works again. Exported so those out-of-band flows can
 * un-bench an account immediately instead of waiting out
 * CREDENTIAL_FAILED_TTL_MS.
 *
 * Deliberately NOT wired to the periodic login probe: that probe checks
 * credential SOURCES (keychain item present, token file well-formed, ref
 * resolves), and the whole point of #8 is that a present credential can still
 * be a rejected session. Clearing on presence would un-bench the dead account
 * on the next probe tick and restore the bug. A LIVE probe (`multi-clawd
 * doctor --probe`) needs no wiring here: it spends a real turn, which runs
 * through the shim, which clears on success like any other successful turn.
 *
 * Returns whether anything was cleared. Best-effort: a failure to write is
 * reported by the return value, never thrown — no state file is worth a turn.
 */

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
export function registerPoolBackend(
  api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0],
  pool: PoolConfig | undefined,
  accounts: AccountConfig[],
  registeredIds: Set<string>,
  execMode?: string,
  deps?: { resolver?: TokenRefResolver },
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
    rotateOnOverage: pool.rotateOnOverage,
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
  const backend = buildBackend(poolAccount, execMode);
  backend.prepareExecution = async (ctx: CliBackendPrepareExecutionContext) => {
    const now = Date.now();
    // Model-aware (v0.3.6): a model-scoped rejected window (reactive 429
    // capture) exhausts an account only for the model this launch requests.
    const requestedModel = canonicalModelId(ctx.modelId) ?? ctx.modelId;
    // Read each account's state ONCE: the stale-alert sweep below re-classifies
    // the same state against other models, and two reads at different instants
    // could disagree with each other.
    const states = members.map((a) => ({ id: a.id, state: readHealthState(a.id) }));
    const verdicts = states.map(({ id, state }) => ({
      id,
      health: classifyAccountHealth(state, options, now, requestedModel),
    }));
    // Every member's login is known-broken (#8): a dead native account used to
    // win all four clawd/* fallback rungs of a run because quota still said
    // `allowed`. There is no account to rotate to and no tier to degrade into
    // — an auth failure is not a quota failure — so fail ONCE, loudly, naming
    // the fix, instead of relaunching the same rejected session per rung.
    if (allCredentialFailed(verdicts.map((v) => ({ id: v.id, verdict: v.health.verdict })))) {
      const detail = verdicts
        .map((v) => `${v.id} (${v.health.reason ?? "credential rejected"})`)
        .join("; ");
      const text =
        `pool ${poolId}: every account's login is rejected by the Claude CLI — ` +
        `re-authenticate with \`multi-clawd login <account>\`. ${detail}`;
      logger.error(`[multi-clawd] ${text}`);
      raiseAlert({ key: `pool-credentials:${poolId}`, severity: "error", text });
      // Sticky state describes quota rotation; a credential outage must not
      // leave a stale pin behind for whichever account recovers first.
      writeStickyEntry(stickyFile, undefined, logger);
      throw new Error(`[multi-clawd] ${text}`);
    }
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
    // Quota exhaustion and credential failure are different operator problems
    // with different fixes (wait / re-authenticate), so they stay separate
    // alerts with separate keys — never collapsed into one "pool is unhappy".
    // An exhaustion alert is a claim with the same shelf life as the rejection
    // under it (#13), and nothing used to end it: the key was raised and never
    // cleared, so a 6h error TTL kept injecting "every account is exhausted"
    // into heartbeat prompts long after the windows reset. The alert reaches
    // the operator ONLY through the heartbeat hook, so interactive turns kept
    // working normally while every wake reported an outage that was over —
    // one box declared four models exhausted at 11:20Z off gravestones
    // written during a real 09:20Z outage (#15).
    //
    // Sweep the whole family, not just this launch's model, and re-check each
    // against the state we just read: an alert survives only while its own
    // condition still holds.
    const exhaustionPrefix = `pool-exhausted:${poolId}:`;
    for (const key of alertKeysWithPrefix(alertState, exhaustionPrefix)) {
      const alertedModel = key.slice(exhaustionPrefix.length);
      const stillExhausted = states.every(
        ({ state }) =>
          classifyAccountHealth(state, options, now, alertedModel).verdict === "exhausted",
      );
      if (!stillExhausted) alertState = clearAlert(alertState, key);
    }
    if (verdicts.every((v) => v.health.verdict === "exhausted")) {
      raiseAlert({
        key: `${exhaustionPrefix}${requestedModel}`,
        severity: "error",
        text: `pool ${poolId}: every account is exhausted for ${requestedModel} — turns are degrading or falling through the chain`,
      });
    }
    // A member benched for a rejected login is invisible otherwise: the pool
    // quietly succeeds on the remaining account until that one runs out too.
    // Paid spill-over nearly spent while real quota is fine: the pool has
    // deliberately not rotated, because whether to burn overage is the owner's
    // call, not a routing heuristic's (#14). Say so once per account, and stop
    // saying it the moment the condition clears.
    for (const v of verdicts) {
      const key = `overage:${poolId}:${v.id}`;
      if (v.health.overageAdvisory) {
        raiseAlert({
          key,
          // info, not error: nothing is broken and nothing is degraded — the
          // pool is serving normally. This is a question, and an error-severity
          // question would outlive its own answer by hours.
          severity: "info",
          text: `pool ${poolId}: account "${v.id}" — ${v.health.overageAdvisory}`,
        });
      } else {
        alertState = clearAlert(alertState, key);
      }
    }
    for (const v of verdicts) {
      const key = `credential:${poolId}:${v.id}`;
      if (v.health.verdict === "credential_failed") {
        raiseAlert({
          key,
          severity: "error",
          text: `pool ${poolId}: account "${v.id}" is excluded — ${
            v.health.reason ?? "its login was rejected by the Claude CLI"
          }. Fix with \`multi-clawd login ${v.id}\`.`,
        });
      } else {
        alertState = clearAlert(alertState, key);
      }
    }
    // Reaching here at all means at least one login still works, so the
    // pool-wide auth outage (if one was raised) is over.
    alertState = clearAlert(alertState, `pool-credentials:${poolId}`);
    writeStickyEntry(stickyFile, decision.sticky, logger);
    // An account whose credential will not resolve is skipped, not benched and
    // not launched. Two rules meet here and neither may be dropped: a resolver
    // outage is a HOST problem, so it must never mark the account's login
    // broken (#8); and an unresolvable credential must never launch, because
    // the child would fall through to the box's default login and spend a
    // different account's quota under this one's name (1.7.3). Skipping
    // satisfies both — the pool routes around the gap and the account comes
    // straight back the moment the secret provider does. Only when NO member
    // resolves does the launch fail, and then loudly, so OpenClaw's chain
    // drops to the next provider rather than a wrong Claude account.
    const order = [chosen, ...members.filter((m) => m.id !== chosen.id)];
    let env: Record<string, string> | undefined;
    const unresolved: string[] = [];
    for (const candidate of order) {
      try {
        env = await buildAccountEnv(candidate, deps?.resolver);
        if (candidate.id !== chosen.id) {
          logger.warn(
            `[multi-clawd] pool ${poolId}: ${chosen.id}'s credential did not resolve — ` +
              `launching on ${candidate.id} instead (account not benched; secret provider may be down)`,
          );
        }
        break;
      } catch (err) {
        unresolved.push(`${candidate.id} (${(err as Error).message})`);
      }
    }
    if (!env) {
      const text =
        `pool ${poolId}: no account's credential could be resolved — ` +
        `the secret provider is unreachable or every reference is empty. ${unresolved.join("; ")}`;
      logger.error(`[multi-clawd] ${text}`);
      raiseAlert({ key: `pool-unresolvable:${poolId}`, severity: "error", text });
      throw new Error(`[multi-clawd] ${text}`);
    }
    alertState = clearAlert(alertState, `pool-unresolvable:${poolId}`);
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

  // Courtesy check, fire-and-forget: has the provider shipped a Claude model
  // this chain has never heard of? Detached from the registration path so a
  // slow catalog read can never delay backends coming up.
  void (async () => {
    try {
      checkModelCurrency(await resolveBaseModelIds(), readChainRefs(), poolId);
    } catch {
      /* best-effort only */
    }
  })();
}

