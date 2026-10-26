# Publishing multi-clawd

How a release of `@drakon-systems/multi-clawd` reaches npm and ClawHub. This
document covers **package publication only**. Installing or upgrading the
plugin on any host, and restarting that host's gateway, is a separate
operation — see [Publication is not deployment](#publication-is-not-deployment).

The checked-in workflows are the source of truth. If this document and
`.github/workflows/` ever disagree, the workflows describe what actually runs;
fix this document.

## The normal path: a published GitHub Release

Publishing a GitHub Release (`release: published`) starts two independent
workflows:

| Workflow | Publishes to | Auth |
|---|---|---|
| `.github/workflows/npm-publish.yml` | npm | npm Trusted Publishing (OIDC) — no stored npm token |
| `.github/workflows/clawhub-publish.yml` | ClawHub | a ClawHub token held as a repository secret |

Pushing a tag on its own publishes **nothing**; neither workflow has a `push`
trigger. A draft release does not fire `published` until it is published.

A third workflow, `.github/workflows/ci.yml`, runs on every pull request and on
pushes to `master`: install, `npm run build`, `npm test` on Node 22 and 24, with
`contents: read` only. It never publishes; a green CI run is not evidence of a
release.

`npm-publish.yml`, on the release event:

1. checks that the release tag (`vX.Y.Z`) matches `package.json` `version`,
   and fails if not;
2. `npm install --no-audit --no-fund` on Node 24 (npm 11), resolving against
   the committed `package-lock.json` (`npm install` may adjust it inside the
   run; the lockfile is never shipped in the package);
3. `npm run build` (`tsc`);
4. `npm test` (`vitest run` — already non-watch, no extra flags needed);
5. `npm publish --access public --provenance`.

npmjs.com trusts exactly the `Drakon-Systems-Ltd/multi-clawd` repository plus
the `npm-publish.yml` filename (package Settings → Trusted Publisher). Renaming
the workflow file breaks publishing until that setting is updated.

The two workflows succeed or fail independently: a green ClawHub run says
nothing about npm, and vice versa. (The header comment in `clawhub-publish.yml`
still says npm publishing is manual; it predates `npm-publish.yml`.)

## ⚠ Do not trust the `npm version` hook

The `version` lifecycle script — which syncs `openclaw.plugin.json` and the
README's pinned release tag to the new version — is **silently skipped**
wherever npm runs with `ignore-scripts=true`, a common supply-chain hardening
setting.

The symptom is a tagged release whose manifest version sits one behind. That
happened to v1.5.1 and v1.5.2 (see CHANGELOG), and was twice misdiagnosed as an
npm ordering quirk before the real cause turned up.

**So run the syncs explicitly after every bump** (step 2 below), and let the
tests confirm: `tests/backend-config.test.ts` fails when the manifest
disagrees with `package.json`, and `tests/security-posture.test.ts` fails when
the README's pinned tag does. Those guards only help if the suite runs *after*
the bump — which is why step 2 re-runs it.

## Release steps

1. **Clean tree, green build and tests, on an up-to-date `master`:**
   ```bash
   git switch master && git pull
   npm ci && npm run build && npm test
   ```
   `npm ci` installs exactly the committed `package-lock.json` and does not
   rewrite it. The publish workflows run on Node 24 (npm 11). CI's Node 22
   lane upgrades to npm 11 first (see the comment in `ci.yml`); the committed
   lockfile also lets npm 10 install the tree.

2. **Bump the version, sync the derived files, update the changelog:**
   ```bash
   npm version <X.Y.Z> --no-git-tag-version         # package.json + package-lock.json
   npm run sync-manifest                            # openclaw.plugin.json
   npm run sync-readme-tag                          # README's pinned SETUP-AGENT.md URL
   npm test                                         # re-run: guards the syncs
   ```
   The two sync commands are **not optional** — see the warning above.
   `npm version` itself bumps the version in `package-lock.json` (that is not
   a hook); `tests/package-lock.test.ts` fails if the lockfile and
   `package.json` disagree. Then move the `## [Unreleased]` items under a new
   `## [X.Y.Z] - <date>` heading in CHANGELOG.md.

3. **Inspect the package contents locally** (dry run — uploads nothing):
   ```bash
   npm pack --dry-run
   ```
   Expect `@drakon-systems/multi-clawd@X.Y.Z`, `dist/` prebuilt, **no
   `dependencies` block** (openclaw is peer-only), nothing under `src/` or
   `tests/`. Also run the pre-commit scan in `CLAUDE.md`.

4. **Land the bump on `master`, then tag the merged commit:**
   commit `package.json`, `package-lock.json`, `openclaw.plugin.json`,
   `README.md` and `CHANGELOG.md` on a release branch and merge it through a
   pull request (CI runs on it). Then tag the commit on `master` that carries
   the bump:
   ```bash
   git switch master && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   The tag must point at the commit that carries the bumped `package.json`,
   or the workflow's tag check fails. Pushing the tag publishes nothing.

5. **Publish the GitHub Release** — this is the step that publishes:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes "<changelog section>"
   ```

6. **Check the evidence** (see below). Do not publish by hand "to be sure".

## Evidence that a release was published

Each piece of evidence covers only its own channel:

- **GitHub:** the release exists for `vX.Y.Z`, and the `Publish to npm
  (trusted publishing)` and `Publish to ClawHub` runs for it are green.
- **npm:** the exact scoped version resolves —
  ```bash
  npm view @drakon-systems/multi-clawd@X.Y.Z version   # -> X.Y.Z
  ```
  Use the exact `@X.Y.Z` form. `npm view @drakon-systems/multi-clawd version`
  (no version) reports the `latest` dist-tag, which is not the same question.
  A provenance attestation on the npm version page shows it came from the
  workflow.
- **ClawHub:** the `Publish to ClawHub` run is green and ended with
  `Published @drakon-systems/multi-clawd@X.Y.Z to ClawHub`. That line is the
  workflow's own `echo` after the CLI returned success — it is evidence the
  run completed, **not** a read of the registry. Treat ClawHub publication as
  confirmed only once ClawHub itself shows version `X.Y.Z` for the package;
  until then record it as unverified.

A successful OIDC run with provenance is the evidence that Trusted Publishing
works. Who published an *earlier* version, or which identity once owned the
package, is not.

## When the npm workflow fails: check before any retry

`npm publish` is **not idempotent**. A version can be published once; a second
attempt for the same version fails — and that failure means the version
*already exists*, not that it is missing. So a red run does not tell you,
by itself, whether `X.Y.Z` is on npm.

Before re-running anything:

1. Read the failed run's log and note which step failed. Failures in the tag
   check, `npm install`, `npm run build` or `npm test` happen before
   `npm publish` is reached.
2. Do a read-only check of the exact scoped version:
   ```bash
   npm view @drakon-systems/multi-clawd@X.Y.Z version
   ```
   - Prints `X.Y.Z` → it is published. **Stop.** Do not re-run the workflow.
   - The registry answered and the version is explicitly absent (the command
     succeeds with empty output, or npm reports `E404` for that version) → it
     is not (yet) visible. Fix the cause shown in the log first; a re-run of
     an unchanged failure only fails again.
   - The query itself failed (network error, timeout, auth or other non-404
     registry error) → the result is **inconclusive**, not "missing". Do not
     re-run on it; repeat the read-only check until the registry gives a
     definite answer.
3. Re-run once, deliberately — never in a loop until it goes green. The
   workflow also has a `workflow_dispatch` trigger for this. Note that on
   manual dispatch the tag check is **skipped** (it only runs for the release
   event) and the version published is whatever `package.json` says on the
   ref you dispatch from, so dispatch from the release tag:
   ```bash
   gh workflow run npm-publish.yml --ref vX.Y.Z
   ```

If the fix needs a source change, ship it as a **new patch version**. Never
move, delete or re-point a tag that a release was cut from, and never try to
replace a published version.

## When the ClawHub workflow fails

Same rule: read the log, check ClawHub for version `X.Y.Z` before re-running,
and re-run once, deliberately. `clawhub-publish.yml` has a `workflow_dispatch`
input `version`; without it the run falls back to the most recent git tag
(`git describe --tags`), which may not be the release you mean. The leading
`v` is optional. On dispatch there is no release body, so the changelog text is
taken from the `## [X.Y.Z]` section of CHANGELOG.md. The run publishes the
package built from the ref you dispatch from, so dispatch from the release tag
and pass the version explicitly:
```bash
gh workflow run clawhub-publish.yml --ref vX.Y.Z -f version=X.Y.Z
```

## Manual (emergency) publishing

Publishing from a workstation bypasses the workflow's checks and carries no
provenance. It is not part of the normal procedure and happens only with
**explicit authorisation from the project's operator** for that specific
version. If authorised, the person publishing must hold publish rights on the
`@drakon-systems` scope and still: confirm the exact version is absent (the
read-only check above), build and test from the tagged commit, and inspect
`npm pack --dry-run` before `npm publish --access public`.

Do not work around a failing OIDC run by adding a stored npm token to the
repository or workflow.

## Publication is not deployment

A version on npm, a GitHub Release and a ClawHub listing are evidence that a
**package** exists. They do not mean any host is running it. Installing or
upgrading the plugin on a host (`openclaw plugins install|update`,
`multi-clawd update`), restarting that host's gateway, and running `doctor`
against it are host operations: they need their own authorisation from whoever
operates that host and are verified on that host — not as part of a release.

For reference, a host-side upgrade installs the package from ClawHub, then restarts
that host's OpenClaw gateway (an interruption for anything it is serving, so
only when that host's operator has agreed), then probes it:
```bash
openclaw plugins install clawhub:@drakon-systems/multi-clawd
npx @drakon-systems/multi-clawd doctor --probe
```
ClawHub is the source OpenClaw trusts; npm installs show a source caution.
If ClawHub fails, use `openclaw plugins install @drakon-systems/multi-clawd --pin`.
A host moving from a path-installed `multi-clawd` to the registry package
first removes the path install through OpenClaw's plugin uninstall command.
Plugin identity is keyed by the manifest `id` (`multi-clawd`), independent of
the npm package name, so config and health-state under
`plugins.entries["multi-clawd"]` are expected to carry over — confirm that on
the host when it is done.

## History (not current verification)

- v1.0.0 was the first npm publication (2026-07-20); releases up to 1.9.4 were
  published outside GitHub Actions.
- 1.9.5 (2026-09-27) is recorded in CHANGELOG as the first release published by
  `npm-publish.yml` through Trusted Publishing.

These are records of what happened, not checks of the current registry or of
any host.

## Caveats

- **Unpublish is effectively one-way.** npm allows unpublish only in a short
  window, and the name/version can never be reused afterward. Treat publish as
  permanent.
- **Scoped packages default to restricted.** `publishConfig.access: "public"`
  in package.json guards against an accidental private publish; the explicit
  `--access public` is belt-and-suspenders.
