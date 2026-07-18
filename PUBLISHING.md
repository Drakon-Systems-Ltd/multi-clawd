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

## Gate

Publish the **v1.0.0** debut once the v1.0 readiness gates are met (weekly quota
reset observed; publish dry-run evidence captured). The packaging prep — scoped
name, peer-dependency `openclaw`, `publishConfig.access: public`, docs — already
landed at v0.3.7; only the version bump and the publish itself remain.

## Steps

1. **Clean tree, green tests, on master:**
   ```bash
   git switch master && git pull
   npm install && npm run build && npm test        # expect 185+ passing
   ```

2. **Bump to 1.0.0 and update the changelog:**
   ```bash
   npm version 1.0.0 --no-git-tag-version           # package.json only
   ```
   Move the CHANGELOG `[Unreleased]` items under a new `## [1.0.0] — <date>`
   heading and add the compare/tag links.

3. **Verify the tarball before going live:**
   ```bash
   npm pack --dry-run
   ```
   Expect `@drakon-systems/multi-clawd@1.0.0`, ~19 files, `dist/` prebuilt, **no
   `dependencies` block** (openclaw is peer-only), nothing under `src/` or `tests/`.

4. **Confirm the publishing identity:**
   ```bash
   npm whoami                                        # -> cyborgninja
   npm org ls drakon-systems                         # cyborgninja = owner
   ```
   If `whoami` isn't `cyborgninja`: `npm login` (complete 2FA/OTP).

5. **Publish** (public is enforced by `publishConfig`, but be explicit):
   ```bash
   npm publish --access public
   ```

6. **Tag + GitHub release:**
   ```bash
   git commit -am "v1.0.0: first npm release (@drakon-systems/multi-clawd)"
   git tag v1.0.0 && git push && git push --tags
   gh release create v1.0.0 --title "v1.0.0" --notes-from-tag
   ```

7. **End-to-end verify the real install** — the first true test of the
   peer-dependency install path; do it on a box, not just locally:
   ```bash
   npm view @drakon-systems/multi-clawd version      # -> 1.0.0
   openclaw plugins install @drakon-systems/multi-clawd --pin
   openclaw gateway restart
   node ~/.openclaw/extensions/multi-clawd/scripts/doctor.mjs   # expect READY
   openclaw plugins list                             # multi-clawd enabled, v1.0.0
   ```
   Confirm the installed copy carries **no** `node_modules/openclaw` (host-provided)
   and that the backends register.

8. **Flip the docs markers:** drop the "(v1.0+)" / "recommended, v1.0+" notes in
   README.md and SETUP-AGENT.md now that the registry install is live.

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
