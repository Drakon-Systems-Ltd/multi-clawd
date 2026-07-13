# BUILD_RESULT — openclaw-claude-multi v0.1.0

Date: 2026-07-13 · Gateway: openclaw 2026.6.11 (e085fa1) · Result: **SELF-TEST PASSED**

## What the SDK required for catalog registration

Verified by reading the installed SDK (`dist/registry-*.js`,
`dist/model-catalog-*.js`, `dist/providers-*.js`, `dist/cli-backends-*.js`) and
the bundled Anthropic plugin (`register.runtime-*.js`, `cli-backend-CkQ4PBJi.js`,
`cli-catalog-DrFnMS-C.js`):

1. **`api.registerCliBackend(...)` does NOT contribute a model catalog.** It
   only records the backend in the CLI-backend registry. That registration is
   what makes the provider id a "CLI provider" (`isCliProvider`) so runs route
   through the CLI runner with the full harness — this is the plugin-owned
   `baseUrl` exemption that plain `agents.defaults.cliBackends` config never
   gets.
2. **The catalog comes from a ProviderPlugin's `augmentModelCatalog` hook.**
   The bundled Anthropic plugin registers the `claude-cli/*` rows via
   `augmentModelCatalog: () => buildClaudeCliCatalogEntries()` on its
   `anthropic` provider. Catalog entry `provider` ids are independent of the
   registered provider id. We mirror this: per configured account,
   `api.registerProvider({ id: account.id, label, auth: [],
   augmentModelCatalog, resolveSyntheticAuth })`.
3. **Manifest gate:** the catalog hook only runs for plugins whose
   `openclaw.plugin.json` declares a non-empty `providers` array (plus
   `modelCatalog.runtimeAugment: true`, implied for non-bundled plugins with
   providers). Added `"providers": ["claude-icloud"]`,
   `"cliBackends": ["claude-icloud"]`, `"modelCatalog": {"runtimeAugment": true}`.
4. **`prepareExecution` return shape** is `{ env?, clearEnv?, cleanup? }`
   (`CliBackendPreparedExecution`). The runner applies the backend `clearEnv`
   to the host env FIRST and merges the prepared env AFTER, so mirroring the
   bundled `CLAUDE_CLI_CLEAR_ENV` (which strips `CLAUDE_CONFIG_DIR` /
   `CLAUDE_CODE_OAUTH_TOKEN` from the host) is safe: our injected per-account
   login survives.
5. **Plugin config** is read from `api.pluginConfig` (typed
   `Record<string, unknown>`), sourced from
   `plugins.entries["claude-multi"].config` in openclaw.json.
6. **`resolveSyntheticAuth`** (mode `"token"`, token read from
   `oauthTokenFile`) mirrors the bundled `resolveClaudeCliSyntheticAuth` so
   auth/status surfaces treat the backend as authenticated without an OpenClaw
   auth profile. CLI-backend runs don't require an auth profile at prepare
   time — ambient/prepared env is enough.
7. **Model catalog rows** mirror the bundled Claude CLI catalog:
   `claude-fable-5` ctx 1,000,000; `claude-opus-4-8/-4-7/-4-6` and
   `claude-sonnet-4-6` ctx 1,048,576; `claude-sonnet-5` / `claude-haiku-4-5`
   ctx 200,000; `reasoning: true`; `input: ["text","image"]`;
   `mediaInput.image.maxSidePx` 2576 for opus-4-8/4-7, else 1568.

## Self-test — PASSED (no gateway restart needed)

```
openclaw agent --agent main --model claude-icloud/claude-fable-5 \
  --message "Reply CONFIRM and list any tools named mcp__openclaw__*; if none say NO OPENCLAW TOOLS."
```

Model reply (verbatim, abridged list):

> CONFIRM
>
> The following `mcp__openclaw__*` tools are available:
>
> - mcp__openclaw__create_goal … mcp__openclaw__web_search
>
> That's 21 tools total.

Evidence it ran on the second account with the full harness:

- init event: `"mcp_servers":[{"name":"openclaw","status":"connected"}]` →
  **bundleMcp bridge works** on the plugin backend.
- init event: `"memory_paths":{"auto":"/home/ubuntu/.claude-icloud/projects/-home-ubuntu-clawd/memory/"}`
  → subprocess ran with `CLAUDE_CONFIG_DIR=/home/ubuntu/.claude-icloud`
  (the iCloud login, not the main one).
- `"model":"claude-fable-5"`, result `subtype: success`, `stop_reason: end_turn`.
- Rate-limit event shows the account's own `five_hour` pool → its own quota.

## Commands that worked

```bash
npm install                    # openclaw pinned to exactly 2026.6.11
npm run build                  # tsc — passes, emits dist/index.js
openclaw plugins install /home/ubuntu/clawd/projects/openclaw-claude-multi
openclaw plugins list          # shows claude-multi enabled
openclaw plugins inspect claude-multi --runtime
                               # Capabilities: cli-backend: claude-icloud,
                               #               text-inference: claude-icloud
openclaw config validate       # Config valid
openclaw agent --agent main --model claude-icloud/claude-fable-5 --message …
```

Config changes (openclaw.json — backup at `openclaw.json.bak-pluginbuild`):

- `plugins.allow` += `"claude-multi"` (allowlist was active)
- `plugins.entries.claude-multi = { enabled: true, config: { accounts: [
    { id: "claude-icloud", label: "iCloud Max account",
      configDir: "/home/ubuntu/.claude-icloud",
      oauthTokenFile: "/home/ubuntu/.claude-icloud/oauth-token" } ] } }`
- `agents.defaults.models["claude-icloud/claude-fable-5"] = {}` — required:
  this map is the per-agent model allowlist; without it the gateway rejects
  the override ("Model override … is not allowed for agent main"). This does
  NOT touch `agents.defaults.model.primary`/`fallbacks`.

Build fixes along the way:

- Pinned `openclaw` to exactly `2026.6.11` (npm resolved `^2026.6` to 2026.7.1,
  newer than the installed gateway).
- `declaration: false` in tsconfig (TS2742 non-portable inferred type on the
  `definePluginEntry` default export with declaration emit).

## Notes / follow-ups

- `openclaw models list --all` does not display the `claude-icloud/*` rows
  (listing-visibility quirk for plugin CLI runtime providers), but
  `loadModelCatalog` resolves all 7 rows and the agent run works. Cosmetic;
  worth an upstream look.
- Two harmless `[claude-multi] no accounts configured` warnings appear on
  passes that load the plugin without `pluginConfig` (e.g. install-time
  registration probe). The config-bearing pass registers everything.
- **Human operator step (intentionally not done):** add
  `claude-icloud/claude-fable-5` to `agents.defaults.model.fallbacks` (as
  first fallback before the Opus tier drop) and live-test failover by
  exhausting the main account's Fable pool.
- Roadmap: `oauthTokenRef` secret-manager resolution (v0.3), N-account
  ordering/cooldowns (v0.2), publish to npm/ClawHub (v1.0).
