# Design note: optional bounded hold when every pool account is exhausted

Issue: #167. Status: **design only, no runtime change**. Line references are to master `7e23bb4`
(the issue cites 88c9428; the code has moved, current lines are given).
Prior art (public): KarpelesLab/teamclaude documents an off-by-default mode that holds a request until quota resets (README, as cited in #167).

## Recommendation (up front)

**Do not build the reset-wait hold.** The only hold that fits under the host's no-output floor is
at most about 150 s, and Claude quota resets are hours (five-hour window) to days (weekly) away,
so a hold that fits would almost never reach a reset. The narrow case it could help (a reset
within ~2 minutes) is already handled by the existing launch-and-fail path plus the in-turn
retry window, at no new risk. If an operator later wants the behaviour, the supportable form is
**host-side** (OpenClaw queueing / an automation retry), not a plugin sleep. See "If revisited".

## 1. Where a hold could live

Candidates:

- **`prepareExecution` (`src/index.ts:1685`)**: it is the only place that knows the whole pool
  state (verdicts, `src/index.ts:1693-1700`) and decides the launch. A hold would be an
  `await sleep` before returning the prepared execution. The exhausted decision point is
  `src/index.ts:1747-1763` (the `probing` branch, #26) and the error alert is raised at
  `src/index.ts:1804-1809` (key at `:1807`). A hold would have to sit just before the child is launched,
  after the sweep at `src/index.ts:1795-1802` so alerts stay truthful.
  Cost: it blocks the host's launch call with no child and therefore no output at all.
  Unverified: whether the host's no-output watchdog clock starts before or after `prepareExecution`
  returns; the plugin cannot observe this. Treat it as starting before (the safe assumption).
- **The shim (`src/shim.ts`)**: already owns an in-turn hold (`HOLD_MAX_MS` 10 s,
  `HOLD_RETRY_MAX_MS` 120 s capped at 150 s, `src/shim.ts:475-488`, deadline logic
  `src/shim.ts:726-745`). That hold buffers the CLI's preamble so a rate-limit retry can move to a
  sibling account. It is driven by the CLI's own reported retry delay, not by pool state.
  Reusing it for a pool-wide wait would mean the child is already running on an exhausted
  account, which is the wrong account to wait on.

Decision: if ever built, the decision lives in `prepareExecution` (pool knowledge), the wait is
bounded there, and the shim is untouched.

## 2. Hard cap below the host's no-output floor

- The host fresh-launch no-output floor is `minMs: 180_000` (`src/index.ts:167-171`), resume is
  tighter: `minMs: 60_000, maxMs: 180_000` (`src/index.ts:172-176`), both wired into the backend at
  `src/index.ts:1129-1132`. The shim's own comments treat 180 s as the floor
  (`src/shim.ts:469-472`, `src/shim.ts:477-482`).
- A resumed session has a floor of **60 s**, so a hold safe for fresh launches (say 150 s) is unsafe
  for resumes. A cap would need to be `min(150 s, resume floor 60 s minus margin)` for resumes.
  Realistic safe hold: **about 45 s resume, about 120 s fresh**.
- Reset horizons the hold would wait on: weekly resets are days out (the pool reads them from
  `sevenDayReset`, `src/health.ts:762`), five-hour windows up to 5 h. Reset-less rejections are
  assumed to block 1 h or 6 h (`PERIOD_RESET_LESS_BLOCK_MS`, `src/health.ts:262-283`). Against a
  120 s cap the success window is: a reset landing within 2 minutes of the launch. Over a
  five-hour window that is under 1% of arrivals, and for weekly windows effectively zero.
- Failure cost if the cap is wrong: the host kills the turn on no-output and the user sees a
  timeout instead of the clear limit error the fail-fast path gives today.

Conclusion: the cap fits, but the benefit does not. This is the central reason for "do not build".

## 3. Interaction with the degrade ladder and pinned lanes

- Today: all-exhausted + ladder configured -> `decideDegradation` (`src/degrade.ts:33-50`) steps to
  `ladder[0]` immediately, wired at `src/index.ts:1951-1982`. Pinned lanes (`matchesPin`,
  `src/degrade.ts:51-60`) keep the requested model and fail over via the host chain
  (`src/index.ts:1983-1987`).
- A hold must not delay degradation: degrading is instant and succeeds, so waiting before it
  would make turns slower for no gain. Ordering if built: degrade first; hold only when
  there is no ladder, or the launch is pinned.
- Pinned lanes are the only case where waiting is arguable (they cannot degrade), but they are
  the "contractual always this model" lanes and the host chain (e.g. another provider) is the
  contract-approved failover. Holding a pinned lane up to 120 s before failing over only delays
  the failover it already has. Default for pinned lanes: no hold.
- Single-account pool with a ladder (`src/index.ts:1640-1647`): hold adds nothing; degrade works.

## 4. Can the earliest `resetsAt` be trusted?

- `sevenDayReset` (`src/health.ts:762-766`) returns only the weekly window from
  `summarizeWindowUsage` (`src/health.ts:715-736`). It ignores five-hour windows and
  model-scoped windows (`MODEL_WINDOW_PREFIX` skipped at `src/health.ts:722`), so it is not
  the earliest reset that governs an exhausted verdict. An exhausted-by-five-hour account would
  report a weekly reset days away.
- Trust ceiling: reset-bearing windows older than 8 days are dropped
  (`MAX_RESET_HORIZON_MS`, `src/health.ts:261`, enforced `src/health.ts:481` and `:725`). That bound
  protects against clock skew / parse bugs, but it does not make a reset accurate: a still-future
  `resetsAt` is trusted until it passes regardless of observation age (`src/health.ts:470-476`).
  An account whose state was written days ago may already have been reset early, or its
  `resetsAt` rolled forward; a hold keyed to it could wait on a stale or wrong date.
- Reset-less rejections have no reset time at all, only a guessed block (1 h/6 h), so no hold
  can be targeted at them.
- A hold would need a new `earliestResetAt` over all windows and models. That is new
  code in the verdict layer to serve a feature with near-zero hit rate.

Verdict: trustworthy enough for a log line, not for scheduling a wait.

## 5. Recommendation and constraints

**Do not build.** Reasons: (a) hit rate near zero given hours-to-days resets vs a 45-120 s cap;
(b) it converts a fast, clear limit error into silent latency right at the host's watchdog edge,
with the resume floor (60 s) closer than the shim comments imply; (c) it adds a second pool-wide
state machine beside re-probe (#26) and degrade; (d) a plugin-side sleep also holds the serialised
backend (`serialize: true`, `src/index.ts:1134`, set on the per-account backend; the pool backend is built from it, unverified here), so queued turns for the same backend stall behind it.

Constraints from #167 satisfied by "don't build": off by default (moot), no billing or
extra-usage behaviour, no per-account egress proxy.

Interactions with open issues:

- **#155** (pool cannot be bound by 2026.11 automations: cron rejects `clawd/*` models and
  fallbacks): a hold is irrelevant to the lanes most likely to want it (unattended jobs), because
  they cannot use the pool at all until #155 is resolved. Revisit after #155.
- **#137** (isolated completions refused on pooled backends): isolated completions do not pass
  through the shim path the hold would use, so a hold would not apply to them.

## If revisited (not recommended now)

Only as an explicit opt-in `pool.holdOnExhaustion: { maxMs }`, with: a clamp of
`maxMs` below `min(resume floor 60 s, fresh floor 180 s) - 15 s` margin; applied only when no
ladder match and not pinned; an `earliestResetAt` over all windows and models; a decision log
line and an info alert; and measurement first (log, for a few weeks, how long exhausted launches
are from the earliest known reset; build only if a meaningful share is under the cap).
A better vehicle for long waits is a host-level retry/queue, outside this plugin.
