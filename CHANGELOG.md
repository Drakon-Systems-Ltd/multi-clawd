# Changelog

All notable changes to multi-clawd are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project adopts semantic
versioning from v1.0.

## [1.7.3] — 2026-08-09

**Three fixes from an adversarial pass on our own source.** Four agents were
pointed at this codebase with instructions to break it and to verify every
claim in code before reporting it. Two of the findings were in checks that
exist precisely to catch the thing they missed.

- **The pool-bypass audit compared provider ids byte-for-byte** while
  OpenClaw's router lower-cases them before resolving. So a chain rung written
  `Anthropic/claude-fable-5` went straight to the API with no cross-account
  failover, and `doctor` still printed *"all live Claude tiers route through
  the clawd pool"*. The one regression this module exists to find, defeated by
  a capital letter. Provider ids are now trimmed and lower-cased on both sides
  of every comparison — off-pool detection, pool-match and single-account pins
  alike.

- **Credential resolution now fails closed.** An account that declares a token
  source is authenticated by that token and nothing else. When resolution
  yielded nothing usable — provider briefly unavailable, empty secret,
  half-written token file — the child env carried neither a token nor a config
  dir, so the Claude CLI quietly fell back to the box's default login: a
  different account's quota, spent under this account's name in telemetry. A
  launch in that state is now refused with a named error. Native accounts are
  exempt (the default login *is* their credential), and a declared `configDir`
  remains a valid fallback because it is the same account's own file-based
  login.

- **Account-level rejections now bind symmetrically.** 1.7.2 stopped a
  reset-less `unknown:rejected` window from benching a whole account, because
  that is where a single-model limit lands — a live Fable-only 429 did exactly
  this. The reset-bearing branch above it never got the same guard, so the
  identical event carrying a reset stamp still stranded every other model on
  that account. Both branches share the check now.

Each fix landed test-first: the three regression tests were written against
1.7.2, watched to fail (seven failures), and only then made to pass. 415 tests
green.

Scope note: a refused launch is deliberately loud — it fails that one turn and
falls through the model chain rather than silently spending the wrong account.
Excluding a credential-broken account from pool selection so the pool rotates
instead is separate work, in progress on `fix/credential-health-failover`.

## [1.7.2] — 2026-08-02

**Rotating on the signal the provider actually sends.** Proactive rotation was
built around one number — utilization ≥ threshold — and Anthropic does not
send that number for the 5-hour session window. Across every observation held
on two accounts since 21 July it arrives as a bare status and a reset time,
while the weekly windows carry percentages. So the pool could never pre-empt a
session limit; it took the hit and rotated afterwards. Three fixes, all
narrow.

- **A numberless warning on a short (hour-scoped) window now counts as
  near-limit.** Deliberately not a blanket "warnings rotate" rule: the weekly
  window warns from ~30% utilization and would flap. A reported number still
  wins over the status, so a warning at 50% does not rotate, and a warning
  from a window that has since reset is void — the same passed-reset rule the
  utilization path already applied.

- **A rejection carrying no reset time is no longer ignored.** The one record
  that says "this account just refused a turn" fell through every branch when
  the field it was keyed on was absent. It now binds for an hour and re-probes,
  matching the model-scoped path. Named period windows only: `unknown:rejected`
  stays non-binding, because that is where a single-model limit lands (a live
  Fable-only 429 did exactly this) and exhausting the account on it would
  strand every other model.

- **`doctor` now checks the registry.** `openclaw plugins update --all` reports
  a pinned plugin as up to date even when npm publishes a newer version — it
  resolves metadata for the pinned spec, and OpenClaw's honest "pinned to X;
  registry resolves to Y" message is built inside its `--dry-run` branch, so a
  real run never prints it. Nothing a user runs would surface a new version.
  Doctor now says so, cached for six hours and silent when the registry is
  unreachable. Documented in the README rather than left as folklore.

- **New wiring test.** Selection was covered only at the helper level —
  classify, choose, sticky — with nothing testing the wire between a verdict
  and the account a launch actually runs on. `tests/pool-selection.test.ts`
  drives `registerPoolBackend` against real state files and asserts on the
  credential env the child process would receive. Verified by deleting each
  fix and confirming it fails.

## [1.7.1] — 2026-07-28

Documentation only — no code change.

- **README and SETUP-AGENT.md now explain the two halves.** One package
  installs as a plugin (serves turns, updated by `multi-clawd update`) and a
  CLI (`doctor`, `chain`, `setup` — updated only by a global install). `update`
  upgrades the plugin, not itself, and while v1.6.0 added a warning for a
  lagging CLI, that warning ships *inside* the CLI — so an older one stays
  silent. We found three of our own machines running current plugins behind
  commands three versions stale. The fix is one manual global install, and it
  now says so where people actually look rather than only in a chat reply.

## [1.7.0] — 2026-07-28

**Routing that audits itself.** Every fault this project has hit in production
was configuration that no longer matched intent — never a wrong model choice.
Four in one week, across two machines: a per-agent chain silently shadowing the
defaults, sessions pinned off-pool, single-account pins that defeat
cross-account failover. Each was individually invisible, and each disabled the
one thing multi-clawd exists to do.

- **New `multi-clawd chain`** — one place that answers "what actually serves my
  turns, and does it match what I meant?". Prints the effective chain marking
  which rungs are pooled, then every routing fault with its fix underneath:
  agents carrying their own chain, off-pool references, and session `/model`
  pins across all agents. Session ids are masked by default (`--raw` to show
  them in full), because this output gets pasted into issues.
- **New audit: per-agent chains that shadow the defaults** (`auditChainShadowing`).
  This is the trap that cost a morning on 25 Jul: `agents.list[main].model`
  carried its own chain, so editing `agents.defaults.model` changed nothing for
  the main agent — and because the shadowing chain was itself perfectly
  pool-routed, no existing check said a word. Reported as a warning when it
  changes the primary, and as a note when it merely repeats the defaults (still
  worth deleting: it will silently stop tracking the defaults the next time
  they change).
- **New: notice when the provider ships a Claude model your chain doesn't
  mention** — and nothing more. multi-clawd does **not** auto-adopt new models.
  Which model belongs at the top of a chain is a cost, quality and behaviour
  decision that only the operator can make; a credential-handling plugin that
  silently rewired routing would be surprising in precisely the wrong way. So
  it detects, tells you through the existing alert path, offers `multi-clawd
  chain`, and stops.
  - "New" means **new to this machine** — an id in the catalog now that was
    absent last time. Model ids don't sort into a meaningful recency order
    across families (`claude-opus-5` vs `claude-fable-5`), so any "newer than
    yours" claim would be invention. The first run only records a baseline, so
    the feature never opens by dumping the whole catalog into your chat.
  - Best-effort and off the hot path: it runs detached after the pool
    registers, and any failure is swallowed rather than delaying a launch.

## [1.6.0] — 2026-07-27

**CLI/plugin version skew is no longer silent.**

multi-clawd ships two artifacts from one package: the global CLI (the
`multi-clawd` command, which owns `doctor`, `setup` and `explain`) and the
OpenClaw plugin that actually serves turns. `update` upgraded the plugin only,
so the CLI could drift behind without a word — and because the diagnostics
live in the CLI, a stale CLI then reported stale findings about a perfectly
current plugin. Someone hit exactly that: `doctor` re-printed a bug that had
already been fixed in the plugin, because the doctor asking the question was
three versions old.

- **`update` now finishes its own job.** After upgrading the plugin it detects
  a lagging CLI and offers to update it too, running the global install on
  your confirmation. It runs last in the flow on purpose — that install
  replaces this package's own directory, so nothing may import from it
  afterwards. Never forced: npx users are told the `@latest` invocation
  instead, a source checkout is told to pull and build, and a failed global
  install (permissions) prints the command rather than pretending.
- **`doctor` reports skew first, before anything else.** If the CLI is behind,
  every finding underneath it was produced by older logic, so that has to be
  the first line you read. Aligned installs get a plain
  `CLI and plugin both vX.Y.Z`.
- **`version` answers the obvious question.** Printing two version numbers side
  by side invites "…is that a problem?", so it now says, rather than leaving
  you to guess.
- New pure helpers in `update-core.ts` — `classifyCliSkew`,
  `detectCliInstallKind`, `cliUpdateCommand`, `formatCliSkew` — with tests
  covering both skew directions, all three install kinds, and Windows paths.
  The messages state the *consequence*, not just the numbers: the version pair
  alone is what caused the confusion in the first place.

## [1.5.4] — 2026-07-26

- **Fixed: `doctor` no longer reports expired rate-limit windows as current
  usage.** It printed raw window telemetry, so a `seven_day@96%` whose reset
  had passed five days earlier appeared beside a fresh `(0m old)` stamp and
  read as "96% of the weekly cap used right now" — while rotation and
  `explain` both correctly voided it. Non-live windows are now tagged
  `(expired — ignored)`, and the age label reads `observed Nm ago` because
  that was always the age of the observation, never the window's validity.
- **Changed: `doctor` shares `explain`'s liveness rule instead of copying it.**
  It now calls the same `summarizeWindowUsage` that `explain` uses, so
  rotation, `explain` and `doctor` cannot drift on what counts as live
  telemetry — one definition, three surfaces.

## [1.5.3] — 2026-07-26

- **Fixed: `SECURITY.md` now ships to npm users.** v1.5.2 added the disclosure
  policy but left it out of `package.json` `files`, so it existed only on
  GitHub — a disclosure policy nobody receives is decoration. It is now
  packaged and linked from the README's Security section, and a test asserts
  both so it cannot silently fall out again.
- **Docs: `PUBLISHING.md` records why `npm version` hooks cannot be trusted.**
  The `version` lifecycle script is silently skipped under
  `ignore-scripts=true` (our release box's setting), which is the real reason
  the plugin manifest lagged a version on v1.5.1 and v1.5.2 — twice
  misdiagnosed as an npm ordering bug. The runbook now syncs explicitly and
  re-runs the suite after the bump, where the parity tests catch it.

## [1.5.2] — 2026-07-26

Security-hardening release. No behaviour changes to pooling, rotation or
failover; findings came from a full security review of the package.

- **Added: plaintext token files are checked, not trusted.** `oauthTokenFile`
  is now inspected on first use and warns (once per process) when the file is
  group- or world-accessible. The docs always said `chmod 600`; nothing
  verified it, so a world-readable Claude credential was consumed in silence.
  Advisory only — it never blocks a launch, because the credential still works
  and turning a hygiene problem into an outage would be the wrong trade.
- **Changed: the agent-install URL in the README is pinned to a release tag**
  instead of `master`. What someone's assistant reads — and therefore executes
  — is now fixed at a chosen version rather than whatever the branch says that
  day. The `version` hook rewrites the tag automatically, with a test pinning
  it to `package.json`, so it cannot drift.
- **Changed: removed the last two shell-string spawns.** The macOS launchd
  reload in `scripts/setup.mjs` and `scripts/cli.mjs` used
  `/bin/sh -c "launchctl … \"${file}\""`; both are now direct `spawnSync`
  calls with argument arrays. Not exploitable before (paths are ours), but it
  removes the quoting/injection surface entirely and drops two of the
  `dangerous_exec` findings on the ClawHub audit page.
- **Added: `SECURITY.md`** — disclosure policy, exactly how credentials are
  handled, and a table documenting every remaining process-spawn callsite and
  why it exists.
- **Added: `tests/security-posture.test.ts`** — turns the public security
  claims into build failures if the code stops backing them: the documented
  `CLEAR_ENV` count must match the real list, dependencies must stay empty, no
  shell-string spawns may reappear, and the README tag must match the version.
  (This test found the second `/bin/sh` callsite the manual review missed.)

## [1.5.1] — 2026-07-25

- **Added: Claude Opus 5 (`claude-opus-5`, released 24 Jul 2026) as a known
  model spec** — 1M context window, 128k max output, plus the `opus-5` CLI
  alias. The dynamic catalog mirror already surfaced the id automatically;
  this upgrades it from the conservative 200k-context fallback to its real
  specs.

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
