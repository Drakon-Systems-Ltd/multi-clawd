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
  A launch that cannot take the file's lock within its 150 ms wait writes its
  one event to a `0600` `history.jsonl.pending-*` file beside it instead of
  dropping it. A later launch that does take the lock folds pending events
  into the journal, up to 100 files per write and oldest first, and then
  removes the files it folded. The journal records which files a write folded
  (a line of random file IDs) so that a write interrupted before it could
  remove them is not applied a second time. Pending files hold the same
  fields as journal lines and nothing else. They are not bounded on their
  own: they accumulate until a launch takes the lock. Readers count pending
  events, with one exception: if the journal is replaced during all three of a
  reader's attempts, it returns the last journal alone, which can omit events
  that are still pending. Readers apply the journal's bound to what they
  return.

## Permissions

multi-clawd never grants itself more permission than OpenClaw core grants the
bundled `claude-cli` backend. It appends `--permission-mode bypassPermissions`
**only** when your own config already sets `tools.exec.mode: "full"` — which is
what core does for the bundled backend. Under any other exec mode it passes
nothing and Claude keeps its default prompt-honouring behaviour.

## Why static scanners flag this package

Automated scans flag multi-clawd for `dangerous_exec`. That is expected and
correct: starting Claude Code processes *is* the product. Every source file
that imports Node's `child_process` module (verified by searching the source
tree) is listed here so you can check it yourself. Some of these processes read
credentials or reach the network, so each row says what it runs and what it can
touch. Where a command is a third-party tool, the network traffic it makes is
that tool's own.

| Location | What it runs | Credential and network boundary |
| --- | --- | --- |
| `dist/shim.js` | the selected `claude` executable; relaunched for a sibling account when an in-turn retry is armed | Inherits the gateway environment minus the stripped Claude/Anthropic variables, plus the selected account's setup token and/or `CLAUDE_CONFIG_DIR`. Claude Code itself contacts Anthropic. |
| `dist/shim-transport.js` | `node <shim>` for an execute-transport turn | Passes the host-prepared turn environment (which can carry the account's setup token) on to the shim; the prompt travels on stdin. Makes no network calls of its own; the `claude` child reaches Anthropic. |
| `dist/credential-store.js` | `security find-generic-password` / `security dump-keychain` (macOS) | `find-generic-password -w` returns the Keychain secret to multi-clawd for login checks and token handover. `dump-keychain` is run without the flag that exposes secrets and lists item attributes only. No network. |
| `dist/watchdog-schedule.js` | generated `watchdog-launcher.mjs` runs `node <bundled eviction-watchdog.mjs>` | The generated launcher carries no credentials. A systemd user timer or launchd agent runs it. |
| `dist/openclaw-runner.js` | the `openclaw` CLI (or `directRoute.openclawCommand`) | Direct route only: reads and writes the `anthropic` auth profiles and order through OpenClaw subcommands. A setup token travels on the child's stdin. Network use is OpenClaw's. |
| `scripts/cli.mjs` | `openclaw plugins inspect`, `openclaw --version`, `openclaw plugins` install and `openclaw gateway restart`; `npm view` and `npm i -g`; `claude auth login`, `claude setup-token` and `claude auth status` (`login`); `node <bundled script>` for `setup`, `doctor` and `direct sync` | `npm` contacts the registry. `login` runs `claude` with the host environment, with `CLAUDE_CONFIG_DIR` set to the chosen account's directory or a scratch directory, so sign-in writes or exposes that account's credentials; the browser flow is Claude's. Restarting the gateway interrupts running turns, and installs and restarts ask first. |
| `scripts/setup.mjs` | `claude --version`; `systemctl --user daemon-reload` / `enable --now`, `launchctl load` / `unload` | Local only. Registers or reloads the optional watchdog scheduler. |
| `scripts/_watchdog-heal.mjs` | `launchctl unload` / `load`, `systemctl --user daemon-reload` | Local only. Reloads the optional watchdog unit after `update` rewrites it. |
| `scripts/doctor.mjs` | `npm view` (when its registry cache is stale), `claude --version`, `openclaw plugins inspect`, `openclaw models auth list`, `openclaw agent` (only with `--probe` / `--probe-pool`), `launchctl list`, `systemctl --user list-timers` | `npm view` contacts the registry. `--probe` runs real turns through `openclaw agent`, which spends account usage and reaches Anthropic via OpenClaw. The other calls are local queries. |
| `scripts/eviction-watchdog.mjs` | `openclaw logs --plain`, `openclaw gateway restart` | Reads OpenClaw logs; restarts the gateway only when the watchdog's conditions are met. No credential access. |
| `scripts/hermes.mjs` | Python interpreter with `-c`; the bundled `hermes_bridge.py` | Runs with the host environment (plus `HERMES_HOME` for the bridge) and reads and writes Hermes account files under that home. The bridge script imports no network modules, but it loads Hermes code, whose own behaviour this table does not cover. |

Not every network call goes through a subprocess. The usage poll
(`src/usage-poll.ts`, also used by `multi-clawd usage`) makes HTTPS requests to
Anthropic's usage endpoint from inside the plugin process, using the account's
stored login. Nothing in this table claims that multi-clawd avoids credential
access or network traffic.

None of these pass a command string to a shell: child-process calls use an
executable and argument array (no `shell: true`, no `exec` of a string). The
launcher generated by `watchdog-schedule` uses the same form.

## Things you should decide for yourself

- **The watchdog is persistence.** `setup` schedules a user-level systemd timer
  (or launchd agent) that can restart the OpenClaw gateway. It is optional —
  skip it if you don't want that.
- **The setup wizard edits the OpenClaw config file** (`~/.openclaw/openclaw.json`,
  or the file `OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR` select; the banner
  names it). It backs the file up first and merges rather than overwrites, and
  `--dry-run` shows you the changes without writing. Use it.
- **The agent-install one-liner is pinned to a release tag,** not `master`, so
  what your assistant reads and executes is fixed at a version you chose.
  Inspect `SETUP-AGENT.md` before pointing an agent at it — that advice holds
  for anyone's setup guide, including ours.

## Scope

multi-clawd runs entirely on your machine against your own Claude
subscriptions. It has no server component, no telemetry, and **zero runtime
dependencies** — the only third-party code in the install is whatever OpenClaw
itself already provides.
