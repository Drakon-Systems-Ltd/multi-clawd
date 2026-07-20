# multi-clawd — agent setup guide

> **You are an AI agent** (an OpenClaw assistant, Claude Code, or similar)
> and your human has asked you to install multi-clawd on this machine.
> Follow this guide exactly. Where it says **ASK YOUR HUMAN**, stop and ask —
> one step genuinely needs them.

## Ground rules (non-negotiable)

1. **Back up before touching config:** `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-multiclawd-$(date +%Y%m%d)`
2. **Merge, never overwrite** — edit `openclaw.json` with a JSON read-modify-write (jq/python), not by rewriting the file from memory.
3. **Never print, log, or echo token values.** Not even partially.
4. **Do not change the model failover chain (primary/fallbacks) unless your human explicitly asks.** Registration and routing are separate decisions.
5. Report everything you changed (files + config keys) when you finish.

## 1. Preflight

```bash
openclaw --version    # need >= 2026.6
which claude          # Claude Code CLI must be on PATH
node --version
```

If OpenClaw is older than 2026.6, stop and tell your human to upgrade first.
If `claude` is missing: `npm install -g @anthropic-ai/claude-code`.

## 2. Install the plugin

**Registry install (recommended)** — the gateway pulls the prebuilt
package; no clone, no build, nothing to keep in sync:

```bash
openclaw plugins install @drakon-systems/multi-clawd --pin
```

**From source** (contributors, or ahead of a published release):

```bash
git clone https://github.com/Drakon-Systems-Ltd/multi-clawd.git /tmp/multi-clawd
cd /tmp/multi-clawd && npm install && npm run build
openclaw plugins install "$(pwd)"
```

## 3. Second-account login — **ASK YOUR HUMAN**

**Prefer the wizard.** `node scripts/setup.mjs` (or `npm run setup` in a
checkout) walks through accounts, token storage, and the pool, and merges
`openclaw.json` non-destructively with a backup — it replaces steps 3–4 and
most of 6. Run it WITH your human present: the second-account OAuth login in
the middle of it is theirs to do, never yours. `--dry-run` previews the
changes first. The manual steps below remain for when the wizard can't run.

Create the isolated config dir, then hand control to your human for the
OAuth login (it opens a browser and needs their credentials — you cannot
and must not do this part for them):

```bash
mkdir -p ~/.claw2 && chmod 700 ~/.claw2
```

Tell your human to run, in their own terminal:

```bash
CLAUDE_CONFIG_DIR=~/.claw2 claude setup-token
```

…logging in as the **second** Claude account, and to save the printed
setup-token to `~/.claw2/oauth-token`. When they confirm it's done:

```bash
chmod 600 ~/.claw2/oauth-token
```

Verify the file exists and is non-empty (`test -s ~/.claw2/oauth-token && echo ok`) — without reading it aloud.

## 4. Wire the config

Merge into `~/.openclaw/openclaw.json` (backup first — rule 1):

- `plugins.entries["multi-clawd"]` = `{ "enabled": true, "config": { "accounts": [ { "id": "claw2", "label": "Second Claude", "configDir": "~/.claw2", "oauthTokenFile": "~/.claw2/oauth-token" } ] } }`
- If `plugins.allow` exists, append `"multi-clawd"`.
- `agents.defaults.models["claw2/claude-fable-5"]` = `{}` (add entries for any other claw2 models your human wants agents to use).

## 5. Restart and verify

```bash
openclaw gateway restart
sleep 15
openclaw infer model list | grep -c claw2   # expect >= 1
```

Check the gateway journal/log for the plugin's own confirmation lines:

```
[multi-clawd] register() pass — config source: ..., accounts: 1
[multi-clawd] registered 1 backend(s)+provider(s): claw2
```

Then run one contained probe (file-redirected — never into a live chat):

```bash
openclaw agent --agent main --session-key agent:main:mc-setup-probe \
  --model claw2/claude-fable-5 --json \
  --message "Reply with exactly this line and nothing else: MC_SETUP_OK. Do not use any tools." \
  > /tmp/mc-setup-probe.out 2>&1
grep -o "MC_SETUP_OK" /tmp/mc-setup-probe.out | head -1
```

`MC_SETUP_OK` = the second account works end-to-end.

## 6. Optional: the pool (proactive rotation) — **ASK YOUR HUMAN**

Ask whether they want the pooled backend: one id (`clawd`) fronting all
their Claude accounts, where each launch runs on the first account that is
not nearly maxed out (live `rate_limit_event` health; hand over BEFORE the
limit error, return home when the window resets). If yes, merge:

- Add the main login as a pooled account:
  `{ "id": "claw1", "label": "Main Claude", "native": true }`
  (native = default config dir / OS keychain; set NO configDir and NO token
  for it — on macOS the keychain is only consulted when CLAUDE_CONFIG_DIR
  is unset).
- `plugins.entries["multi-clawd"].config.pool` =
  `{ "id": "clawd", "accounts": ["claw1", "claw2"] }`
- `agents.defaults.models["clawd/claude-fable-5"]` = `{}`

Schema note: if the currently-installed copy of the plugin predates these
config keys, `openclaw plugins install --force` validates the live config
against the OLD manifest and refuses. Run `node scripts/doctor.mjs
--preflight` first — it prints the exact keys to strip. Order matters:
strip the new keys from openclaw.json → force-install → re-add the keys →
restart.

Token hygiene (v0.3, preferred): instead of `oauthTokenFile`, use
`"oauthTokenRef": { "source": "exec", "provider": "<your-secret-provider>",
"id": "op://Vault/Item/field" }` — resolved through the gateway's configured
secret providers, so no plaintext token sits on disk. Sources are mutually
exclusive per account. When migrating an existing token file into a vault, don't panic if the
vault copy diffs from the file by a trailing newline — `op read` appends
one on output; resolution trims it (guaranteed).

After any install or upgrade, run `npm run doctor` (add `--probe` to spend
one turn proving the pool answers). Fix every ❌ before reporting done.
Registry upgrade (npm / ClawHub): `openclaw plugins install
@drakon-systems/multi-clawd@latest --force` → `openclaw gateway restart` →
doctor. From source the full sequence is `git pull` → `npm install` →
`npm run build` → `npm run doctor`; run the build explicitly — the
`prepare` hook does not reliably refresh `dist/` on this path.
Use plain `npm install`, NOT `npm install --omit=dev`: the build needs
`tsc` from devDependencies, so omitting dev deps breaks the explicit build
step (source path only — registry installs ship prebuilt `dist/`).

## 7. Routing — **ASK YOUR HUMAN**

Ask whether they want `clawd/claude-fable-5` (pool) or `claw2/claude-fable-5`
(single account) in the failover chain — typical: pool as primary with
non-Anthropic providers as fallbacks, or first fallback after their current
primary — or left unrouted for manual/per-agent use. Apply only what they
choose, same merge discipline, and confirm the final chain back to them.

## 8. Known issue you should warn about

On OpenClaw ≤ 2026.7.1, an **idle** plugin CLI backend can be silently
evicted by core's scoped harness activation
([openclaw#107408](https://github.com/openclaw/openclaw/issues/107408),
fix pending in [openclaw#107596](https://github.com/openclaw/openclaw/pull/107596)).
Symptom: `Unknown CLI backend: claw2` while the model catalog still lists
it. A gateway restart always heals it. If any backend will sit idle in a
fallback chain, offer to schedule the bundled watchdog
(`node scripts/eviction-watchdog.mjs` from cron/launchd every ~5 min) until
the upstream fix ships.

## 9. Report

Tell your human: what was installed and where, the exact config keys
added, the backup file path, the probe result, and the routing decision
applied. You're done. 🦞
