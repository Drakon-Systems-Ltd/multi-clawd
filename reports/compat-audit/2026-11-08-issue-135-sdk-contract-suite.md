# Issue #135: SDK contract suite no longer pinned to 2026.8.1

Observed 2026-11-08 (UTC). Tests, CI and this report only; no runtime code, dependency or changelog change.

## Problem

`tests/openclaw-sdk-contract.test.ts` asserted `version === "2026.8.1"` and read `CLAUDE_CLI_CLEAR_ENV` from `dist/extensions/anthropic/cli-shared.js`. CI installs only the pinned devDependency, so the suite could never see OpenClaw 2026.9+ drift (the constant moved to `cli-constants.js`; `cli-catalog.js` was removed).

## Change

- Version pin replaced by a floor check (`>= 2026.8.1`, the package.json peer range) plus an optional exact match via `MULTI_CLAWD_EXPECT_OPENCLAW`, which the CI matrix sets so an overlay that silently failed to install fails the job instead of re-testing 2026.8.1.
- `tests/support/openclaw-upstream.ts` reads the upstream clear-env list from `cli-constants.js`, falling back to `cli-shared.js` (real legacy coverage on 2026.8.x). If neither exports a non-empty `string[]` it throws an `Unsupported OpenClaw contract` error naming each location tried and the fix. It never returns empty and never skips.
- Catalog case now asserts the source matches the install: `cli-catalog` when `cli-catalog.js` exists, otherwise `manifest`, so a silent fall-through to the built-in list cannot pass.
- New CI job `sdk-contract-compat` (Node 24): overlays `openclaw@2026.10.10`, `@2026.11.1` and `@latest` with `npm install --no-save` (package.json/lockfile untouched) and runs only the contract suite.

## Real vs synthetic

| Evidence | Kind |
|---|---|
| Suite passes on installed 2026.8.1, 2026.10.10, 2026.11.1 (11 of 11 each) | REAL npm packages, isolated HOME/npm cache under /tmp, no credentials, no live calls |
| Old suite on 2026.11.1: 2 of 6 fail (`expected '2026.11.1' to be '2026.8.1'`) | REAL, original file from origin/master |
| Resolver reads cli-constants / falls back to cli-shared / throws descriptively | SYNTHETIC fixture trees (resolver logic only; they prove nothing about upstream) |
| Suite fails loudly when the export is removed | REAL 2026.11.1 install with `cli-constants.js` overwritten in the scratch copy only |

Correction to the issue text: the "bundled Claude catalog" case no longer fails on 2026.11.1, because #134 added the manifest fallback in `src/catalog-source.ts`. The old suite's failures on 2026.11.1 are the two version-pin assertions (clear-env and backend cases). Its clear-env case would also have failed on the moved export.

## Not done

Full suite not run (CI only). `latest` lane has no expected version by design. Dependency pin left at 2026.8.1 (bump is a separate item).
