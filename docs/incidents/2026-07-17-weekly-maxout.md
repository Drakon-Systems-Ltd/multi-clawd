---
name: incident-2026-07-17-weekly-maxout
description: "Full incident report, 17-18 Jul Fable weekly max-out — evidence, root causes, v0.3.6 recommendations (stashed here while workspace writes are blocked)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ffdc6612-ccaa-47e9-9bfc-f6450e1bf19c
---

# Incident: 17–18 Jul 2026 — Fable weekly max-out, same-account tier-drop instead of pool flip

**Status:** Evidence complete — all three hosts verified. Friday-Mac + clawdbot1 + aiquant sections verified from raw sources.
**Compiled by:** FRIDAY (Friday-Mac), 18 Jul 2026 ~08:00 UTC.
**Intended home:** multi-clawd repo `docs/incidents/` (Friday-Mac write-blocked everywhere except this memory tree this session — Jarvis to commit, or FRIDAY on a write-capable wake).
**Impact:** Michael's boxes tier-dropped Fable→Opus on the *same* account (clawdbot1) or fell out of Claude entirely to Grok (Friday-Mac) while a second pool account was configured. v1.0 input; supports shipping v0.3.6 as specced.

Both accounts' weekly windows reset **21 Jul 01:00 UTC** (`resetsAt 1784595600`). Note: an earlier read of this epoch as "09:00 UTC" was wrong — ship-day timing should use 01:00 UTC.

## Timeline (UTC)

| When | Host | Event | Source |
|---|---|---|---|
| 15 Jul 19:52 | clawdbot1 | claw1.json last write — **no weekly window ever captured** for home account (five_hour only) | claw1.json mtime |
| 17 Jul 18:20:38 | Friday-Mac | claw1 rejection recorded under window **"unknown"** — the model-scoped Fable-limit 429 with no recognisable window id | claw1.json `windows.unknown` |
| 17 Jul ~evening | clawdbot1 | Michael observes Fable→Opus same-account tier-drop; Opus turns on provider `claude-cli` | Jarvis log review |
| 17 Jul 22:20:36 | Friday-Mac | **Pool rotation WORKED**: `pool clawd: rotated to claw2 from claw1 (seven_day_overage_included utilization 0.91 >= 0.85)` | gateway log 2026-07-17 line 651 |
| 18 Jul 03:01 | clawdbot1 | claw2 (iCloud Max) weekly seen at **0.98 allowed_warning** | claw2.json (Jarvis) |
| 18 Jul 04:20:41 | Friday-Mac | claw1 weekly seen at **0.98 allowed_warning** | claw1.json |
| 18 Jul 05:20:35 | Friday-Mac | Rotation to claw2 again on gateway start (0.98 ≥ 0.85) | gateway log 2026-07-18 line 56 |
| 18 Jul 05:20–07:42 | Friday-Mac | Repeated Fable 429s **while sticky on claw2**: `You've reached your Fable 5 limit.` (sessions b701e073, 11a4759b) | model_fallback_decision events ×12 |
| 18 Jul 07:42:22 / 07:44:48 | clawdbot1 | Live failures: `embedded_run_agent_end isError model=claude-fable-5 "API rate limit reached" failoverReason=rate_limit` → `decision=rotate_profile`; Opus-4-8 served at 07:27/07:32/07:42 on `claude-cli` — **same-account tier-drop in the act** | Jarvis log review |
| 18 Jul 07:41:35 | Friday-Mac | claw2 weekly flips to **status "rejected"** in state — **true pool exhaustion** (claw1 0.98 warning + claw2 rejected) | claw2.json |
| 18 Jul 07:44 | Friday-Mac | Chain fix applied: full `clawd/` tier ladder (fable→opus-4-8→opus-4-7→sonnet-5) + pool compaction/subagents | openclaw.json, backup `.bak-clawd-chain-20260718-084429` |
| 18 Jul 07:46:40 | Friday-Mac | `pool clawd: returning home to claw1` (claw2 rejected outranks claw1 warning); next turn serves claude-fable-5 on claw1, no fallback | gateway log 2026-07-18 line 296 |

## Per-host findings

### Friday-Mac (pool exercised — partial success, then exhaustion)
- Proactive seven_day rotation fired correctly twice (0.91, 0.98). The pool *worked*.
- But the **model-scoped Fable 429 is invisible to it**: recorded under window `"unknown"`, which the reader ignores and newer shims drop (`src/shim.ts:115` — "the 'unknown'/junk buckets the reader already ignores are dropped here"). Rotation logic never sees model-scoped rejections. **Direct evidence for the v0.3.6 model-scoped rejected-window shim.**
- On in-flight 429 the runtime walks the **fallback chain**, not the pool. Pre-fix chain skipped Claude tiers: `clawd/claude-fable-5` → `openai/gpt-5.6-sol` (**401 auth-dead**: profile is OAuth, `openai-responses` needs an API key) → `xai/grok-4.5` succeeded. Morning turns were served by Grok.
- v0.3.5 `pool.degrade.ladder` **not opted in** — this exhaustion window (both accounts weekly-hot) is exactly its use case.

### clawdbot1 (pool configured, never exercised — two stacked faults)
- (a) **No weekly telemetry on home account** — claw1.json never captured a seven_day window at all (absent, not sub-threshold), so proactive rotation could never trigger; reactive 429 handling then stepped down tiers on the same account.
- (b) **Routing bypass** — overnight Fable turns ran on provider `claude-cli` via an `anthropic/claude-fable-5` primary, never entering the `clawd` pool provider. Rotation could not have intercepted them regardless of telemetry. Local fix: `clawd/`-prefixed primary + fallback chain (as applied on Friday-Mac 18 Jul 07:44 UTC).
- `doctor --preflight` reported READY 🦞 while (b) was live — **false READY**.
- Account mapping: home = claw1 = native Claude sub; claw2 = iCloud Max (`~/.claude-icloud`, OAuth via 1Password) — the **same iCloud sub Case's aiquant claw2 uses**.

### aiquant (Case) — clean negative

**Outcome:** incident did NOT reproduce. No Fable max-out, no 429, no same-account tier-drop, no organic pool rotation in the 17 Jul 18:00 → 18 Jul 07:40 window.

**Why:** aiquant runs `openai/gpt-5.6-sol` as PRIMARY; the clawd pool is fallback-only and carried no overnight Claude load, so there was nothing to max out.

**State files (raw):**
- `claw2.json` — five_hour "allowed" only; last real write 07:30 18 Jul. Home account.
- `claw3.json` — untouched Jul 15 22:09 → 18 Jul (only later write is Case's 07:44 forced-failover test, since cleaned).
- **No seven_day/weekly window has ever been written** — confirmed against live state AND reconcile backups. Same structural gap as clawdbot1's claw1: weekly telemetry absent, not below-threshold.

**Logs:** zero model_fallback_decision / rate-limit / isError on any Claude backend overnight. Only `pool clawd: rotated` line (07:44:31 18 Jul) is the Case forced-failover test, not incident traffic.

**Fault mapping:**
- Fault (a) — CONFIRMED structurally (no weekly telemetry ever persisted → pool blind on a weekly 429).
- Fault (b) — N/A: chain is `clawd/`-prefixed end-to-end; subagents on sol; allowlist carries both referenced Claude rungs. No anthropic/→claude-cli bypass.

**Topology risk (fleet-wide):** aiquant's HOME account is the shared iCloud Max sub — the same account sitting ~0.98 on Friday-Mac and clawdbot1. Single point of exhaustion for three boxes until the 21 Jul reset; aiquant is most exposed because it's home here with no weekly telemetry to flip on.

## Root causes
1. **Model-scoped limit windows are invisible to the pool.** Fable-limit 429s carry no known window id → bucketed `"unknown"` → ignored/dropped. → **v0.3.6 shim (as specced).**
2. **Weekly telemetry can be entirely absent** for an account (clawdbot1 home), silently disabling proactive rotation. → Jarvis's seven_day autopsy fix.
3. **Reactive 429 handling consults the fallback chain, not the pool** — same-account tier-drop (clawdbot1) or provider-hop (Friday-Mac) while a healthy-ish second account sat configured.
4. **Chain routing can bypass the pool provider entirely** (`anthropic/`, `clawN/`, or non-Claude-first chains). Config-level fix known; **doctor gives a false READY** on this state.
5. **Capacity topology:** 3–4 hosts lean on 2 Claude subs; the shared iCloud Max burns fastest (0.98 on two hosts' state). With both weekly windows hot, even correct flips buy little until 21 Jul 01:00 UTC.
6. **Non-Claude fallback health:** Friday-Mac's OpenAI fallbacks are auth-dead (OAuth profile vs API-key requirement); only Grok held the line. The last line of defence during pool exhaustion was one working provider deep.

## Recommendations
- **Ship v0.3.6 as specced** — model-scoped rejected-window shim. Evidence: Friday-Mac `unknown` rejection 17 Jul 18:20 UTC + repeated claw2-sticky Fable 429s.
- **v0.3.6 doctor addition (proposed):** verify each agent's *live* primary/fallback chain actually routes through the pool provider; warn on `anthropic/`/`clawN/` pins and on Claude-tier-skipping chains. Would have caught clawdbot1 fault (b) instead of READY.
- **Fleet config sweep:** all hosts to `clawd/`-prefixed full tier chains (Friday-Mac done 18 Jul; clawdbot1 done; aiquant N/A — sol-primary by design, chain already `clawd/`-prefixed and clean).
- **Fleet auth sweep:** verify non-Claude fallback providers actually authenticate (Friday-Mac OpenAI is dead; needs `openclaw models auth login --provider openai` or an API-key profile).
- **Consider `pool.degrade.ladder` opt-in** on at least one host before the 21 Jul reset if exhaustion persists — its designed scenario is live right now.
- **Capacity:** flag shared-iCloud-sub contention to Michael (third sub, or host↔account affinity).
