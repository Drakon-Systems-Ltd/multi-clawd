/**
 * openclaw-claude-multi
 * Register additional Claude Code logins as first-class OpenClaw CLI backends,
 * so failover can pool multiple Claude accounts before dropping a model tier —
 * with the full skills/MCP harness intact on every account.
 *
 * NOTE: `register()` mirrors the bundled Anthropic `claude-cli` backend config,
 * but drives each account's own login via `prepareExecution` (CLAUDE_CONFIG_DIR
 * + CLAUDE_CODE_OAUTH_TOKEN). The model-catalog contribution for the new backend
 * id is marked TODO below — verify the exact SDK call against
 * `openclaw/plugin-sdk/cli-backend` and the bundled Anthropic plugin.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  type CliBackendPlugin,
} from "openclaw/plugin-sdk/cli-backend";
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

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Resolve this account's setup-token from a file or a secret reference. */
async function resolveToken(
  account: AccountConfig,
  api: unknown,
): Promise<string> {
  if (account.oauthTokenFile) {
    return readFileSync(expandHome(account.oauthTokenFile), "utf8").trim();
  }
  if (account.oauthTokenRef) {
    // TODO: resolve via OpenClaw's secret-ref resolver exposed on `api`.
    throw new Error(
      `[claude-multi] oauthTokenRef not yet implemented for account "${account.id}"`,
    );
  }
  throw new Error(
    `[claude-multi] account "${account.id}" needs oauthTokenFile or oauthTokenRef`,
  );
}

function buildBackend(account: AccountConfig, api: unknown): CliBackendPlugin {
  return {
    id: account.id,
    liveTest: {
      defaultModelRef: `${account.id}/claude-fable-5`,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    // Full harness — mirror the bundled claude-cli backend.
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    ownsNativeCompaction: true,
    config: {
      command: "claude",
      args: BASE_ARGS,
      resumeArgs: [...BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      input: "stdin",
      modelArg: "--model",
      sessionMode: "always",
      serialize: true,
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
    },
    // The crux: point this backend's Claude Code process at its own login.
    async prepareExecution(ctx: any) {
      const token = await resolveToken(account, api);
      const env: Record<string, string> = {
        CLAUDE_CODE_OAUTH_TOKEN: token,
      };
      if (account.configDir) {
        env.CLAUDE_CONFIG_DIR = expandHome(account.configDir);
      }
      return { env };
    },
  };
}

export default definePluginEntry({
  id: "claude-multi",
  name: "Claude Multi-Account",
  description:
    "Register additional Claude Code logins as first-class OpenClaw CLI backends for cross-account failover.",
  register(api: any) {
    const cfg = api?.config ?? {};
    const accounts: AccountConfig[] = Array.isArray(cfg.accounts)
      ? cfg.accounts
      : [];
    if (accounts.length === 0) {
      api?.log?.warn?.(
        "[claude-multi] no accounts configured — nothing to register",
      );
      return;
    }
    for (const account of accounts) {
      if (!account?.id) continue;
      api.registerCliBackend(buildBackend(account, api));
      // TODO(verify): contribute the Claude model catalog for `account.id`
      // if registerCliBackend does not do it automatically, e.g.
      //   api.registerModelCatalog?.({ provider: account.id, models: [...] })
      // Mirror bundled Claude CLI catalog (fable-5 ctx 1_000_000, opus/sonnet, ...).
    }
  },
});
