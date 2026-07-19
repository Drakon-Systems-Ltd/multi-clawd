# Changelog

All notable changes to multi-clawd are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project adopts semantic
versioning from v1.0.

## [Unreleased]

### Changed
- **Packaged for npm distribution.** The package is now
  `@drakon-systems/multi-clawd` (scoped, public) and installs straight from the
  registry: `openclaw plugins install @drakon-systems/multi-clawd --pin` — no
  clone, no build step.
- **`openclaw` is now a peer dependency (`>=2026.6`), not a bundled dependency.**
  The host gateway provides it, so installs no longer pull a full pinned copy of
  the runtime into every consumer's `node_modules`. Retained as a devDependency
  so the source repo still builds and tests.

### Fixed
- **Headless tool lockout under a `full` exec policy.** Core injects
  `--permission-mode bypassPermissions` only for the bundled `claude-cli`
  backend (by provider id), so a pool launch booted default-deny and every host
  tool call died against an unanswerable approval prompt. The backend now mirrors
  core — but derives the flag from the live `tools.exec.mode`, injecting bypass
  **only** under `full`, so a host on a stricter policy is never silently
  overridden.

_Publishes as **v1.0.0** at the release gate — see [PUBLISHING.md](PUBLISHING.md)._

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

[Unreleased]: https://github.com/Drakon-Systems-Ltd/multi-clawd/compare/v0.3.7...HEAD
[0.3.7]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.7
[0.3.6]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.6
[0.3.5]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.5
[0.3.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.3.0
[0.2.0]: https://github.com/Drakon-Systems-Ltd/multi-clawd/releases/tag/v0.2.0
