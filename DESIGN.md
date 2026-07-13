# DESIGN — openclaw-claude-multi

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
  → claude-icloud/claude-fable-5   (second login, this plugin)
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

### Model catalog

Because the backend id is not `claude-cli`, OpenClaw needs a model catalog for
the new provider id (otherwise "Unknown model … no matching
`models.providers[<id>].models[]`"). **Implementation task:** confirm whether
`registerCliBackend` auto-contributes the Claude model catalog for the new id,
or whether we must also contribute a catalog (mirroring the bundled Claude CLI
catalog: fable-5 ctx 1,000,000; opus-4-8/4-7 ctx 1,048,576; sonnet-5 ctx
200,000; etc., `reasoning: true`, `input: ["text","image"]`). Verify against the
plugin SDK types in `openclaw/plugin-sdk/cli-backend` and the bundled Anthropic
plugin. This is the one field the scaffold marks TODO.

## Config (user-facing)

```jsonc
{
  "plugins": {
    "claude-multi": {
      "accounts": [
        {
          "id": "claude-icloud",
          "label": "iCloud Max",
          "configDir": "~/.claude-icloud",
          "oauthTokenFile": "~/.claude-icloud/oauth-token"
        }
      ]
    }
  }
}
```

Then reference `claude-icloud/claude-fable-5` in the fallback chain.

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
   `claude-multi` active.
2. **Backend resolves + harness** — one-shot:
   `openclaw agent --agent main --model claude-icloud/claude-fable-5 --message "confirm + list mcp__openclaw__* tools"`.
   Expect a reply AND visible OpenClaw MCP tools (proves `bundleMcp`).
3. **Live failover** — add `claude-icloud/claude-fable-5` as the first fallback
   after the primary; restart; exhaust the main account's Fable pool; confirm
   the reply is served by the iCloud backend on **Fable**, not by a tier drop to
   Opus (gateway log: `next=claude-icloud/claude-fable-5`, no model-tier drop).

## Roadmap

- v0.1 — single extra account (iCloud), verified end-to-end.
- v0.2 — N accounts, round-robin/priority ordering, per-account cooldown surfacing.
- v0.3 — `oauthTokenRef` secret-manager resolvers (1Password), setup helper
  (`claude setup-token` capture into an isolated dir).
- v1.0 — docs, tests, publish to npm + ClawHub.
