---
name: multi-clawd
description: >
  Pool multiple Claude Max accounts into one OpenClaw failover chain — same
  model, next account, full Claude Code harness on every hop. Installs the
  multi-clawd OpenClaw plugin and drives its CLI (setup wizard, login,
  explain, doctor, update). Reads/writes local OpenClaw config only; never
  captures, stores, or prints OAuth token values. Network calls: npm/registry
  installs only.
license: MIT
metadata:
  author: Drakon Systems
  version: 1.4.1
  category: devtools
  tags:
    - openclaw-plugin
    - claude-failover
    - multi-account
    - claude-max
    - rate-limits
    - model-routing
  source: https://github.com/Drakon-Systems-Ltd/multi-clawd
---

# 🦞 multi-clawd

One Claude is never enough. multi-clawd is an OpenClaw plugin that pools every
Claude Max account you own: when one account hits its usage limit, the next
account carries the **same model** — no tier drop, no leaving Claude — with the
full Claude Code harness intact on every hop. A sticky pool backend (`clawd`)
rotates proactively on live rate-limit health, before the limit error hits.

## Install / update

The CLI owns the whole lifecycle:

```bash
npm i -g @drakon-systems/multi-clawd   # once

multi-clawd update      # install (or update) the OpenClaw plugin — right flags, restart offer, doctor
multi-clawd setup       # guided wizard: accounts, isolated second login, pool, eviction watchdog
multi-clawd login claw2 # launch the right Claude sign-in flow for an account (or re-auth it)
multi-clawd explain     # the whole setup in plain English — accounts, chain, live health
multi-clawd doctor      # health check (--probe for a live end-to-end turn)
```

No global install needed: every command also runs as
`npx @drakon-systems/multi-clawd <cmd>`.

## Agent-driven setup

If you are an AI agent installing this for your human, follow the dedicated
guide — it bakes in the guardrails (config backup first, merge-don't-overwrite,
never print tokens, contained verification probe):

https://raw.githubusercontent.com/Drakon-Systems-Ltd/multi-clawd/master/SETUP-AGENT.md

Hard rules from that guide, always in force:

1. Back up `~/.openclaw/openclaw.json` before touching it; merge with a JSON
   read-modify-write, never rewrite from memory.
2. **Never print, log, or echo OAuth token values** — not even partially.
3. The second account's browser OAuth login belongs to the human. Ask them;
   never attempt it yourself.
4. Do not change the model failover chain (primary/fallbacks) unless the human
   explicitly asks — registration and routing are separate decisions.

## How it fits together

- Each extra account gets an **isolated** Claude config dir (e.g. `~/.claw2`)
  and its own OAuth token file (0600) or secret reference (1Password `op://`
  refs supported) — account #2 never touches account #1's login.
- Models appear as e.g. `claw2/claude-fable-5`; the pooled backend appears as
  `clawd/<model>` and picks the healthiest account per launch, with anti-flap
  hysteresis and window-reset "return home".
- `multi-clawd setup` schedules the **eviction watchdog** (systemd user timer
  on Linux, launchd on macOS) guarding against the upstream scoped-activation
  eviction bug (openclaw/openclaw#107408 — fix PR #107596 in flight).
- Platforms: Linux ✅ (production-proven), macOS ✅, Windows via WSL2 ✅,
  native Windows expected to work.

Source, changelog and full docs: https://github.com/Drakon-Systems-Ltd/multi-clawd
