# Isolated completions on pooled backends: the private `isolatedCompletionEnforced` contract

Issue #137 (finding 4 of the #133 compat audit). Read-only architecture and source research, a fixture contract test, and the implementation plan. Observed on 2026-11-08 (UTC), 16:08 to 16:21, from worktree `wt-137-isolated-contract` at `origin/master` 61c1f79.

## Scope and method

- **Audited:** `@drakon-systems/multi-clawd` at 61c1f79 (v2.6.5 plus #134 and #133 merges) against OpenClaw **v2026.11.1** (installed on this box, `dist` read in place, plus the tagged GitHub sources), **v2026.10.10** (tagged GitHub sources) and the pinned devDependency **v2026.8.1** (`node_modules/openclaw`, read only).
- **Executed checks** ran only inside the worktree with the committed fixtures and a scratch `HOME`; the bundled Claude resolver was run in a child process with `HOME` pointed at the scratch dir. No gateway was installed, updated or restarted. No credential was read or printed. No live provider call was made. No release was cut.
- **Not changed here:** `src/index.ts`, `src/tool-cap.ts` (at the time owned by #136; see "Refresh 2026-11-09"), `tests/openclaw-sdk-contract.test.ts` and CI (owned by #135), `CHANGELOG.md`, `README.md`, dependencies.
- **Confidence labels:** CONFIRMED = read from source or observed in a test run this session; LIKELY = inferred from source with one unverified link; UNKNOWN = not established.

## Summary

| # | Fact | 2026.8.1 | 2026.10.10 | 2026.11.1 | Status |
|---|---|---|---|---|---|
| 1 | Core refuses a CLI backend whose `prepareExecution` does not return `isolatedCompletionEnforced: true` | byte-identical gate | same | same | CONFIRMED |
| 2 | The flag is absent from the public `CliBackendPreparedExecution` type (only `toolAvailabilityEnforced` is public) | yes | yes | yes | CONFIRMED |
| 3 | Core passes the private `isolatedCompletion{Cwd,ModelId,Prompt,SystemPrompt}` context to **every** backend, bundled or not (only `authCredential` is bundled-gated) | yes | yes | yes | CONFIRMED |
| 4 | The bundled Claude backend sets the flag purely from `isolatedCompletionPrompt !== undefined`; its actual isolation is the **side-question argv projection** in `resolveClaudeCliExecutionArgs` | yes | yes | yes | CONFIRMED |
| 5 | multi-clawd's `preparedForLaunch` never sets the flag; `resolvePoolExecutionArgs` has no side-question branch | yes | yes | yes | CONFIRMED |
| 6 | Pool argv for an isolated completion lacks exactly `--no-session-persistence --max-turns 1` versus the bundled backend | measured | not run (no dist) | measured | CONFIRMED |
| 7 | The pool declares `sideQuestionToolMode: "disabled"` but does not project the side-question argv, so ordinary side-questions keep native tools | yes | yes | yes | CONFIRMED (new finding, see below) |
| 8 | Live impact on this box: refusals in the gateway journal since 2026-11-01 | 0 of 67,065 lines | n/a | n/a | CONFIRMED (observed) |

## Findings

### 1. The gate, the type and the context (upstream-private contract)

`src/agents/cli-runner/prepare.ts` declares a module-private widening of the SDK type and gates on it after `prepareExecution` returns:

```ts
type PrivateCliBackendPreparedExecution = CliBackendPreparedExecution & {
  isolatedCompletionEnforced?: true;
  secretInput?: CliSecretInput;
};
// ...
if (params.isolatedCompletion && preparedExecution?.isolatedCompletionEnforced !== true) {
  throw unsupportedIsolatedCompletionError(backendResolved.id);
}
```

The compiled gate line is byte-identical in the pinned 2026.8.1 dist (`prepare.runtime-y2eXKhY3.js`) and the installed 2026.11.1 dist (`prepare.runtime-_N6IgijZ.mjs`); the tagged 2026.10.10 source carries the same lines (177 and 1187). The error (`execution-target.ts`) is `CLI backend "<id>" does not support isolated completion; OpenClaw did not start the run.` with `code: "unsupported"`, so the failure is a clean pre-launch refusal: no process is started and no session is touched.

The public type in `src/plugins/cli-backend.types.ts` (and the shipped `.d.ts`, `config-contracts-*.d.ts` in 2026.11.1, `types-*.d.ts` in 2026.8.1) lists `env`, `clearEnv`, `beforeExecution`, `cleanup`, `toolAvailabilityEnforced?: true` and `execute`. No `isolatedCompletionEnforced`.

Core builds the `prepareExecution` context with the private fields for all backends:

```ts
// Bundled owners may project this through a native per-process system-prompt
// channel. Keep it private so exact isolated inference does not expand the SDK.
...(params.isolatedCompletion ? { isolatedCompletionCwd: cwd, isolatedCompletionModelId: normalizedModel,
     isolatedCompletionPrompt: params.prompt, isolatedCompletionSystemPrompt: params.extraSystemPrompt ?? "" } : {}),
```

Only `authCredential` is restricted to bundled backends (`backendAuthPolicy ? { ...ctx, authCredential } : ctx`). So the runtime wire contract already reaches multi-clawd; what is missing is the *type* and the *documentation*. The bundled Gemini backend (`extensions/google/cli-backend-auth.runtime.ts`) reads the same fields through a local widened type and sets the same flag, which shows the pattern upstream itself uses.

### 2. What "enforced" means for the bundled Claude backend

`extensions/anthropic/cli-backend.ts` (identical in 2026.10.10 and 2026.11.1; same shape in 2026.8.1):

```ts
const isolatedCompletion = credentialContext.isolatedCompletionPrompt !== undefined;
// ...
return {
  env,
  // The paired side-question argv projection disables settings, memory,
  // hooks, session persistence, and tools before process launch.
  ...(isolatedCompletion ? { isolatedCompletionEnforced: true as const } : {}),
  ...
};
```

The flag is a promise that the backend's `resolveExecutionArgs` will apply `resolveClaudeCliSideQuestionExecutionArgs` (`extensions/anthropic/cli-shared.ts`): strip session, resume, fork, effort and tool flags, then append `--safe-mode --tools "" --disallowedTools mcp__* --strict-mcp-config --no-session-persistence --max-turns 1 --permission-mode default`. Isolated completions also arrive with `cliToolAvailability: { native: [], openClaw: [] }` and `disableTools: true` (`src/agents/isolated-completion.ts`, `runCliIsolatedCompletion`), so the restricted projection runs afterwards and re-strips `--safe-mode`, `--permission-mode` and `--strict-mcp-config` (re-adding the last). What survives from the side-question step and is unique to it: **`--no-session-persistence`** (the prompt is not written to the account's `~/.claude/projects` transcript store) and **`--max-turns 1`**.

### 3. The pool's actual argv gap (measured)

`resolvePoolExecutionArgs` (`src/tool-cap.ts`) is a faithful port of the *restricted* projection only; it ignores `executionMode`. Running the installed bundled resolver in a child process against the pool's verified-launch base argv (test file below) gives, for an isolated completion (`side-question` + empty cap):

| | argv tokens |
|---|---|
| bundled only | `--no-session-persistence`, `--max-turns`, `1`, `mcp__*` (bare denial list) |
| pool only | `Bash(run_in_background:true),CronCreate,Monitor,ScheduleWakeup,mcp__*` (the pool keeps the operator's base denials merged into the list) |
| both | `--tools ""`, `--setting-sources ""`, `--settings {restricted}`, `--disable-slash-commands`, `--no-chrome`, `--strict-mcp-config` |

Identical result on 2026.8.1 and 2026.11.1 (both dists export `resolveClaudeCliExecutionArgs`). The pool's extra denials widen nothing with `--tools ""` present. So, had the pool set the flag today, the only untruthful part would have been session persistence and the turn bound: real, but narrow.

### 4. New finding: `sideQuestionToolMode: "disabled"` is declared but not enforced on ordinary side-questions

For a plain side-question with no cap (`/btw`, setup inference probes, the session observer and activity summary callers in `server-runtime-subscriptions`, all of which launch with `executionMode: "side-question"` in the 2026.11.1 dist), the bundled resolver emits the full projection, while the pool returns its base argv untouched:

| bundled only (pool lacks) | `--safe-mode`, `--tools ""`, `--disallowedTools mcp__*`, `--strict-mcp-config`, `--no-session-persistence`, `--max-turns 1`, `--permission-mode default` |
|---|---|

Core relies on the declaration: `prepare-tool-policy.ts` skips the empty-cap injection for side-questions (`params.disableTools === true && !input.isSideQuestion && ...`) and the `disableTools` guard in `prepare.ts` is satisfied by `sideQuestionDisablesNativeTools`, with the comment "backend-enforced tool-free questions have no file authority". On the pool nothing enforces it, so a side-question runs Claude Code with its native tools selectable, under `--permission-mode bypassPermissions` when the operator's exec mode is `full` (`src/exec-policy.ts`). Bundle MCP is not injected for side-questions (`skipsTurnPreparation`), so OpenClaw tools are not reachable; native Bash, Edit and Write are. This is a parity and policy gap in the same code path as #137 and is the reason the #137 fix must start with the side-question projection, not with the flag. Filed separately (see "Issues filed").

### 5. When does an isolated completion reach the pool?

`resolveIsolatedCompletionRoute` (`src/agents/isolated-completion-route.ts`) picks a CLI owner when the requested provider is a CLI runtime alias (`isCliRuntimeAliasForProvider`), when the model runtime policy names one (`resolveCliRuntimeExecutionProvider`), or when the embedded dispatch eligibility selects one. Purposes (`src/agents/run-trigger.ts`): `isolated-completion`, `session-activity-summary`, `session-observer`, `conversation-label` (the `utilityModel` setting in `conversation-label-generator`), `progress-narration`, `transcript-summary`, `plugin-completion`.

- CONFIRMED: a model ref whose provider is a pool id (`clawd/...`, `claw<N>/...`) chosen for one of those purposes reaches `runCliIsolatedCompletion` and is refused at the gate.
- LIKELY: `resolveCliRuntimeBinding` resolves a plugin backend through `resolveCliBackendModelProvider`; multi-clawd declares no `modelProvider`, so whether an `anthropic/*` utility ref can be *re-routed* onto the pool (as happens for `claude-cli`) was not traced to a definite answer. Not needed for the fix; noted so nobody assumes it.
- CONFIRMED (observed): `journalctl --user -u openclaw-gateway --since 2026-11-01` holds 67,065 lines and 0 occurrences of `does not support isolated completion` or `IsolatedCompletionUnsupportedError`. The box's routing does not send isolated completions to the pool today. The "isolated" hits in that window are Telegram polling diagnostics.

## Decision for this slot

No runtime change. The honest implementation touches exactly the two files #136 is editing (`src/tool-cap.ts` for the projection, `src/index.ts` for the flag), and setting `isolatedCompletionEnforced` without the projection would be a false claim. This slot therefore ships:

1. `tests/issue-137-isolated-completion-contract.test.ts`: eight fixture tests, passing 8/8 against the pinned 2026.8.1 dist and 8/8 against the installed 2026.11.1 dist (`MULTI_CLAWD_OPENCLAW_DIST=/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist`), both runs on 2026-11-08 16:20 UTC. They pin: the gate and its text; the private context fan-out; the public type still lacking the flag (this test fails on purpose when upstream publishes it); the pool's documented refusal on legacy and verified launches; the exact argv diff of findings 3 and 4.
2. This report.

## Next implementation scope (after #136 merges, same files)

Status 2026-11-09: #136 has merged (PR #141, master 77a706f) and the #147 shim EPIPE fix has merged (PR #149, master f5534e1). The side-question argv projection (step 1 below) is the subject of open PR #150 for #142, still pending review and unreleased; this PR does not depend on it and does not claim it. Step 2 (the flag) remains unimplemented and blocked on step 1 landing.

1. **`src/tool-cap.ts`:** add a port of `resolveClaudeCliSideQuestionExecutionArgs` and apply it in `resolvePoolExecutionArgs` when `ctx.executionMode === "side-question"`, before the restricted projection, in the same order as the bundled resolver (host-owned Bash denial, side-question projection, restricted projection). Byte-parity target: the two `missing` arrays in the new test become empty. Also port the bundled denial handling so the merged list matches (`mcp__*` only, operator denials dropped once `--tools ""` is in force) or document the delta.
2. **`src/index.ts` `preparedForLaunch`:** when the context carries `isolatedCompletionPrompt !== undefined` (read through a local `PoolPrepareContext = CliBackendPrepareExecutionContext & { isolatedCompletionPrompt?: string; ... }`, exactly as the bundled backends do), return `{ env, isolatedCompletionEnforced: true as const }` typed through a local `PoolPreparedExecution = CliBackendPreparedExecution & { isolatedCompletionEnforced?: true }`. Only together with step 1, never alone. Keep `execute` undefined (core runs the process itself for side-questions; `resolveCliExecutionTarget` returns `process`).
3. **Legacy launch (shim via `process.execPath`):** the shim forwards unknown flags, but confirm `--no-session-persistence` and `--max-turns 1` pass through unchanged and that the shim's sibling retry (`RETRY_ROSTER_ENV`) stays correct for a prompt-only run with no session id. Add a shim-integration case.
4. **Tests to flip:** the two `missing` expectations and the two `isolatedCompletionEnforced` expectations in the new suite; add an ordinary side-question parity case to `tests/tool-cap.test.ts`.
5. **Fail-closed property to keep:** if upstream renames the private fields, the pool silently returns to "unsupported" and core refuses before launch. No process is killed, no session or data is touched, and the invariant "never run out" is unaffected because isolated completions are not part of the model fallback chain for chat turns.
6. **Release note:** Compatibility, with the upstream contract caveat.

Security review: steps 1 and 2 change what a side-question process may do (they *remove* capability), so they qualify for the FULL review tier under the loop's speed rules.

## Upstream contract need (not filed: external write, owner approval required)

Proposed openclaw/openclaw issue text, for Michael or the lane with approval:

> **Title:** plugin-sdk: expose the isolated-completion contract to third-party CLI backends
>
> `src/agents/cli-runner/prepare.ts` refuses an isolated completion unless `prepareExecution` returns `isolatedCompletionEnforced: true`, and passes `isolatedCompletionCwd/ModelId/Prompt/SystemPrompt` in the prepare context. Neither appears in `CliBackendPreparedExecution` / `CliBackendPrepareExecutionContext` (`src/plugins/cli-backend.types.ts`); the comment says "Keep it private so exact isolated inference does not expand the SDK." A third-party Claude Code backend (e.g. `@drakon-systems/multi-clawd`, which mirrors `extensions/anthropic/cli-backend.ts`) can only support `conversation-label`, `session-observer`, `transcript-summary` and plugin completions by casting into that private shape, exactly as `extensions/google/cli-backend-auth.runtime.ts` does. Request: either (a) add both to the public types with the enforcement semantics documented ("the backend's `resolveExecutionArgs` applies a tool-free, persistence-free, single-turn projection"), or (b) add a declarative `isolatedCompletionEnforcement: "execution-args"` field analogous to `toolAvailabilityEnforcement`, so core can verify the projection itself. Same code in v2026.8.1, v2026.10.10 and v2026.11.1.

Until then the #137 issue carries `blocked:upstream` for the clean fix and stays open for the private-contract implementation above.

## Verified OK (by source)

- `resolveCliExecutionTarget`: a side-question with no `execute` runs as `process` (host-owned), as the pool already relies on (tests/host-execute-target.test.ts).
- Core sets `sessionMode: "none"` for side-questions (`prepare.ts`), so no `--session-id` is passed on the pool either; the missing `--no-session-persistence` concerns Claude Code's own transcript file, not OpenClaw's session store.
- The 2026.8.1 bundled backend already set the flag (`isolatedCompletion ? { isolatedCompletionEnforced: true } : {}`), so this is pre-existing on the whole supported range, not a regression.
- Claude Code 2.1.319 on this box accepts `--no-session-persistence`, `--max-turns`, `--safe-mode`, `--strict-mcp-config`, `--permission-mode`, `--tools` (`claude --help`, local only).

## Untested

- The pool with the projection applied (not implemented here).
- An isolated completion end-to-end on any box (none routes to the pool today; see finding 5).
- 2026.10.10 dist execution (no dist installed; source identical to 2026.11.1 for every file cited).

## Issues filed

- #142 pool: side-questions ignore the declared `sideQuestionToolMode: "disabled"` projection (finding 4). Prerequisite for the #137 implementation; linked from #137.

## Refresh 2026-11-09

Branch refreshed by merging `origin/master` f5534e1 (no rewrite). Merged since the original run: #139 (#134), #140 (#135 SDK contract suite), #141 (#136 host-owned tools: `hostOwnedTools` exec/process, native Bash disabled on host-owned turns), #149 (#147 shim stdin EPIPE fix). Pending, not merged, not released: PR #150 (#142 side-question tool-free projection).

- #141 only adds the host-owned Bash denial; it does not port the side-question projection. The two argv-gap tests in this PR (findings 3 and 4) therefore still hold unchanged; they were re-run on the merged tree (8/8). When #150 merges, the ordinary side-question `missing` expectation in finding 4 is expected to flip and the test should be updated in that PR or a follow-up.
- The Node 22 CI failure on the earlier head was the pre-existing shim EPIPE crash (#147), fixed by #149, not this PR's tests.
- No runtime change; no upstream fix is claimed; #137 stays `blocked:upstream`.
