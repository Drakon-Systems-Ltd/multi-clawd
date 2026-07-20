<div align="center">

<img src="assets/multi-clawd-hero.jpg" alt="multi-clawd — the lobster with two extra claws" width="760">

# 🦞 multi-clawd

**One Claude is never enough.**

Pool every Claude Max account you own into a single failover chain —
same model, next account, full harness on every hop.

[![OpenClaw plugin](https://img.shields.io/badge/OpenClaw-plugin-ff4f00)](https://docs.openclaw.ai/plugins)
[![npm](https://img.shields.io/badge/npm-%40drakon--systems%2Fmulti--clawd-cb3837)](https://www.npmjs.com/package/@drakon-systems/multi-clawd)
[![version](https://img.shields.io/badge/version-1.0.1-4c9aff)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.json)

*A normal lobster has two claws. This one has four.*

</div>

---

## Why

OpenClaw's bundled `claude-cli` backend runs Claude Code on a **single**
login. When that account hits its usage limit, OpenClaw can't move the
running subprocess onto your second Claude account — it drops down to the
next *model* instead. If you own two Claude Max accounts, the second one's
capacity just sits there, idle, while you get downgraded.

**multi-clawd fixes that.** Each extra account becomes its own first-class
backend that slots into the failover chain like any other model — so a limit
on account #1 rolls to account #2 *on the same model* before any tier drop:

```
claude-cli/claude-fable-5        # main login
  → claw2/claude-fable-5         # 2nd login (this plugin) — same model
    → claw3/claude-fable-5       # 3rd login? go on then
      → anthropic/claude-opus-4-8   # only NOW drop a tier
```

## What you get

- 🦞 **Extra claws** — every account registers as a real CLI backend
  (`claw2/…`, `claw3/…`), resolvable in model refs, fallback chains, and
  per-agent overrides. No API keys, no `baseUrl` hacks.
- 🎱 **The pool (v0.2)** — one backend id (`clawd/…`) fronting all your
  accounts. Every launch runs on the first account that is **not nearly
  maxed out**, using live `rate_limit_event` health (status, utilization,
  reset time) captured from each account's own Claude stream. Hand over
  *before* the limit error; return home automatically when the window
  resets; when the whole pool is exhausted, fail for real so your chain
  drops provider (OpenAI → xAI → …) exactly as configured.
- 📈 **Usage-aware accounts** — a transparent shim tees each account's
  stream-json and records per-window health to
  `~/.openclaw/state/multi-clawd/<account>.json`. Passthrough-first: a state
  write can never break a live turn.
- 🧰 **Full harness on every hop** — each backend is a genuine Claude Code
  subprocess: native tools, skills, MCP bridge, and native compaction all
  stay intact when failover steps across accounts.
- 🔮 **Future-proof models (v0.2)** — model ids are not hardcoded: the
  catalog mirrors the bundled claude-cli list live (with a built-in
  fallback), and *any* modern `claude-*` id resolves on demand. When the
  flagship subscription model changes (Fable 5 → Opus 5), `clawd/claude-opus-5`
  just works — no plugin update.
- 🏠 **Native accounts (v0.2)** — `"native": true` pools the machine's main
  Claude login (default config dir / OS keychain) without duplicating its
  credentials.
- 🔐 **Token hygiene** — setup-tokens are read at launch and passed only via
  the child process env. Never committed, never logged. **v0.3:**
  `oauthTokenRef` resolves tokens through the gateway's own secret providers
  (1Password etc.) — same `{source, provider, id}` shape as the rest of
  openclaw.json, no plaintext files, fixed-reason-code redaction on failure.
- 🧲 **Sticky rotation (v0.3)** — after handing over, the pool dwells on the
  spare account (default 10 min) before returning home, so turns never flap
  across the threshold. Health always overrides stickiness.
- 📟 **Operator alerts (v0.3)** — dead logins (probed every 15 min without
  spending quota), pool rotations, whole-pool exhaustion, and watchdog
  restarts surface through your agent's next heartbeat (e.g. straight into
  Telegram) — not just journal lines.
- 🩺 **`npm run doctor` (v0.3)** — one command that says whether a box is
  actually ready: config/manifest agreement (with the exact `--force`
  preflight strip plan), dist freshness, CLI presence, credential health
  (values never printed), telemetry age, pool + sticky state, watchdog
  presence, optional `--probe` end-to-end turn.
- 🧯 **Self-healing config** — registration re-reads the resolved runtime
  config if the loader hands it an empty block, so a flaky registration pass
  can't silently no-op the plugin.
- 🔎 **Observable registration** — every `register()` pass logs which config
  source won and which backends it registered, so a silent no-op can't hide
  in a long-running gateway.
- 🐶 **Turn-safe eviction watchdog** — `scripts/eviction-watchdog.mjs`
  mitigates upstream openclaw#107408 (idle plugin backends silently dropped)
  by restarting the gateway when the `Unknown CLI backend` signature
  appears. **v0.3:** it defers while any turn is in flight (transcript
  activity across all agents + opt-in worker pidfiles), with a 15-min defer
  cap and 10-min restart cooldown — a restart can no longer eat a live
  reply.

## Platform support

multi-clawd is pure Node (no native modules, no shell-outs) and mirrors the
bundled `claude-cli` backend 1:1 — it runs anywhere OpenClaw's normal Claude
Code backend runs.

| Platform | Status |
|---|---|
| Linux | ✅ Verified in production (x64 and arm64) |
| macOS | ✅ Supported — no platform-specific code paths |
| Windows (WSL2) | ✅ Supported — OpenClaw's recommended gateway runtime on Windows; follow the Linux instructions inside WSL |
| Windows (native) | ⚠️ Expected to work (the gateway spawns `claude` for this plugin exactly as it does for the bundled backend), not yet verified by us — reports welcome |

## Install

**From npm (recommended):**

```bash
openclaw plugins install @drakon-systems/multi-clawd --pin
openclaw gateway restart
```

The gateway pulls the prebuilt package — no clone, no build step, nothing to
keep in sync. `--pin` records the exact resolved version, so an upgrade is a
deliberate `@latest`, never a surprise. `openclaw` itself is a *peer*
dependency (the host provides it), so the install stays lean. Confirm with
`openclaw plugins list` (expect `multi-clawd` enabled) — it also shows the
install path; run the doctor from there:
`node <install-path>/scripts/doctor.mjs`.

**From ClawHub (alternative registry):**

```bash
openclaw plugins install clawhub:drakon-systems/multi-clawd
```

**From source (contributors, or ahead of a release):**

```bash
git clone https://github.com/Drakon-Systems-Ltd/multi-clawd.git
cd multi-clawd && npm install && npm run build
openclaw plugins install "$(pwd)"
```

```powershell
# Windows (native, PowerShell)
git clone https://github.com/Drakon-Systems-Ltd/multi-clawd.git
cd multi-clawd; npm install; npm run build
openclaw plugins install (Get-Location).Path
```

**Or let your agent install it.** Running an OpenClaw assistant or Claude
Code on the target machine already? Paste it this and go make coffee:

> Read https://raw.githubusercontent.com/Drakon-Systems-Ltd/multi-clawd/master/SETUP-AGENT.md
> and follow it to set up multi-clawd on this machine. I own a second
> Claude account — ask me when you need me to log in.

The guide has the guardrails built in (config backup, merge-don't-overwrite,
never print tokens, ask before touching routing).

**Requirements:** OpenClaw ≥ 2026.6, the `claude` CLI on `PATH`, and a
second Claude subscription you own.

**Upgrading:**

```bash
# Registry install (npm / ClawHub):
openclaw plugins install @drakon-systems/multi-clawd@latest --force
openclaw gateway restart

# From source:
cd multi-clawd && git pull && npm install && npm run build && npm run doctor
```

On the source path run `npm run build` explicitly — don't rely on the
`prepare` hook to refresh `dist/` on a pull-upgrade (observed stale on a live
production rollout; `doctor` flags it STALE if you forget). If a release adds new
config keys, `openclaw plugins install --force` validates against the *old*
manifest — run `node scripts/doctor.mjs --preflight` first for the strip →
install → re-add plan.

## Set up a second account

**Easiest: the setup wizard.** It walks you through the whole shape below —
main account, isolated second account, token storage, pool — and merges the
result into `openclaw.json` non-destructively (backup first, merge by id,
re-runs are no-ops, never sees a token value):

```bash
npm run setup                                            # source checkout
node ~/.openclaw/extensions/multi-clawd/scripts/setup.mjs  # installed copy
# add --dry-run to preview the changes without writing anything
```

The key idea either way: your **main** account keeps the default `~/.claude`
login untouched, and each **extra** account gets its *own isolated config
dir* — a separate Claude "app" — so the logins can never clobber each other.

**Or by hand:**

1. Give the account an isolated config dir and capture its Claude Code
   setup-token into it.

   **macOS / Linux / WSL2:**

   ```bash
   mkdir -p ~/.claw2 && chmod 700 ~/.claw2
   CLAUDE_CONFIG_DIR=~/.claw2 claude setup-token   # log in as the 2nd account
   # store the token where the plugin can read it (0600):
   #   ~/.claw2/oauth-token
   ```

   **Windows (native, PowerShell):**

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.claw2" | Out-Null
   $env:CLAUDE_CONFIG_DIR = "$HOME\.claw2"
   claude setup-token   # log in as the 2nd account
   # store the token as $HOME\.claw2\oauth-token, then lock it to your user:
   icacls "$HOME\.claw2\oauth-token" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
   ```

2. Configure the plugin (in `openclaw.json`; if `plugins.allow` is set, add
   `"multi-clawd"` to it). `~` expands on every platform; absolute Windows
   paths (`C:\\Users\\you\\.claw2`) work too:

   ```jsonc
   {
     "plugins": {
       "entries": {
         "multi-clawd": {
           "enabled": true,
           "config": {
             "accounts": [
               {
                 "id": "claw2",
                 "label": "Second Max",
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

3. Slot the backend into your fallback chain:

   ```jsonc
   "agents": { "defaults": { "model": {
     "primary": "anthropic/claude-fable-5",
     "fallbacks": [
       "claw2/claude-fable-5",
       "anthropic/claude-opus-4-8"
     ]
   } } }
   ```

4. Restart the gateway. Done — a limit on the main account now rolls to the
   second account on the same model before any tier drop.

## The pool: proactive rotation (v0.2)

Individual backends (`claw2/…`) fail over *reactively* — OpenClaw steps the
chain when a turn actually dies with a limit error. The pool goes one better:
it watches each account's own usage signal and hands over **before** the
error.

```jsonc
"plugins": { "entries": { "multi-clawd": { "enabled": true, "config": {
  "accounts": [
    { "id": "claw1", "label": "Main Claude", "native": true },
    { "id": "claw2", "label": "Second Max", "configDir": "~/.claw2",
      // v0.3 preferred: resolve via your gateway's secret providers —
      // no plaintext token file on disk
      "oauthTokenRef": { "source": "exec", "provider": "onepassword",
                         "id": "op://YourVault/claw2-setup-token/password" } }
  ],
  "pool": {
    "id": "clawd",
    "accounts": ["claw1", "claw2"],   // preference order; first = home
    "utilizationThreshold": 0.85,     // hand over at 85% of any window
    "minDwellMs": 600000,             // v0.3: anti-flap dwell before returning home
    "degrade": {                      // v0.3.5: last step before provider drop
      "ladder": ["claude-opus-4-8"],  // whole pool exhausted → same account, lower tier
      "pins": [                       // contractual lanes never degrade
        { "agentDirIncludes": "billing-app" }
      ]
    }
  }
} } } },
"agents": { "defaults": {
  "models": { "clawd/claude-fable-5": {} },
  "model": {
    "primary": "clawd/claude-fable-5",        // the pool IS the Claude lane
    "fallbacks": [
      "openai/gpt-5.6",                        // both accounts exhausted
      "xai/grok-4.5"                           // ...or Anthropic is down
    ]
  }
} }
```

How it decides, per launch (all data from each account's live
`rate_limit_event` stream, captured by the shim):

| Account state | Effect |
|---|---|
| `rejected` + reset in the future | skipped until `resetsAt` passes |
| any window utilization ≥ threshold | skipped (nearly maxed — the point of the pool) |
| `allowed_warning` alone | still used — weekly windows warn early; only the utilization number rotates |
| no data / stale data | used — never rotate on missing evidence |
| whole pool exhausted | home account anyway → real limit error → your chain drops provider |

Notes:

- Rotation happens at limit boundaries only. A mid-conversation handover
  costs the Claude CLI its native session (it lives in the previous
  account's config dir); OpenClaw's fresh-session retry recovers the turn.
- Plugin lifecycle hooks were investigated and ruled out for this job: on
  OpenClaw ≤ 2026.7.1, `before_model_resolve` never fires for gateway RPC
  turns and `before_agent_start` overrides are ignored on the prompt path.
  The pool therefore decides inside the backend's own `prepareExecution`,
  which runs on every launch on every turn path. Details in
  [`DESIGN.md`](./DESIGN.md).

## How it works

Three moves, all through the official plugin SDK (details in
[`DESIGN.md`](./DESIGN.md)):

1. **`registerCliBackend`** mirrors the bundled `claude-cli` backend — same
   argv, same JSONL stream parsing, same MCP config-file bridge — scoped to
   one account id.
2. **A minimal provider per account** implements `resolveDynamicModel` +
   `augmentModelCatalog`, which is what makes `claw2/claude-fable-5`
   resolvable without an API key (installed extensions can't use the
   bundled plugins' static-catalog path — this is the supported alternative).
3. **`prepareExecution`** injects that account's own login
   (`CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_OAUTH_TOKEN`) into the child process
   env, after the host's ambient Claude credentials are stripped.

## Known issue: idle backends can be evicted by OpenClaw core

On OpenClaw ≤ 2026.7.1, core's *scoped* harness activation can silently drop
a plugin-registered CLI backend from the live registry: when an agent turn
selects a harness owned by a different plugin and that scoped set isn't
already fully loaded, core rebuilds the plugin registry with **only** that
plugin (+ the memory plugin) and swaps it in globally. Your `claw2` backend
then fails with `Unknown CLI backend: claw2` — while `openclaw infer model
list` (a separate cache) still lists its models. A common real-world trigger
is an hourly heartbeat running on a model served by another harness.

- Upstream bug: [openclaw#107408](https://github.com/openclaw/openclaw/issues/107408)
- Upstream fix: [openclaw#107596](https://github.com/openclaw/openclaw/pull/107596)

**Until that lands:** a gateway restart always restores the backend (startup
loads are full-scope), and backends that are in regular use effectively
re-assert themselves. This repo ships a ready-made mitigation —
`scripts/eviction-watchdog.mjs` — which tails the gateway log for the
`Unknown CLI backend` signature and restarts the gateway at most once per
eviction event. Run it every few minutes from cron/launchd/systemd:

```bash
node scripts/eviction-watchdog.mjs                    # restart on detection
MULTI_CLAWD_WATCHDOG_DRY=1 node scripts/eviction-watchdog.mjs   # report only
```

An in-process fix was investigated and is impossible by design:
`registerCliBackend` is not late-callable, there is no registry-rebuilt
event, and no plugin API can force a rebuild. See `DESIGN.md`.

## Known limitations

- **Shim window persistence is sequential-safe, not concurrent-writer-safe.**
  `persistState()` in `src/shim.ts` does a read-merge-write on every save so a
  turn that only reports one window type (say `five_hour`) doesn't clobber
  the last-seen `seven_day` data — but the read, merge, and rename aren't
  atomic together. Two truly concurrent shim processes for the *same*
  account can still race each other and drop an event on last-rename-wins.
  In practice this needs two in-flight turns on one account at once, which
  is rare, but it's a real gap. A per-account lock/retry protocol is tracked
  as a v0.3.x follow-up.

## Security

- Tokens are never committed and never logged; `.gitignore` blocks token
  and account directories by default.
- Prefer a secret reference (`oauthTokenRef`, v0.3) over a plaintext
  file; when a file is used, keep it `0600` (POSIX) or locked to your user
  with `icacls` (Windows).
- Migrating a token file into a vault? `op read` (and most secret CLIs)
  append a trailing newline on output — resolution trims the resolved
  value (guaranteed in `token-resolution.ts`), so a file-vs-vault diff
  showing only a trailing-newline mismatch is a false alarm.
- Use only accounts you own, within your provider's terms of service.

## Status & roadmap

Early but real — built for and dogfooded in production.

- **v0.1** — single extra account, verified end-to-end ✅
- **v0.1.1** — `jsonlDialect` declared on registered backends, fixing raw
  stream-JSON reaching connected channels on live turns ✅
- **v0.1.2** — registration-pass logging (config-source attribution +
  registered-backend summary) ✅
- **v0.2** — the pool: proactive near-limit rotation from live
  `rate_limit_event` health; native (keychain) accounts; future-proof model
  resolution (mirrored catalog + permissive `claude-*` pass-through);
  eviction watchdog; vitest suite ✅
- **v0.3** — hardening from field feedback: `oauthTokenRef` via gateway
  secret providers with strict redaction; sticky rotation with anti-flap
  dwell; login-health probes + heartbeat operator alerts; turn-safe
  watchdog (lane-guard); `doctor` + `--preflight`; build-on-install; shim
  window persistence ✅
- **v0.3.5** — tier-aware degradation (whole pool exhausted → step down the
  configured ladder on the same account, e.g. Fable → Opus, instead of
  dropping provider) + never-degrade pins for contractual model lanes +
  single-account pools ✅
- **v0.3.6** — reactive model-limit capture: a 429 "reached your <model>
  limit" error is recorded as a model-scoped rejected window, and health is
  model-aware (exhausted-for-Fable ≠ exhausted-for-Opus) — the first hard
  limit teaches the pool, the next launch flips accounts ✅
- **v0.3.7** — reset-aware per-window staleness: reset-bearing windows
  (weekly, model:*) bind until their reset regardless of observation age
  (capped at 8d with a clock-skew alarm), reset-less windows keep TTL/decay,
  and model windows age by their own TTL independent of pool `staleAfterMs`
  — closes the quiet-pool blindness half of the no-flip failure class ✅
- **v0.4** — standalone localhost proxy (OpenAI-compatible) so Hermes and
  custom runtimes can share the pool; true per-session affinity; local
  five-hour-window signal (turn counting)
- **v1.0** — npm + ClawHub parity releases

See [`DESIGN.md`](./DESIGN.md) for the architecture, the three obvious
approaches that *don't* work, and why.

---

<div align="center">

Built by [Drakon Systems Ltd](https://drakonsystems.com) · MIT licensed

🦞 *Claws out.*

</div>
