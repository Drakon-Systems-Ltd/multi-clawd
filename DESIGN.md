# DESIGN — multi-clawd

Multi-account Claude Code failover for OpenClaw.

## Problem

OpenClaw's bundled `claude-cli` backend drives one Claude Code subprocess, which
authenticates with a **single** native login. When that account hits a usage
limit (e.g. a "You've reached your Fable 5 limit" quota error), OpenClaw's
failover engine cannot re-drive the running subprocess onto a second Claude
account — it can only step to the **next model** in the chain (e.g. Opus).

So an operator who owns two Claude Max accounts cannot pool them: the second
account's Fable/Opus capacity sits idle while the failover drops a model tier.

### Why the obvious fixes don't work

Investigated and ruled out on 2026-07-13:

1. **`auth.order.claude-cli`** — the CLI subprocess doesn't consult OpenClaw's
   auth-profile rotation mid-run; it uses its own native login only. Inert.
2. **Registering the 2nd account as a `claude-cli` token profile**
   (`models auth paste-token --provider claude-cli`) — necessary but not
   sufficient; the backend still won't hot-swap logins mid-run. On a limit it
   still jumps to the next model, never the second account.
3. **A second CLI backend via plain `agents.defaults.cliBackends` config** —
   OpenClaw's model catalog treats a user-defined provider as an **API**
   provider: without `baseUrl` it refuses to load; with `baseUrl` it demands an
   API key instead of routing through the CLI wrapper. The `baseUrl` exemption
   is **plugin-owned** — only bundled/plugin-registered providers get it.

### The correct approach

A **plugin** that registers additional Claude backends via
`api.registerCliBackend(...)`. Plugin-registered backends get the same
first-class treatment as the bundled `claude-cli`: catalog exemption, the
loopback MCP tool bridge (`bundleMcp`), always-on native tools, and native
compaction ownership. Each backend points at its own isolated Claude login.

Result — a failover chain that pools accounts before dropping a tier:

```
claude-cli/claude-fable-5   (native login, main account)
  → claw2/claude-fable-5   (second login, this plugin)
    → anthropic/claude-opus-4-8
      → …
```

Both Fable backends are full Claude Code subprocesses, so the skills/hooks/MCP
harness is intact on both. No runtime swap, no harness loss.

## How OpenClaw CLI-backend plugins work

Three contracts (see OpenClaw docs `plugins/cli-backend-plugins`):

| Contract | File | Purpose |
| --- | --- | --- |
| Package entry | `package.json` (`openclaw.extensions` / `runtimeExtensions`) | Points at the runtime module |
| Manifest ownership | `openclaw.plugin.json` (`id`, `activation.onStartup`, `configSchema`) | Declares the plugin + config before runtime loads |
| Runtime registration | `src/index.ts` → `definePluginEntry({ register(api) { api.registerCliBackend(...) } })` | Registers each backend |

Key `CliBackendPlugin` fields we mirror from the bundled `claude-cli`:

- `config`: `command: "claude"`, args
  `["-p","--output-format","stream-json","--include-partial-messages","--verbose","--setting-sources","user","--allowedTools","mcp__openclaw__*","--disallowedTools","ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor"]`,
  `resumeArgs` = same + `["--resume","{sessionId}"]`, `output: "jsonl"`,
  `input: "stdin"`, `modelArg: "--model"`, `sessionMode: "always"`, `serialize: true`.
- `bundleMcp: true`, `bundleMcpMode: "claude-config-file"` — the OpenClaw tool bridge.
- `nativeToolMode: "always-on"` — Claude Code's own tools.
- `ownsNativeCompaction: true` — Claude Code compacts internally.
- **`prepareExecution(ctx)`** — the crux: inject this account's login into the
  child env before launch:
  - `CLAUDE_CONFIG_DIR` = the account's isolated config dir
  - `CLAUDE_CODE_OAUTH_TOKEN` = the account's setup-token (from `oauthTokenFile`
    or resolved `oauthTokenRef`)
- `liveTest.defaultModelRef` for `openclaw models status --probe`.

### Model catalog (resolved 2026-07-13, openclaw 2026.6.11)

Because the backend id is not `claude-cli`, OpenClaw needs a model catalog for
the new provider id (otherwise "Unknown model …"). Verified against the real
SDK (`dist/registry-*.js`, `dist/model-catalog-*.js`,
`dist/providers-*.js`) and the bundled Anthropic plugin
(`register.runtime-*.js`):

- **`registerCliBackend` does NOT auto-contribute a catalog.** It only records
  the backend in the CLI-backend registry (which makes `isCliProvider` true and
  routes runs through the CLI runner with the full `bundleMcp`/native-tools
  harness — that's the plugin-owned `baseUrl` exemption).
- The bundled plugin publishes the `claude-cli/*` rows through its
  **ProviderPlugin's `augmentModelCatalog` hook**
  (`augmentModelCatalog: () => buildClaudeCliCatalogEntries()` on the
  `anthropic` provider). Catalog entries carry `provider: "claude-cli"` even
  though no provider with that id is registered — entry provider ids are
  independent of the registered provider id.
- We mirror that: per account, `api.registerProvider({ id, label, auth: [],
  augmentModelCatalog, resolveSyntheticAuth })`. `augmentModelCatalog` returns
  the Claude CLI rows under the account's provider id (fable-5 ctx 1,000,000;
  opus-4-8/4-7/4-6 + sonnet-4-6 ctx 1,048,576; sonnet-5/haiku-4-5 ctx 200,000;
  `reasoning: true`, `input: ["text","image"]`, `mediaInput.image` maxSidePx
  2576 for opus-4-8/4-7 else 1568). `resolveSyntheticAuth` returns the account
  token (mode `"token"`) so status/failover surfaces treat the backend as
  authenticated, mirroring `resolveClaudeCliSyntheticAuth`.
- **Manifest gate:** `resolveCatalogHookProviderPluginIds` only calls
  `augmentModelCatalog` for plugins whose manifest declares a non-empty
  `providers` list AND `modelCatalog.runtimeAugment: true` (the latter is
  implied for non-bundled plugins with providers, but we declare it
  explicitly). Hence `openclaw.plugin.json` carries
  `"providers": ["claw2"]`, `"cliBackends": ["claw2"]`,
  `"modelCatalog": {"runtimeAugment": true}`. The gate is plugin-level, so
  accounts with ids other than the manifest defaults still get catalog rows.
- **Env ordering is safe:** the runner applies the backend `clearEnv` to the
  inherited host env first, then merges the env returned by
  `prepareExecution`, so mirroring the bundled `CLAUDE_CLI_CLEAR_ENV` (which
  strips `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_OAUTH_TOKEN` from the host) does not
  clobber our injected per-account login.
- **Agent allowlist:** `agents.defaults.models` acts as a per-agent model
  allowlist; `claw2/claude-fable-5` must be added there (empty object
  is enough) or the gateway rejects the override. This is separate from the
  failover chain (`agents.defaults.model.primary`/`fallbacks`).

## Config (user-facing)

```jsonc
{
  "plugins": {
    // if plugins.allow is set, add "multi-clawd" to it
    "entries": {
      "multi-clawd": {
        "enabled": true,
        "config": {
          "accounts": [
            {
              "id": "claw2",
              "label": "iCloud Max",
              "configDir": "~/.claw2",
              "oauthTokenFile": "~/.claw2/oauth-token"
            }
          ]
        }
      }
    }
  },
  "agents": {
    "defaults": {
      // allow the model for agents (separate from the failover chain)
      "models": { "claw2/claude-fable-5": {} }
    }
  }
}
```

Then reference `claw2/claude-fable-5` in the fallback chain.

## Security

- Tokens are **never** committed. `.gitignore` blocks `*.token`, `*.oauth`,
  `.claude-*/`, `secrets/`, `accounts/`.
- Prefer `oauthTokenRef` (1Password / secret manager) over a plaintext file.
  When a file is used it must be `0600`.
- `prepareExecution` reads the token at launch and passes it only via the child
  process env — it is not logged.

## Testing

1. **Unit / load** — `npm run build`; install locally
   (`openclaw plugins install <path>` or link); `openclaw plugins list` shows
   `multi-clawd` active.
2. **Backend resolves + harness** — one-shot:
   `openclaw agent --agent main --model claw2/claude-fable-5 --message "confirm + list mcp__openclaw__* tools"`.
   Expect a reply AND visible OpenClaw MCP tools (proves `bundleMcp`).
3. **Live failover** — add `claw2/claude-fable-5` as the first fallback
   after the primary; restart; exhaust the main account's Fable pool; confirm
   the reply is served by the iCloud backend on **Fable**, not by a tier drop to
   Opus (gateway log: `next=claw2/claude-fable-5`, no model-tier drop).

## Roadmap

- v0.1 — single extra account (iCloud), verified end-to-end.
- v0.2 — N accounts, round-robin/priority ordering, per-account cooldown surfacing.
- v0.3 — `oauthTokenRef` secret-manager resolvers (1Password), setup helper
  (`claude setup-token` capture into an isolated dir).
- v1.0 — docs, tests, publish to npm + ClawHub.
