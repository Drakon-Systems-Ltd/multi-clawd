# Publishing multi-clawd to npm

The "proper installer" **is** the published package: once live, any box installs
with `openclaw plugins install @drakon-systems/multi-clawd --pin`. This runbook is
the **manual** publish procedure — run by hand from a trusted machine, never CI.

## Who / where

- **npm identity: `cyborgninja`** — the account that owns the `@drakon-systems`
  npm org (confirmed `owner`). Publish from the release machine, which is already logged
  in as `cyborgninja`. Publishing is deliberately manual, NOT from CI — npm tokens
  expire (≤90 days) and the human gate is the point.
- **Scope: `@drakon-systems`** — an existing, active npm org owned by `cyborgninja`;
  sibling packages already ship under it (`@drakon-systems/shieldcortex-realtime`,
  `@drakon-systems/agent-optimizer`). Nothing to create — `multi-clawd` is just the
  next package in the org. (ClawHub distribution is handled separately.)
- **Sanity check, not a warning:** `npm whoami` should read `cyborgninja` before
  publishing (it does on the release machine). If it ever doesn't, `npm login` as
  `cyborgninja` first.

## Status

**Live and current** — first published v1.0.0 on 2026-07-20; releases since have
followed the runbook below (v1.4.2, 2026-07-21, was published headlessly with
the automation token). The registry-install path is verified end-to-end
(install → gateway restart → doctor READY → live pool turn). ClawHub
distribution is automated separately: cutting a GitHub Release fires
`.github/workflows/clawhub-publish.yml`, which publishes the plugin package to
ClawHub with the release notes as changelog.

## Steps

1. **Clean tree, green tests, on master:**
   ```bash
   git switch master && git pull
   npm install && npm run build && npm test        # full suite green (290+ tests)
   ```

2. **Bump the version and update the changelog:**
   ```bash
   npm version <X.Y.Z> --no-git-tag-version         # package.json only
   ```
   Add the release's items under a new `## [X.Y.Z] — <date>` heading in
   CHANGELOG.md.

3. **Verify the tarball before going live:**
   ```bash
   npm pack --dry-run
   ```
   Expect `@drakon-systems/multi-clawd@X.Y.Z`, `dist/` prebuilt, **no
   `dependencies` block** (openclaw is peer-only), nothing under `src/` or
   `tests/`.

4. **Confirm the publishing identity:**
   ```bash
   npm whoami                                        # -> cyborgninja
   ```
   If it isn't: `npm login` as `cyborgninja` (or use the automation token).

5. **Publish** (public is enforced by `publishConfig`, but be explicit):
   ```bash
   npm publish --access public
   ```

6. **Tag + GitHub release** (the release also triggers the ClawHub publish):
   ```bash
   git commit -am "vX.Y.Z: <summary>"
   git tag vX.Y.Z && git push && git push --tags
   gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes "<changelog section>"
   ```

7. **End-to-end verify the real install on a box:**
   ```bash
   npm view @drakon-systems/multi-clawd version      # -> X.Y.Z
   npx @drakon-systems/multi-clawd update            # installs, offers restart, runs doctor
   npx @drakon-systems/multi-clawd doctor --probe    # READY + live turn
   openclaw plugins list                             # multi-clawd enabled, vX.Y.Z
   ```
   Confirm the installed copy carries **no** `node_modules/openclaw`
   (host-provided) and that the backends register.

## Migrating a box from a source/local install

A box currently running a path-installed `multi-clawd` moves to the registry with:
```bash
openclaw plugins uninstall multi-clawd              # or reinstall with --force
openclaw plugins install @drakon-systems/multi-clawd --pin
openclaw gateway restart
```
Plugin identity is keyed by the manifest `id` (`multi-clawd`), independent of the
npm package name, so config and health-state under
`plugins.entries["multi-clawd"]` carry over. **Verify this on the first real
migration** — it's the one step not yet exercised end-to-end.

## Caveats

- **Unpublish is one-way.** npm allows unpublish only within 72h, and the
  name/version is burned afterward. Treat publish as permanent.
- **Scoped packages default to restricted.** `publishConfig.access: "public"` in
  package.json guards against an accidental private publish; the explicit
  `--access public` is belt-and-suspenders.
- **Token hygiene.** If using an automation token instead of interactive login,
  it's a *publish*-type token, rotated on npm's ≤90-day expiry, and never committed.
