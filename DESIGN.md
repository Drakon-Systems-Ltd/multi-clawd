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

## The pool (v0.2): proactive near-limit rotation

Michael's requirement: roll to the second account when the first is **nearly**
maxed out (not after it hard-fails), and when both accounts / Anthropic are
down, let the chain drop to OpenAI then xAI. Reactive failover alone can't do
"nearly" — it needs a usage signal and a pre-error decision point.

### The usage signal

The Claude CLI's stream-json output emits an undocumented top-level
`rate_limit_event` record after each turn (verified live 2026-07-15,
cross-checked with Jarvis's 13-Jul captures):

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed_warning",       // allowed | allowed_warning | rejected
  "resetsAt":1784595600,            // epoch seconds
  "rateLimitType":"seven_day",      // five_hour | seven_day | ...
  "utilization":0.3,                // 0..1 (absent on some windows)
  "isUsingOverage":false}}
```

Fields vary by account/window (Jarvis's sample had `overageStatus`; ours had
`utilization`) — hence the tolerant parser in `shim-core.ts`: unknown
statuses/windows pass through, missing fields are fine, junk is ignored.

**OpenClaw never parses this record** (verified against 2026.7.1 internals:
the CLI runner extracts only token usage and error text). So the plugin
captures it itself: the backend spawns `dist/shim.js` (a transparent wrapper)
instead of `claude` directly. The shim passes stdin/stdout/stderr/argv/exit
through untouched — passthrough always wins over capture — and folds each
event into `~/.openclaw/state/multi-clawd/<account>.json`.

### The decision point: prepareExecution, not hooks

Plugin lifecycle hooks were the obvious mechanism and they do not work
(verified empirically on 2026.7.1, gateway RPC turns):

- `before_model_resolve` (returns `providerOverride`/`modelOverride`) is a
  **conversation hook**: non-bundled plugins need
  `plugins.entries.<id>.hooks.allowConversationAccess=true` — and even with
  that granted, the hook **never fires** for gateway RPC turns; the
  `resolveHookModelSelection` path that consults it is not reached
  (`session_start` from the same plugin fires fine).
- `before_agent_start` (legacy, same override fields) fires — but from the
  **prompt-build** call site (`agent-harness-runtime`), which ignores
  override fields. Its model-resolve call site never ran.

So rotation lives where the plugin has guaranteed, every-turn control:
`prepareExecution` on a dedicated **pool backend** (`pool.id`, default
`clawd`). Per launch it classifies each pooled account from its health file
and injects the login env of the first usable one:

- `rejected` + future `resetsAt` → **exhausted**, skipped (auto-unbinds when
  the reset passes — the home account reclaims the pool with no timer).
- any window `utilization >= utilizationThreshold` (default 0.85) →
  **near_limit**, skipped while a healthier account exists.
- `allowed_warning` alone does NOT rotate: the seven-day window warns at 0.3
  utilization in practice; only the utilization number is trusted.
- missing/stale health (default > 6 h) → **no_data**, treated as healthy:
  rotate only on positive evidence.
- whole pool exhausted → home account anyway, so the launch fails with a
  real limit error and OpenClaw's reactive chain drops provider
  (OpenAI → xAI), exactly as configured.

Trade-off: `CliBackendPrepareExecutionContext` has no session id, so
selection is stateless; a mid-conversation handover loses the Claude CLI's
native session (it lives in the previous account's config dir) and OpenClaw's
fresh-session retry recovers the turn. Rotation only happens at limit
boundaries, so this is rare by construction. Sticky per-session selection is
v0.3 material.

### Native accounts

`"native": true` pools the machine's main login without copying credentials.
Crucial macOS detail: the OS keychain is only consulted when
`CLAUDE_CONFIG_DIR` is **unset** — pointing it at `~/.claude` explicitly
switches the CLI to file-based credentials and fails with "Not logged in".
Native accounts therefore set neither the config dir nor a token.

### Future-proof model resolution

Nothing is gated on a hardcoded model list (the flagship subscription model
is expected to change, e.g. Fable 5 → Opus 5):

- `resolveDynamicModel` accepts **any** modern lowercase `claude-*` id
  (mirroring core's own Anthropic forward-compat resolver); known ids get
  real specs, unknown ones conservative defaults (200k ctx / 64k out).
- `augmentModelCatalog` mirrors the bundled claude-cli catalog **live** at
  catalog-build time (`dist/extensions/anthropic/cli-catalog.js`, resolved
  by file path since the exports map hides it), falling back to a built-in
  list when unavailable. New models OpenClaw ships appear on our backends
  automatically.
- Per-account `models` / `defaultModel` config provides operator overrides.

### Eviction (openclaw#107408): why there is no in-process fix

Verified against the 2026.7.1 loader: `register()` runs once, synchronously,
during registry build; `registerCliBackend`/`registerProvider` are **not**
late-callable (the guarded api proxy silently no-ops them after close);
there is no registry-rebuilt event, no timer hook, and no plugin API that
forces a rebuild. The eviction is a *narrower registry snapshot becoming
active*, not a removal — recovery is a full-scope rebuild (gateway restart
re-runs `register()`). Hence `scripts/eviction-watchdog.mjs` (log-signature →
restart, once per event) until upstream PR openclaw#107596 lands.

## v0.3: hardening (fleet-feedback release)

Built from the 15-Jul fleet feedback round (Jarvis, Case, Edith, Athena,
Vision). Everything below is unit-tested; base includes 7089c88 (shim
window-persistence fix — a five_hour-only turn no longer erases the last
seven_day utilization; windows merge and expire individually, 24h default).

### oauthTokenRef — no plaintext tokens

`accounts[].oauthTokenRef` takes the same `{source, provider, id}` shape as
every other secret in openclaw.json and resolves through the gateway's own
configured secret providers (`resolveSecretRefValues` from the plugin SDK).
Launch path resolves async with an in-memory TTL cache (5 min — provider
rotation is picked up on expiry); sync surfaces (resolveSyntheticAuth) peek
the warm cache. Failures degrade only that account, are never thrown, never
cached, and are logged with a fixed reason code
(`credential_resolution_failed (ErrorClass)`) — no token values, no ref
metadata, no provider text (Case's three leak classes, all tested). Token
sources are mutually exclusive per account; violations warn loudly with
deterministic precedence (native > file > ref).

### Sticky pool selection

Once the pool rotates away from home, it stays on the rotated-to account for
`pool.minDwellMs` (default 10 min) before returning home — so turns don't
flap across the utilization threshold and mid-conversation session loss
happens at most once per rotation event. HEALTH BEATS STICKINESS: dwell only
delays the benign direction (returning home); a sticky account that degrades
is abandoned immediately. Sticky state persists at
`state/multi-clawd/pool-<id>.sticky.json` and survives gateway restarts.

### Operator alerts + login-health probes

- Alerts ride the agent's own heartbeat (`heartbeat_prompt_contribution`
  hook, prompt-injection class — not conversation-gated), so they reach the
  operator via the normal channel (e.g. Telegram) instead of dying as
  journal lines. Errors persist 6h, info 30min, deduped by key.
- A 15-min login-health probe checks each account's credential *source*
  (file shape / macOS keychain presence / credentials.json access token /
  ref resolution) without spending quota, and raises an alert on the
  ok→broken transition — registration success no longer masks dead logins
  (the aiquant silent-login-death class).
- **Ref-backed probe failure classification (v0.3.x).** A `oauthTokenRef`
  probe no longer declares a login dead on the first empty resolve: a
  transient provider outage (op timeout, ENETUNREACH — `resolveDetailed`
  returns `provider_error`) marks the account **degraded** (one info line,
  no alert) and retries, and is only declared broken after **3 consecutive
  provider-error probes AND ≥10 min** since the streak's first failure (both,
  so a fast burst can't trip a false alert). A resolver that *ran* and
  returned nothing/non-string (`empty_result`) is a credential problem and
  breaks immediately. Success resets the streak and clears degraded; recovery
  clears the alert from either degraded or broken. The tracker
  (`createRefProbeTracker`) is pure and tested; gate-2 redaction is preserved
  end-to-end (only error *class* names ever reach a log line).
- Pool rotations, return-home events, and whole-pool exhaustion raise alerts
  too; the out-of-process watchdog appends to
  `state/multi-clawd/alerts-spool.jsonl`, ingested at each heartbeat.

### Turn-safe eviction watchdog (Jarvis's lane-guard pattern)

`scripts/eviction-watchdog.mjs` now defers restarts while work is in flight,
detected two ways: any agent session transcript written within 180s (all
agents, not just main), or a live pid in the opt-in
`$MULTI_CLAWD_WORKER_PID_DIR` (catches long tool calls whose transcripts go
quiet). Pending evictions persist in `watchdog.json` (survive log rotation);
MAX_DEFER 15 min forces the restart anyway — the backends are already
broken, endless deferral protects nothing; RESTART_COOLDOWN 10 min sits on
top of once-per-eviction dedupe; missing evidence never restarts; every
restart is operator-notified via the alert spool. Decision core is pure and
tested (`src/watchdog-core.ts`).

### Doctor + installer sanity

- `npm run doctor` (`scripts/doctor.mjs`): one command that says whether a
  box is actually ready — manifest/config key agreement (prints the exact
  strip plan for the --force trap; `--preflight`), dist freshness, claude
  CLI presence, per-account credential health (values never printed),
  telemetry state ages, pool membership + sticky, watchdog presence, and an
  optional `--probe` end-to-end turn.
- `npm install` now triggers `prepare` → build, killing the
  stale-gitignored-dist failure class after every pull.

### Known v0.3 limitations (on the record)

- Same-account **concurrent** shim writes are not synchronized: the
  window-persistence fix is read-merge-atomic-rename, which closes the
  sequential-overwrite defect but is not concurrency coverage (Case). The
  corrupt-state preservation below does not change this: two truly concurrent
  shims for the same account still race read→write, **last-rename-wins** drops
  whichever event lost the race. Full concurrency coverage is v0.4 work.
- **Corrupt state-file preservation (v0.3.x).** `readPersistedState` used to
  swallow *all* read/parse failures and start fresh, so a corrupt or
  unreadable state file silently erased the last seven_day observation with
  zero trace (the disappearance-autopsy gap). It now distinguishes ENOENT
  (benign — silent fresh start) from exists-but-unreadable/unparseable via the
  pure `classifyStateReadFailure`: on the bad path it writes an operator note
  to stderr and best-effort preserves the original bytes to a
  `<state>.corrupt-<ts>` sidecar (mode 0600) for autopsy, swallowing any error
  in the preserve step itself, then starts fresh. The invariant stands — a
  broken state file must never break a live turn.
- **Unknown / unrecognized window kinds (v0.3.x).** The CLI has been observed
  emitting a `rate_limit_event` with no usable `rateLimitType` (missing or
  non-string); it lands under the fallback window key `"unknown"`. This is
  handled **conservatively by construction**, not by special-casing the key:
  - A `rejected` status with no *future* `resetsAt` never rotates the pool —
    so an unknown-kind rejection with no reset cannot trigger a spurious
    rotation.
  - `utilization >= threshold` DOES count as `near_limit` even for unknown
    kinds — positive evidence of pressure is honoured regardless of the window
    key. A real limit we can't name still steers us away.
  This asymmetry (ignore ambiguous negatives, honour concrete positives) is
  deliberate. Two v0.3.x diagnostics support autopsy without changing this
  behaviour: `parseRateLimitEvent` captures the raw `rate_limit_info` as
  compact JSON (`rawInfo`, capped 512 chars) whenever the kind is unusable, and
  it rides through to the persisted window entry; and `mergeHealthStates`
  prunes any window whose newest observation predates `PRUNE_AFTER_MS`
  (default 14 days), run *after* the merge so a window is aged by its freshest
  `seenAt` — this stops junk `"unknown"` buckets from accreting in the file
  forever.
- Five-hour windows never carry a utilization number (fleet-wide
  observation), so proactive rotation can only fire on weekly windows; a
  locally-derived 5h signal (per-account turn counting) is v0.4 design work.
- Sticky selection is per-pool, not per-session — OpenClaw's
  `prepareExecution` context has no session id. True session affinity is
  part of the v0.4 standalone-proxy track (Hermes runtimes).

## v0.3.5: tier-aware degradation + pinned lanes

Edith's fleet-feedback features. When the WHOLE pool is exhausted, a launch
steps down the configured same-provider ladder (e.g. Fable 5 → Opus 4.8) on
the least-bad account instead of hard-failing to the next provider. Rules:

- While ANY pooled account can still serve the requested tier, rotation wins
  — degradation is strictly the last step before provider drop.
- Requests already at/below the ladder never degrade further.
- Pinned lanes (agent-dir / workspace-dir substring matchers) never degrade:
  contractual "always this model" lanes fail over via the chain instead.
- Single-account pools are allowed when a ladder is configured — the pool
  then exists purely for tier policy on that one account, which replaces
  bespoke "switch to Opus at 95%" watchers on single-account hosts.

Mechanics: the decision lives in the pool's `prepareExecution` (it has the
requested `modelId` + pool health); the swap is enforced by the shim
rewriting `--model` in its own argv (`MULTI_CLAWD_MODEL_OVERRIDE`).
`resolveExecutionArgs` was investigated and rejected: the runner appends
`--model <requested>` AFTER hook-provided argv, and last-wins parsing would
override any injected model. The shim is the process we own, so the rewrite
is race-free there and works on resume launches too. Degraded launches log
and raise an operator alert (`degrade:<poolId>`), and turns keep full session
continuity — same account, same config dir, different tier.

Note the chain-level dual: successive fallbacks `clawd/claude-fable-5 →
clawd/claude-opus-4-8` (as aiquant runs) achieve tier degradation for
multi-account pools reactively. Pool-internal degradation adds the
single-account case, pin exemptions, and one fewer failed launch.

## v0.3.6: reactive model-limit capture + model-aware health

Root cause fix for the 17–18 Jul incident (Fable weekly max-out did not flip
accounts on two of three boxes). The gap: weekly windows are only written
when turns run on an account near its limit, so a quiet home account has NO
weekly telemetry — proactive rotation is blind, and the reactive 429 steps
the chain PAST the pool with no second chance on the other account.

Fix, two halves:

- **The 429 IS telemetry.** The shim recognises the reactive limit error
  ("You've reached your Fable 5 limit…" on a genuine error record — quoted
  text in successful results does not trigger) and records a
  **model-scoped** rejected window (`model:<canonical-id>`, keyed by the
  shim's own effective argv model, which is authoritative even under
  degradation rewrites). Reset time reuses the account's fresh weekly
  window when present; otherwise a 60-min TTL governs at read time.
- **Health is model-aware.** `classifyAccountHealth` takes the requested
  model: `model:*` windows gate only matching requests — exhausted-for-Fable
  does not stop the account serving Opus. Account-level windows behave as
  before.

Result: even with zero prior telemetry, the FIRST 429 teaches the pool, and
the next launch for that model rotates to the other account. The turn that
hit the 429 itself still escapes to the chain (OpenClaw offers no in-turn
retry of the same chain entry) — one degraded turn per limit event is the
accepted cost; every subsequent turn account-flips.

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
            { "id": "claw1", "label": "Main Claude", "native": true },
            {
              "id": "claw2",
              "label": "Second Max",
              "configDir": "~/.claw2",
              "oauthTokenFile": "~/.claw2/oauth-token"
            }
          ],
          // optional: pooled backend with proactive near-limit rotation
          "pool": { "id": "clawd", "accounts": ["claw1", "claw2"] }
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
   the reply is served by the second account's backend on **Fable**, not by a tier drop to
   Opus (gateway log: `next=claw2/claude-fable-5`, no model-tier drop).

## Roadmap

- v0.1 — single extra account, verified end-to-end.
- v0.2 — N accounts, round-robin/priority ordering, per-account cooldown surfacing.
- v0.3 — `oauthTokenRef` secret-manager resolvers (1Password), setup helper
  (`claude setup-token` capture into an isolated dir).
- v1.0 — npm + ClawHub parity release (publishes as a ClawHub PLUGIN, not
  a skill). Trigger: after the aiquant rollout closes out. Release gates:
  - `npm pack --dry-run` contents check: `scripts/doctor.mjs` and
    `scripts/eviction-watchdog.mjs` must ship in the tarball (files list
    fixed 16 Jul 2026; verify anyway before the tag).
  - `clawhub package publish --dry-run` clean before the tag.
  - npm ↔ ClawHub same-day parity: whoever triggers the manual npm publish,
    the ClawHub publish lands the same day (Jarvis holds the ClawHub side).
  - Rollout docs must state the upgrade sequence pull → npm install →
    npm run build → doctor (prepare hook not trusted on the pull path).
