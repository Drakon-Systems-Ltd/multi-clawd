# multi-clawd — fix brief (model catalog resolution)

## Goal
Make `claude-icloud/claude-fable-5` **resolve and run** through the registered
plugin backend, so it can sit in the OpenClaw failover chain right after main-Fable.

## Root cause (already diagnosed — do NOT re-litigate)
- The plugin loads. `register(api)` is called TWICE per process:
  1. a metadata pre-pass with `api.pluginConfig = {}` → logs the harmless
     `[multi-clawd] no accounts configured` warning. IGNORE THIS — it is not the bug.
  2. the real pass with `api.pluginConfig = {accounts:[{id:"claude-icloud",...}]}` →
     this pass DOES run `api.registerCliBackend(...)` and `api.registerProvider(...)`.
- So account wiring works. **The actual failure is model resolution:**
  ```
  openclaw infer model run --model "claude-icloud/claude-fable-5" --prompt "hi"
  → Error: Unknown model: claude-icloud/claude-fable-5.
    Found agents.defaults.models["claude-icloud/claude-fable-5"], but no matching
    models.providers["claude-icloud"].models[] entry.
  ```
- i.e. the resolver looks for the model under `models.providers[<prefix>].models[]`.
  The plugin currently supplies rows via a `ProviderPlugin.augmentModelCatalog()` hook
  (see `src/index.ts` buildCatalogProvider / buildCatalogEntries), and that hook is NOT
  reaching the resolver. `registerProvider` + `augmentModelCatalog` is insufficient OR
  wired wrong.

## The one question to answer
How does the **bundled Anthropic plugin** make `claude-cli/*` models (e.g.
`claude-cli/claude-fable-5`) resolvable WITHOUT a `baseUrl`/API key — and mirror that
exact mechanism for the `claude-icloud` provider prefix.
- Relevant host files (READ them, do not guess):
  - `~/.npm-global/lib/node_modules/openclaw/dist/cli-catalog-DrFnMS-C.js`
  - `~/.npm-global/lib/node_modules/openclaw/dist/model-catalog-7IG2nf1t.js`
  - `~/.npm-global/lib/node_modules/openclaw/dist/api-builder-CX43eAAh.js`
    (compare `registerProvider` vs `registerModelCatalogProvider` vs
     `registerModelCatalog` — pick the one the resolver actually reads)
  - the module that emits the "Unknown model … models.providers[].models[]" error —
    grep the dist for that string to find the resolver and see which registry it reads.
- The bundled backend proves a baseUrl-less provider is possible; find the registration
  call that gives claude-cli its catalog and replicate it for `claude-icloud`.

## Hard constraints
- Do **NOT** touch the live gateway failover chain, `auth.order`, or
  `agents.defaults.models`/`fallbacks` in `~/.openclaw/openclaw.json`.
- Do **NOT** restart the main gateway (`openclaw gateway restart`). Jarvis does the
  single final restart with the user.
- Work only in this repo, rebuild, reinstall the plugin extension, and test via the
  throwaway harness below.
- The isolated iCloud login is at `CLAUDE_CONFIG_DIR=$HOME/.claude-icloud` with token
  `$HOME/.claude-icloud/oauth-token`. The account config is already in
  `~/.openclaw/openclaw.json` under `plugins.entries["multi-clawd"].config.accounts`.

## Reinstall + test loop (no gateway bounce)
```
# rebuild
cd /home/ubuntu/clawd/projects/multi-clawd && npm run build
# reinstall the built plugin into the extensions dir OpenClaw loads from
#   installed at: ~/.openclaw/extensions/multi-clawd/  (copy dist/ + manifest + package.json + node_modules)
# then the DECISIVE test — must succeed:
openclaw infer model run --model "claude-icloud/claude-fable-5" --prompt "Reply with exactly: ICLOUD_FABLE_OK"
```
PASS = that command prints `ICLOUD_FABLE_OK` (proves resolve + iCloud login + run).

## Evidence gates (MANDATORY — a prior session falsely claimed success)
Write `BUILD_RESULT.md` containing:
1. The SDK finding: the exact host registration API that feeds the resolver, with the
   file:line you read it from.
2. The diff you made to `src/index.ts` (and manifest if changed).
3. The VERBATIM terminal output of the `openclaw infer model run` command showing
   `ICLOUD_FABLE_OK`.
4. Verify the model still resolves via `openclaw models list | grep claude-icloud`.
Do NOT write "verified" or "works" anywhere unless gate 3 output is present and real.
If you cannot get gate 3 to pass, say so plainly and report what blocks it.
