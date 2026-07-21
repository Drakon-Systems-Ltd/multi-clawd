# multi-clawd — agent setup guide

> **You are an AI agent** (an OpenClaw assistant, Claude Code, or similar)
> and your human has asked you to install multi-clawd on this machine.
> Follow this guide exactly. Where it says **ASK YOUR HUMAN**, stop and ask —
> one step genuinely needs them.

## Ground rules (non-negotiable)

1. **Back up before touching config:** `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-multiclawd-$(date +%Y%m%d)`
   (the wizard also makes its own backup, but yours costs nothing).
2. **Merge, never overwrite** — if you ever edit `openclaw.json` by hand, use a
   JSON read-modify-write (jq/python), not a rewrite from memory. Prefer
   letting the wizard do the merging.
3. **Never print, log, or echo token values.** Not even partially.
4. **Do not change the model failover chain (primary/fallbacks) unless your
   human explicitly asks.** Registration and routing are separate decisions.
5. Report everything you changed (files + config keys) when you finish.

## 1. Preflight

```bash
openclaw --version    # need >= 2026.6
which claude          # Claude Code CLI must be on PATH
node --version
```

If OpenClaw is older than 2026.6, stop and tell your human to upgrade first.
If `claude` is missing: `npm install -g @anthropic-ai/claude-code`.

## 2. Install + configure — one wizard does it

Since v1.2 the package ships its own CLI; it replaces every manual step that
used to live in this guide (plugin install flags, config merging, watchdog
scheduling, doctor runs):

```bash
npx @drakon-systems/multi-clawd update   # installs (or updates) the OpenClaw plugin —
                                         # right flags, offers the gateway restart, doctor after
npx @drakon-systems/multi-clawd setup    # guided wizard: accounts, token storage, pool, watchdog
```

Run the wizard WITH your human present — it pauses on decisions that are
theirs (which accounts, pool or not, where tokens live). The wizard merges
`openclaw.json` non-destructively with a backup, **never overwrites an
account that already works** (v1.2.3), and challenges suspicious-looking
secret refs instead of silently accepting them.

**From source** (contributors, or ahead of a published release):

```bash
git clone https://github.com/Drakon-Systems-Ltd/multi-clawd.git /tmp/multi-clawd
cd /tmp/multi-clawd && npm install && npm run build
openclaw plugins install "$(pwd)"
```

(Plain `npm install`, NOT `--omit=dev` — the build needs `tsc` from
devDependencies. Registry installs ship prebuilt `dist/`.)

## 3. Second-account login — **ASK YOUR HUMAN**

The sign-in itself is the one step you can never do: it opens a browser and
needs your human's credentials. What you CAN do is launch the right flow:

```bash
npx @drakon-systems/multi-clawd login claw2
```

`login` knows what each configured account IS (native → default dir/keychain;
isolated dir → same flow inside that dir, created 0700 if missing;
token-file/secret-ref → `claude setup-token` with the right target) and
verifies afterwards **which email** is signed in — no more wrong-account
mix-ups. It never captures, stores, or prints token values, and neither do
you. `login` with no argument lists the accounts in plain English.

Token hygiene (preferred over a plaintext token file): store the token in a
secret manager and reference it as
`"oauthTokenRef": { "source": "exec", "provider": "<your-secret-provider>", "id": "op://Vault/Item/field" }`
— resolved through the gateway's configured secret providers, so no token
sits on disk. Sources are mutually exclusive per account. (A vault copy that
diffs from a file by one trailing newline is fine — resolution trims it.)

## 4. Verify

```bash
npx @drakon-systems/multi-clawd doctor --probe   # health check + one live end-to-end turn
npx @drakon-systems/multi-clawd explain          # the whole setup in plain English
```

Fix every ❌ the doctor reports before telling your human you're done. If you
want to see the raw registration evidence, the gateway journal shows:

```
[multi-clawd] register() pass — config source: ..., accounts: N
[multi-clawd] registered N backend(s)+provider(s): ...
```

For a manual probe, keep it contained (file-redirected — never into a live
chat):

```bash
openclaw agent --agent main --session-key agent:main:mc-setup-probe \
  --model claw2/claude-fable-5 --json \
  --message "Reply with exactly this line and nothing else: MC_SETUP_OK. Do not use any tools." \
  > /tmp/mc-setup-probe.out 2>&1
grep -o "MC_SETUP_OK" /tmp/mc-setup-probe.out | head -1
```

## 5. The pool (proactive rotation) — **ASK YOUR HUMAN**

The wizard offers this; here's what you're offering so you can explain it.
One backend id (`clawd`) fronts all their Claude accounts; each launch runs
on the first account that is not nearly maxed out (live `rate_limit_event`
health; hand over BEFORE the limit error, return home when the window
resets, sticky selection so mid-conversation flapping doesn't happen).

The config the wizard writes, for reference — only touch it by hand if the
wizard genuinely can't run:

- Accounts: `plugins.entries["multi-clawd"].config.accounts` =
  `[ { "id": "claw1", "label": "Main Claude", "native": true }, { "id": "claw2", "configDir": "~/.claw2", ... } ]`
  (native = default config dir / OS keychain; a native account gets NO
  configDir and NO token — on macOS the keychain is only consulted when
  `CLAUDE_CONFIG_DIR` is unset).
- Pool: `plugins.entries["multi-clawd"].config.pool` = `{ "id": "clawd", "accounts": ["claw1", "claw2"] }`
- Models: `agents.defaults.models["clawd/claude-fable-5"]` = `{}` (plus any
  other pooled models your human wants agents to use).

## 6. Routing — **ASK YOUR HUMAN**

Ask whether they want `clawd/claude-fable-5` (pool) or `claw2/claude-fable-5`
(single account) in the failover chain — typical: pool as primary with
non-Anthropic providers as fallbacks, or first fallback after their current
primary — or left unrouted for manual/per-agent use. Apply only what they
choose, same merge discipline, and confirm the final chain back to them.

## 7. Known issue you should warn about

On OpenClaw ≤ 2026.7.1, an **idle** plugin CLI backend can be silently
evicted by core's scoped harness activation
([openclaw#107408](https://github.com/openclaw/openclaw/issues/107408),
fix pending in [openclaw#107596](https://github.com/openclaw/openclaw/pull/107596)).
Symptom: `Unknown CLI backend: claw2` while the model catalog still lists
it. A gateway restart always heals it.

Since v1.1 the **setup wizard schedules the bundled eviction watchdog
itself** (systemd/launchd, every ~5 min, restart → probe → confirm) and the
doctor verifies the watchdog's target script exists — so if you used the
wizard, this is already handled. Only mention it if your human declined the
watchdog while a backend will sit idle in a fallback chain.

## 8. Report

Tell your human: what was installed and where, the exact config keys
added, the backup file path, the doctor/probe result, and the routing
decision applied. `multi-clawd explain` output makes a good closing
summary. You're done. 🦞
