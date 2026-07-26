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

- **Tokens are never logged and never appear in a command line.** They are
  passed to the Claude CLI child process through its environment only, so they
  cannot leak into a process list, a shell history, or a log file.
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
- **Host credentials are stripped from child processes.** 22 Claude/Anthropic
  environment variables are cleared before each launch, so one account's
  credential cannot bleed into another account's session.
- **State files are written `0600`,** atomically (temp file + rename), and
  contain rate-limit telemetry only — never credentials.

## Permissions

multi-clawd never grants itself more permission than OpenClaw core grants the
bundled `claude-cli` backend. It appends `--permission-mode bypassPermissions`
**only** when your own config already sets `tools.exec.mode: "full"` — which is
what core does for the bundled backend. Under any other exec mode it passes
nothing and Claude keeps its default prompt-honouring behaviour.

## Why static scanners flag this package

Automated scans flag multi-clawd for `dangerous_exec`. That is expected and
correct: starting Claude Code processes *is* the product. Every such callsite
is listed here so you can check them yourself.

| Location | What it runs | Why |
| --- | --- | --- |
| `dist/shim.js` | the `claude` binary | The core function: launches Claude Code for the selected account. Argv is built from a fixed base list plus your configured model; no shell. |
| `dist/watchdog-schedule.js` | `node <bundled script>` | Runs the eviction watchdog on a timer. Path is the package's own script. |
| `scripts/cli.mjs` | `node <bundled script>` | The CLI dispatching to its own subcommands. |
| `scripts/setup.mjs` | `launchctl` / `systemctl` | Loads the watchdog timer during setup on macOS/Linux. |

None of these pass a string to a shell — they are direct process spawns with
argument arrays, so there is no quoting or injection surface. Paths are
package-internal or derived from your home directory, never from remote input.

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
