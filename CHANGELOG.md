# Changelog

All notable changes to multi-clawd are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project adopts semantic
versioning from v1.0.

## [1.5.0] — 2026-07-23

- **Added: live usage-percent readout in `explain`.** Each account's RIGHT NOW
  entry now shows how full its rate windows actually are — e.g.
  `usage: weekly 12% (resets ~3d) · 5-hour 4% (resets ~2h)` — using the SAME
  liveness rules the rotation logic acts on (`summarizeWindowUsage` in
  health.ts): a passed reset voids the previous cycle's number, reset-less
  windows age out at the pool's staleness horizon, and model-scoped rejection
  markers stay out of the usage line (they already surface via the verdict).
  Accounts with no live utilization telemetry say so honestly
  (`usage: no live telemetry`) rather than showing stale numbers.

## [1.4.2] — 2026-07-21

- **Fixed: mid-conversation pool rotation no longer knocks the turn off
  Claude entirely.** When rotation landed mid-conversation, the Claude CLI
  session being resumed lived in the previous account's config dir, so the
  resume failed with `session_expired` — and because the backend config set
  `reseedFromRawTranscriptWhenUncompacted: false`, the gateway had no
  pre-built history prompt and skipped its fresh-session retry, cascading
  the turn down the model-fallback chain past every pooled Claude rung to
  the next provider (observed live 2026-07-21: four rungs "expired" in 8
  seconds, turn served by OpenAI). The flag is now `true`, matching the
  bundled `claude-cli` backend: a failed resume reseeds a fresh session from
  OpenClaw's sanitized, char-bounded session history and the conversation
  stays on the pooled account. The flag had been disabled (ce63bc9) to stop
  raw stream JSON being replayed as history — a pollution whose actual
  source was fixed separately by the `jsonlDialect` declaration — so
  re-enabling carries none of the original risk. Backend config flags are
  now pinned by regression tests (`tests/backend-config.test.ts`).

## [1.4.1] — 2026-07-20

- Docs: the "Set up a second account" section now leads with
  `multi-clawd setup` + `multi-clawd login` (and explains what `login` does
  per account shape), replacing a stale wizard invocation that still pointed
  at the pre-registry `~/.openclaw/extensions/…` path.

## [1.4.0] — 2026-07-20

- **`multi-clawd login <account>`** — set up or re-auth any configured
  account's Claude sign-in without remembering environment incantations. It
  launches the right flow for what the account IS (native → `claude auth
  login` against the default dir/keychain; isolated dir → the same inside
  that dir, created 0700 if missing; secret-ref/token-file accounts →
  `claude setup-token`, with a throwaway scratch dir when the account has no
  dir so the default login is never disturbed), then verifies: shows **which
  email** is signed in (no more wrong-account mix-ups), checks the token file
  landed (and chmods it 600), or reminds where the token goes. The human does
  the OAuth; the CLI never captures, stores, or prints a token value.
  `multi-clawd login` with no argument lists the accounts in plain English.
- Wizard and README now point at `login` as the easy path for the sign-in step.

## [1.3.1] — 2026-07-20

- **README restructured around the CLI.** A Quick start now leads the page:
  `npm i -g` once, then `multi-clawd update / setup / explain / doctor` — the
  whole lifecycle in five lines, with the 3-step account/pool picture up top
  instead of buried mid-page. Docs-only release.

## [1.3.0] — 2026-07-20

- **`multi-clawd explain`** — your whole setup in plain English: what each
  account actually is (native login / isolated dir / secret-ref token — the
  reference itself is never printed), how the pool decides, every fallback
  rung annotated with what it means (pool hop, tier drop, pool bypass,
  leaves-Claude), and live health right now (near-limit / exhausted with
  human reset times, rotation state).

## [1.2.3] — 2026-07-20

Wizard safety, from a real fleet run that overwrote a working account:

- **Existing accounts are protected.** When the second-account id already
  exists, the wizard shows what's configured and defaults to **keeping its
  credentials and config unchanged** — pressing Enter through the prompts can
  no longer replace a working account with placeholder defaults. Declining
  the keep prefills every prompt from the existing entry.
- **Secret references are sanity-checked at input.** A bare word (not
  URI-like, e.g. not `op://Vault/Item/field`) is challenged with a
  default-No confirmation instead of silently accepted.

## [1.2.2] — 2026-07-20

The watchdog gets a permanent home. Fleet run of `update` revealed that
OpenClaw regenerates the npm install directory on EVERY update — so any
scheduler unit pointing into it orphans again on each update, forever.

- **Stable watchdog launcher**: units now point at
  `~/.openclaw/state/multi-clawd/watchdog-launcher.mjs` — a tiny
  self-contained script (node built-ins only) that resolves the CURRENT
  install at runtime and runs its watchdog. Installs can move freely; the
  unit never breaks again. Fail-safe: no install found → clean exit.
- **`update` self-heals the unit**: after installing, any watchdog unit whose
  target is missing OR points into the npm install dir is automatically moved
  to the launcher (and the launcher content refreshed). No more
  "run setup to repair" for this class.
- **Wizard detects fragile-but-working units** (target inside the npm install
  dir) and offers the move before they break; **doctor warns** on them.

## [1.2.1] — 2026-07-20

Fixes from the first real fleet run of `npx … update`:

- **Watchdog repoint targets the installed plugin, never the npx cache.** Run
  via `npx`, the wizard's own directory is the ephemeral npx cache — pointing
  a scheduled unit there breaks on the next cache clean. The target is now
  resolved install-aware (installed plugin first, `__dirname` only for a
  source checkout with no install).
- **The post-doctor repair hint uses the npx-form command** — `multi-clawd
  setup` is only on PATH after a global install; `npx @drakon-systems/multi-clawd
  setup` works for everyone.

## [1.2.0] — 2026-07-20

- **`multi-clawd` CLI** (npm `bin`): `npx @drakon-systems/multi-clawd <cmd>` —
  or a bare `multi-clawd <cmd>` after `npm i -g`. Commands: `setup` (wizard),
  `doctor`, `version`, and the new **`update`** — one command that checks the
  registry, runs the openclaw install with the right flags (nobody types
  `--pin --force` again), offers the gateway restart, and finishes with a
  doctor health check. Never downgrades; degrades gracefully offline.

## [1.1.0] — 2026-07-20

The setup wizard now owns the eviction watchdog:

- **Wizard schedules the watchdog** (launchd on macOS, systemd user timer on
  Linux) pointing at the current install, and — the important half — **detects
  an orphaned unit** whose target script no longer exists (the classic case: a
  path install replaced by a registry install deletes the old directory out
  from under the unit) and offers to repoint it. Re-running the wizard after
  any migration repairs the watchdog.
- **doctor verifies the watchdog's target**, not just that a unit is
  scheduled: a unit firing every 5 minutes against a missing script is now a
  loud ❌ with the exact repoint path, instead of a silent dead safety net.
  Deliberately self-contained so it still works when the install itself is
  what went missing. Backup files (`*.bak-*`) are never flagged or "repaired".

## [1.0.1] — 2026-07-20

Fixes from the first real registry-install migration:

- **`openclaw` peer marked optional** (`peerDependenciesMeta`) so npm no longer
  auto-installs a full nested copy of the host runtime into the plugin's
  `node_modules`. Proven safe live: the gateway provides the module to
  registry installs (verified by serving a real pool turn with the nested copy
  removed).
- **doctor finds registry installs.** The install check now resolves
  `~/.openclaw/npm/projects/…/@drakon-systems/multi-clawd` as well as the
  classic `~/.openclaw/extensions/multi-clawd` path install (which still wins
  when both exist), instead of reporting ❌ on the recommended install method.

## [1.0.0] — 2026-07-20

First public npm release. Everything in 0.2–0.3.7 — the pooled backend with
proactive near-limit rotation, reactive model-limit capture, reset-aware
staleness, tier degradation, login-health probes, the eviction watchdog, and
the doctor's pool-bypass audits — plus:

### Changed
- **Packaged for npm distribution.** The package is now
  `@drakon-systems/multi-clawd` (scoped, public) and installs straight from the
  registry: `openclaw plugins install @drakon-systems/multi-clawd --pin` — no
  clone, no build step.
- **`openclaw` is now a peer dependency (`>=2026.6`), not a bundled dependency.**
  The host gateway provides it, so installs no longer pull a full pinned copy of
  the runtime into every consumer's `node_modules`. Retained as a devDependency
  so the source repo still builds and tests.

### Added
- **Interactive setup wizard** (`npm run setup` / `scripts/setup.mjs`). Walks a
  user through the standard multi-account shape — main native account, second
  account in its own isolated config dir, token via secret-manager ref / token
  file / dir login, failover pool — and merges the result into
  `openclaw.json` non-destructively (backup first, accounts merged by id, an
  existing pool never overwritten, re-runs are no-ops). `--dry-run` previews.
  The wizard never sees, stores, or prints a token value.

### Fixed
- **Headless tool lockout under a `full` exec policy.** Core injects
  `--permission-mode bypassPermissions` only for the bundled `claude-cli`
  backend (by provider id), so a pool launch booted default-deny and every host
  tool call died against an unanswerable approval prompt. The backend now mirrors
  core — but derives the flag from the live `tools.exec.mode`, injecting bypass
  **only** under `full`, so a host on a stricter policy is never silently
  overridden.

## [0.3.7] — 2026-07-18
- Reset-aware per-window staleness: reset-bearing windows bind until their own
  reset (8-day cap + clock-skew alarm), reset-less windows keep TTL/decay, and
  `no_data` derives from live evidence rather than a blanket freshness gate.
  Model-scoped windows age by their own TTL, never truncated by an aggressive
  pool `staleAfterMs`. Model ids canonicalised on write and read.

## [0.3.6] — 2026-07-18
- Reactive rate-limit capture: the shim writes model-scoped rejected windows
  (`model:<canonical>`) from genuine 429 limit errors, and health is model-aware
  — exhausted-for-fable no longer blocks opus on the same account.

## [0.3.5] — 2026-07-17
- Tier-aware degradation (`pool.degrade.ladder`), never-degrade pins, and
  single-account pools. Enforced via shim argv rewrite.

## [0.3.0] — 2026-07-16
- `oauthTokenRef` secret-provider token resolution, sticky rotation, login-health
  probes with heartbeat alerts, turn-safe eviction watchdog, and `doctor`.

## [0.2.0] — 2026-07-15
- Pooled backend: one backend id fronting several accounts with proactive
  near-limit rotation, native (keychain) accounts, a future-proof model catalog,
  and the eviction watchdog.

[1.4.1]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v0.3.7...v1.0.0
[0.3.7]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.7
[0.3.6]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.6
[0.3.5]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.5
[0.3.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.0
[0.2.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.2.0
