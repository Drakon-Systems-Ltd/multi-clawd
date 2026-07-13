# multi-clawd

**Multi-account Claude Code failover for [OpenClaw](https://docs.openclaw.ai).**

Register additional Claude (Max/Pro) logins as first-class OpenClaw CLI
backends, so your failover chain pools **all** your Claude accounts before ever
dropping a model tier — with the full skills/MCP tool harness intact on every
account.

> Built by [Drakon Systems Ltd](https://drakonsystems.com). MIT licensed.

## Why

OpenClaw's bundled `claude-cli` backend runs one Claude Code process on a
**single** login. When that account hits a usage limit, OpenClaw can't move the
running subprocess onto a second Claude account — it drops to the next *model*
(e.g. Opus) instead. If you own two Claude Max accounts, the second one's
capacity just sits idle.

This plugin fixes that. It registers each extra account as its own backend
(`claw2/…`, `claude-work/…`, …) that OpenClaw can step to as a normal
fallback — same model, next account — keeping Claude Code's native tools,
skills, and the OpenClaw MCP bridge on every hop.

```
claude-cli/claude-fable-5      # main login
  → claw2/claude-fable-5   # 2nd login (this plugin) — same model, harness intact
    → anthropic/claude-opus-4-8    # only now drop a tier
```

## Install

```bash
openclaw plugins install multi-clawd
```

(or clone + `npm install && npm run build`, then
`openclaw plugins install /path/to/multi-clawd`)

## Set up a second account

1. Create an isolated config dir and capture that account's Claude Code
   setup-token into it:

   ```bash
   mkdir -p ~/.claw2 && chmod 700 ~/.claw2
   CLAUDE_CONFIG_DIR=~/.claw2 claude setup-token   # log in as the 2nd account
   # store the token where the plugin can read it (0600):
   #   ~/.claw2/oauth-token
   ```

2. Configure the plugin (in `openclaw.json`; if `plugins.allow` is set, add
   `"multi-clawd"` to it):

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
                 "label": "iCloud Max",
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
   iCloud account on the same model before any tier drop.

## Security

Tokens are never committed and never logged. Prefer a secret reference
(`oauthTokenRef`) over a plaintext file; when a file is used, keep it `0600`.
See [`DESIGN.md`](./DESIGN.md).

## Status

Early (v0.1). See [`DESIGN.md`](./DESIGN.md) for the design, the approaches that
*don't* work, and the roadmap.
