# CLAUDE.md — multi-clawd

Working rules for this repo. Complements the global `~/.claude/CLAUDE.md`; where
they overlap, the stricter rule wins.

## What this repo is

multi-clawd is a **distributable** OpenClaw plugin. It publishes **publicly to
npm** (`@drakon-systems/multi-clawd`, scoped; only the built `dist/` + scripts +
manifest + README + LICENSE ship). The source repo is **private** — but treat
everything you commit as if it could become public: git history is permanent,
visibility can be flipped, and this repo was already public-by-default once.

## Never commit — secrets

- No tokens, OAuth values, API keys, or credential files. `.gitignore` excludes
  `*.token`, `*.oauth`, `.env*`, `secrets/`, `accounts/`, `.claude-*/` — keep it
  that way, and extend it **before** adding any new secret-bearing path.
- No real secret references: `op://` vault/item ids, real account ids or emails.
  In docs, tests, and schema examples use placeholders only
  (`op://Vault/Item/field`, `claw1` / `claw2`).

## Never commit — internal / operational detail

This is the rule that was missing. A clean secret-gitignore does **not** catch an
internal doc committed as ordinary Markdown, or an operational reference dropped
into a code comment. In any TRACKED file — source, comments, `DESIGN.md`,
`README`, tests, changelogs:

- **No operator/personal names, agent names, host or box names, or fleet
  references.**
- **No infrastructure or account topology** — which account backs which host,
  shared-account layouts, single-points-of-failure.
- **No incident reports or operational forensics.** Those live *outside* this
  repo. `docs/incidents/` is gitignored to stop accidental re-adds.
- Illustrative examples in docs must be generic ("a fallback-primary host", not a
  real box name).

## Distribution hygiene

- `tsconfig` sets `removeComments: true` so the published `dist/` carries **no
  source comments** — comments are a leak path into the npm tarball. Keep it on.
- Before any `npm publish` or making anything public, review the
  `npm pack --dry-run` contents and run the scan below. See `PUBLISHING.md`.

## Before you commit

1. `git grep -nIiE "op://[a-z0-9]{20,}|ghp_|npm_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]|@icloud|@gmail|/Users/"` → expect none.
2. Scan the diff for internal identifiers (operator / agent / host names, topology).
3. Know the repo's live visibility: `gh repo view --json visibility`. Assume public.

## Making the repo public (if ever)

Flipping a private repo with internal history to public **exposes all of that
history**, not just HEAD. Do NOT flip visibility. If the source must go public,
push a **fresh clean-snapshot repo** (new repo, a single commit of a sanitized
HEAD, no history). Never rewrite this repo's history.

## Autopsy — why these rules exist

2026-07: this repo sat **public for ~6 days** while internal content was committed
— an incident report carrying account topology, plus host/fleet names in
`DESIGN.md` and source comments (which also compiled into shipped `dist/`). No
secrets leaked (the `.gitignore` held), but operational detail was publicly
reachable. Root cause: internal-flavoured content treated as ordinary
docs/comments, with no check on repo visibility. These rules close that category.
