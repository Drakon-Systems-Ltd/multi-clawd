# BUILD_RESULT — multi-clawd model resolution fix

Date: 2026-07-13 · Gateway: openclaw 2026.6.11 · Result: **PASS — gate 3 output present below**

Fix per FIX_BRIEF.md. No gateway restart performed. No changes to
`~/.openclaw/openclaw.json` (failover chain, `auth.order`,
`agents.defaults.models`/`fallbacks` untouched).

## 1. SDK finding: the registration API that feeds the resolver

The prior session's claim that `registerProvider` + `augmentModelCatalog` makes
models resolvable was wrong. `augmentModelCatalog` feeds only the model
*catalog list* (`loadModelCatalog` →
`augmentModelCatalogWithProviderPlugins`, `dist/model-catalog-7IG2nf1t.js:488`),
which the run-time model **resolver never reads**.

How the resolver actually looks up `<provider>/<model>` (all paths read, host
files under `~/.npm-global/lib/node_modules/openclaw/dist/`):

1. **Inline configured models** — `cfg.models.providers[<provider>].models[]`;
   requires `api` + `baseUrl` (`model-CN-U_f16.js:596`
   `resolveExplicitModelWithRegistry`, `:600` `findInlineModelMatch`).
2. **Model registry** — `models.json` plus generated plugin catalogs at
   `<agentDir>/plugins/<pluginId>/catalog.json` (`sessions-JU-Nr-nC.js:1404`
   `loadCustomModels`, `plugin-model-catalog-C26wDCJp.js:43`). Rows without
   `baseUrl` are skipped (`sessions-JU-Nr-nC.js:1475-1476`), so
   baseUrl-less CLI models can never come from here.
3. **Plugin dynamic-model hook** — `resolvePluginDynamicModelWithRegistry`
   (`model-CN-U_f16.js:760`) → `runProviderDynamicModel`
   (`provider-runtime-Cb_NPY4Q.js:72`) →
   `resolveProviderRuntimePlugin(params)?.resolveDynamicModel?.(ctx)`. The
   plugin is located by provider ref through the manifest registry
   (`provider-hook-runtime-CPEpF8QC.js:144` `resolveProviderRuntimePlugin` →
   `providers.runtime-f_X2tHZm.js:229` `resolvePluginProviders`), which loads
   **installed extensions** with their real `plugins.entries[<id>].config`.
4. **Bundled manifest static catalog** — `resolveBundledStaticCatalogModel`
   (`model.static-catalog-BxAHakWS.js:253`). This is how the bundled Anthropic
   plugin makes `claude-cli/*` resolvable without baseUrl/API key: its
   `openclaw.plugin.json` declares `modelCatalog.providers["claude-cli"].models[]`
   with `discovery: {"claude-cli": "static"}`
   (`dist/extensions/anthropic/openclaw.plugin.json`). **But this path is
   gated to bundled plugins only**: `listBundledStaticCatalogPlugins` filters
   `record.origin !== "bundled"` (`model.static-catalog-BxAHakWS.js:177-188`),
   so an installed extension cannot use it.

Conclusion: for a non-bundled extension, the only registration that reaches
the resolver is the **`resolveDynamicModel` hook on the registered
`ProviderPlugin`** (SDK type:
`node_modules/openclaw/dist/plugin-sdk/types-CR1WAXpo.d.ts:8372`, documented
hook order at `:8365`: "1. discovered/static model lookup → 2. plugin
`resolveDynamicModel` → 3. core fallback heuristics").

Transport detail: the local `infer model run` path is a simple-completion API
call, not a CLI-backend run (`capability-cli-DybprSCF.js:607-641`), so the
resolved model mirrors the bundled plugin's forward-compat shape
(`register.runtime-7pKgaaME.js:166-191` `buildAnthropicForwardCompatModel`):
`api: "anthropic-messages"`, `baseUrl: "https://api.anthropic.com"`. The
account's `sk-ant-oat…` setup token gets the OAuth beta headers automatically
(`provider-stream-B5ruZ4qc.js:115,130`). Full agent turns still route through
the CLI backend (`isCliProvider`, `model-selection-dHF0ko3X.js:57` — true via
`registerCliBackend` + manifest `cliBackends`).

## 2. Diff to src/index.ts (manifest unchanged)

```diff
diff --git a/src/index.ts b/src/index.ts
index 41f3ed2..e1176b0 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -8,14 +8,18 @@
  * - `api.registerCliBackend(...)` mirrors the bundled `claude-cli` backend
  *   (same argv, jsonl stream parsing, `bundleMcp` claude-config-file bridge,
  *   always-on native tools, native compaction) but scoped to one account id.
- * - `registerCliBackend` does NOT contribute a model catalog. Like the bundled
- *   Anthropic plugin (which registers the `claude-cli` catalog through its
- *   provider's `augmentModelCatalog` hook), we register a minimal
- *   `ProviderPlugin` per account whose `augmentModelCatalog` returns the
- *   Claude CLI model rows under the account's provider id. This is what makes
- *   `claude-icloud/claude-fable-5` resolvable without any `baseUrl`/API key.
- *   (Requires the manifest to declare a non-empty `providers` list plus
- *   `modelCatalog.runtimeAugment: true` so the catalog hook loads the plugin.)
+ * - `registerCliBackend` does NOT contribute a model catalog. The bundled
+ *   Anthropic plugin makes `claude-cli/*` resolvable through its manifest
+ *   `modelCatalog.providers` static rows — but the resolver only reads
+ *   manifest static rows from plugins with origin "bundled"
+ *   (model.static-catalog listBundledStaticCatalogPlugins), so an installed
+ *   extension cannot use that path. Instead we register a minimal
+ *   `ProviderPlugin` per account that implements `resolveDynamicModel` —
+ *   the plugin dynamic-model hook the resolver consults on every lookup
+ *   (resolvePluginDynamicModelWithRegistry → runProviderDynamicModel). This
+ *   is what makes `claude-icloud/claude-fable-5` resolvable without any
+ *   `baseUrl`/API key. `augmentModelCatalog` additionally feeds the model
+ *   catalog list (`openclaw models list`).
  * - `prepareExecution(ctx)` injects the account's own login into the child
  *   process env (`CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_OAUTH_TOKEN`). The runner
  *   applies `clearEnv` to the host env first and merges prepared env after,
@@ -33,6 +37,7 @@ import {
   type CliBackendPreparedExecution,
 } from "openclaw/plugin-sdk/cli-backend";
 import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
+import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
 import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
 import { homedir } from "node:os";
 import { readFileSync } from "node:fs";
@@ -128,6 +133,17 @@ const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
   "claude-haiku-4-5": 200000,
 };
 
+/** Mirrors the bundled anthropic manifest maxTokens per model. */
+const MODEL_MAX_TOKENS: Record<string, number> = {
+  "claude-opus-4-8": 128000,
+  "claude-opus-4-7": 64000,
+  "claude-opus-4-6": 64000,
+  "claude-sonnet-4-6": 64000,
+  "claude-sonnet-5": 64000,
+  "claude-fable-5": 128000,
+  "claude-haiku-4-5": 64000,
+};
+
 const MODEL_NAMES: Record<string, string> = {
   "claude-opus-4-8": "Claude Opus 4.8",
   "claude-opus-4-7": "Claude Opus 4.7",
@@ -160,6 +176,54 @@ function resolveToken(account: AccountConfig): string {
   );
 }
 
+/** Canonicalize a requested model id via the CLI alias table. */
+function canonicalModelId(modelId: string): string | undefined {
+  const trimmed = modelId?.trim();
+  if (!trimmed) return undefined;
+  const aliased = MODEL_ALIASES[trimmed] ?? trimmed;
+  return (MODEL_IDS as readonly string[]).includes(aliased) ? aliased : undefined;
+}
+
+/**
+ * Runtime model record for the resolver's plugin dynamic-model hook.
+ * Mirrors the bundled anthropic plugin's forward-compat model shape
+ * (buildAnthropicForwardCompatModel): anthropic-messages transport against
+ * api.anthropic.com. Full agent turns never use that transport — the run
+ * executor routes this provider through the CLI-backend registry
+ * (isCliProvider) and drives the Claude Code subprocess — but the local
+ * simple-completion transport (`openclaw infer model run`) calls the
+ * Anthropic API directly with this account's setup token (sk-ant-oat…
+ * tokens get the OAuth beta headers automatically).
+ */
+function buildRuntimeModel(
+  account: AccountConfig,
+  modelId: string,
+): ProviderRuntimeModel | undefined {
+  const id = canonicalModelId(modelId);
+  if (!id) return undefined;
+  const label = account.label ?? account.id;
+  const maxSidePx =
+    id === "claude-opus-4-8" || id === "claude-opus-4-7" ? 2576 : 1568;
+  return {
+    id,
+    name: `${MODEL_NAMES[id] ?? id} (${label})`,
+    provider: account.id,
+    api: "anthropic-messages",
+    baseUrl: "https://api.anthropic.com",
+    reasoning: true,
+    input: ["text", "image"],
+    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
+    contextWindow: MODEL_CONTEXT_WINDOWS[id] ?? 200000,
+    maxTokens: MODEL_MAX_TOKENS[id] ?? 64000,
+    ...(id === "claude-fable-5"
+      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
+      : {}),
+    mediaInput: {
+      image: { maxSidePx, preferredSidePx: maxSidePx, tokenMode: "provider" },
+    },
+  };
+}
+
 function buildCatalogEntries(account: AccountConfig): ModelCatalogEntry[] {
   const label = account.label ?? account.id;
   return MODEL_IDS.map((id) => {
@@ -263,6 +327,12 @@ function buildCatalogProvider(account: AccountConfig): ProviderPlugin {
       }
     },
     augmentModelCatalog: () => buildCatalogEntries(account),
+    // The hook the model resolver actually consults for provider-owned model
+    // ids that are absent from models.json / generated catalogs. Manifest
+    // modelCatalog static rows only resolve for bundled plugins, so an
+    // installed extension must answer here (resolvePluginDynamicModelWithRegistry
+    // → runProviderDynamicModel → this hook).
+    resolveDynamicModel: (ctx) => buildRuntimeModel(account, ctx.modelId),
   };
 }
```

`openclaw.plugin.json` was **not** changed (it already declared
`providers: ["claude-icloud"]` and `cliBackends: ["claude-icloud"]`).

Rebuilt with `npm run build` (clean) and reinstalled by copying `dist/`,
`openclaw.plugin.json`, `package.json` into `~/.openclaw/extensions/multi-clawd/`.

## 3. Verbatim gate-3 output (exit code 0)

Command:

```
timeout 180 openclaw infer model run --model "claude-icloud/claude-fable-5" --prompt "Reply with exactly: ICLOUD_FABLE_OK"
```

Full verbatim output (captured to `/tmp/icloud-proof.txt`, `exit=0`):

```
[state-migrations] Legacy state migration warnings:
- Left legacy config health state in place because 1 entry conflicts with shared SQLite state: /home/ubuntu/.openclaw/logs/config-health.json
│
◇  Doctor warnings ──────────────────────────────────────────────────────╮
│                                                                        │
│  - Left legacy config health state in place because 1 entry conflicts  │
│    with shared SQLite state:                                           │
│    /home/ubuntu/.openclaw/logs/config-health.json                      │
│                                                                        │
├────────────────────────────────────────────────────────────────────────╯
[plugins] [multi-clawd] no accounts configured — nothing to register
model.run via local
provider: claude-icloud
model: claude-fable-5
outputs: 1
ICLOUD_FABLE_OK
```

(The `[multi-clawd] no accounts configured` line is the harmless metadata
pre-pass documented in FIX_BRIEF.md — the real registration pass runs with the
configured accounts.)

The run before the transport fix proved resolution independently: with a
placeholder `api: "openai-responses"` the same command failed with an OpenAI
401 (not "Unknown model"), i.e. `resolveDynamicModel` was already feeding the
resolver; switching the returned transport to
`anthropic-messages`/`api.anthropic.com` made the completion succeed.

## 4. Gate-4 catalog check

```
$ openclaw models list | grep claude-icloud
claude-icloud/claude-fable-5               text       195k        no    no    configured
```

## Notes for the final (user-driven) gateway restart

- The long-lived gateway process still runs the old plugin code; it picks up
  the fixed extension on its next restart. Nothing in this fix requires config
  changes.
- Full agent turns through the failover chain route via the CLI backend
  (Claude Code subprocess with `CLAUDE_CONFIG_DIR=~/.claude-icloud` +
  `CLAUDE_CODE_OAUTH_TOKEN`); only the lightweight `infer model run` /
  simple-completion path talks to api.anthropic.com directly with the same
  token.
