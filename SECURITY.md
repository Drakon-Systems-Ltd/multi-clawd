# Security

multi-clawd handles Claude Code login credentials. That makes it worth
explaining exactly what it touches, and worth telling you how to report a
problem.

## Reporting a vulnerability

Open a [security advisory](https://github.com/Drakon-Systems-Ltd/multi-clawd/security/advisories/new)
on the repository, or email **security@drakonsystems.com**. Please do not open
a public issue for anything exploitable.

We aim to acknowledge within 72 hours. If a fix is warranted we will ship it,
credit you (unless you'd rather we didn't), and note it in the CHANGELOG.

## How credentials are handled

- **Tokens are never logged and never appear in a command line.** Claude CLI
  child launches receive setup tokens through their environment; direct-route
  OpenClaw commands receive them on stdin.
- **Secret references are preferred over token files.** `oauthTokenRef` uses
  the same `{source, provider, id}` shape as the rest of `openclaw.json` and
  resolves through the gateway's own configured secret providers (1Password,
  etc.), so the credential never sits in plaintext on disk.
- **Secret-resolution failures are redacted to a fixed reason code.** The
  message that reaches your logs contains neither the token, nor the
  provider/id being resolved, nor the provider's own exception text — only the
  error class, for debuggability.
- **Plaintext token files are checked, not trusted.** If you use the legacy
  `oauthTokenFile`, multi-clawd warns (once per process) when the file is
  readable beyond your own user account. It warns rather than refuses: the
  credential still works, and the fix is yours to make — `chmod 600`.
- **Host credentials are stripped from child processes.** 42 Claude/Anthropic
  environment variables covering authentication, runtime, and telemetry are
  cleared before each launch, so one account's credential cannot bleed into
  another account's session.
- **Per-account health and usage files are written `0600`,** using temporary
  files and rename, and contain rate-limit data rather than credentials. Other
  state files include model, alert, registry and watchdog data.
- **`history.jsonl` is a bounded `0600` account activity file** in the same
  state directory. It contains timestamps, account/model IDs and short reason
  codes, with no prompt, transcript, token, cost, credential, or environment values.

## Permissions

multi-clawd never grants itself more permission than OpenClaw core grants the
bundled `claude-cli` backend. It appends `--permission-mode bypassPermissions`
**only** when your own config already sets `tools.exec.mode: "full"` — which is
what core does for the bundled backend. Under any other exec mode it passes
nothing and Claude keeps its default prompt-honouring behaviour.

## Why static scanners flag this package

Automated scans flag multi-clawd for `dangerous_exec`. That is expected and
correct: starting Claude Code processes *is* the product. Every source file
that calls a child-process API is listed here so you can check it yourself.

| Location | What it runs | Why |
| --- | --- | --- |
| `dist/shim.js` | selected `claude` executable | Launches Claude Code for the selected account and, when an in-turn retry is armed, relaunches it for a sibling account. |
| `dist/shim-transport.js` | `node <shim>` | Runs the shim for an execute-transport turn. |
| `dist/credential-store.js` | `security find-generic-password` / `security dump-keychain` | Reads a macOS Keychain login or inventories Keychain item attributes for credential checks. |
| `dist/watchdog-schedule.js` | generated `watchdog-launcher.mjs` runs `node <bundled eviction-watchdog.mjs>` | Renders the state-dir launcher that a systemd user timer or launchd agent runs. The launcher resolves the current install before spawning its bundled watchdog script. |
| `dist/openclaw-runner.js` | the `openclaw` CLI (or `directRoute.openclawCommand`) | Direct route only: reads and writes the `anthropic` auth profiles and order through OpenClaw subcommands. A setup token travels on the child's stdin. |
| `scripts/cli.mjs` | `npm view` / `npm i -g`, `openclaw --version`, `openclaw` plugin install and gateway restart, `claude` login/status commands, `launchctl` / `systemctl`, and `node <bundled script>` | Checks and updates the CLI/plugin, handles account login, dispatches subcommands and repairs watchdog scheduling. |
| `scripts/setup.mjs` | `claude --version`, `launchctl` / `systemctl` | Checks the Claude CLI and loads or repairs optional watchdog scheduling. |
| `scripts/doctor.mjs` | `npm view`, `claude --version`, `openclaw models auth list` / `openclaw agent`, `launchctl` / `systemctl` | Checks registry version when its cache is stale, inspects auth and watchdog status, and optionally probes accounts. |
| `scripts/eviction-watchdog.mjs` | `openclaw logs --plain` / `openclaw gateway restart` | Detects the eviction signature and restarts the gateway when the watchdog's conditions are met. |
| `scripts/hermes.mjs` | Python interpreter with `-c` / bundled bridge | Checks Python availability and runs the Hermes bridge. |

None of these pass a command string to a shell: child-process calls use an
executable and argument array. The launcher generated by `watchdog-schedule`
uses the same form.

## Things you should decide for yourself

- **The watchdog is persistence.** `setup` schedules a user-level systemd timer
  (or launchd agent) that can restart the OpenClaw gateway. It is optional —
  skip it if you don't want that.
- **The setup wizard edits `~/.openclaw/openclaw.json`.** It backs the file up
  first and merges rather than overwrites, and `--dry-run` shows you the
  changes without writing. Use it.
- **The agent-install one-liner is pinned to a release tag,** not `master`, so
  what your assistant reads and executes is fixed at a version you chose.
  Inspect `SETUP-AGENT.md` before pointing an agent at it — that advice holds
  for anyone's setup guide, including ours.

## Scope

multi-clawd runs entirely on your machine against your own Claude
subscriptions. It has no server component, no telemetry, and **zero runtime
dependencies** — the only third-party code in the install is whatever OpenClaw
itself already provides.
