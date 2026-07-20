# Changelog

All notable changes to multi-clawd are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project adopts semantic
versioning from v1.0.

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

[1.2.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v0.3.7...v1.0.0
[0.3.7]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.7
[0.3.6]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.6
[0.3.5]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.5
[0.3.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.0
[0.2.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.2.0
