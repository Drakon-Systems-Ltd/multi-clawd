// PUBLISHING.md must describe the release procedure the checked-in workflows
// actually run. Text-only checks: nothing extracted from the docs is executed.
//
// Run with: node --test tests/publishing-docs.contract.mjs
// Deliberately not named *.test.mjs — vitest's default include would collect
// it, find no vitest suite, and fail `npm test` (which gates npm-publish.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");

const doc = read("PUBLISHING.md");
const npmWf = read(".github/workflows/npm-publish.yml");
const clawhubWf = read(".github/workflows/clawhub-publish.yml");
const pkg = JSON.parse(read("package.json"));

test("workflows publish on a published release or manual dispatch, never on push", () => {
  for (const wf of [npmWf, clawhubWf]) {
    assert.match(wf, /release:\s*\n\s*types:\s*\[published\]/);
    assert.match(wf, /workflow_dispatch:/);
    assert.doesNotMatch(wf, /^\s*push:/m);
  }
  assert.match(doc, /release: published/);
  assert.match(doc, /Pushing a tag on its own publishes \*\*nothing\*\*/);
});

test("documented npm workflow steps match npm-publish.yml", () => {
  assert.match(npmWf, /id-token: write/);
  assert.match(npmWf, /if: github\.event_name == 'release'/);
  assert.match(npmWf, /npm install --no-audit --no-fund/);
  assert.match(npmWf, /run: npm run build/);
  assert.match(npmWf, /run: npm test/);
  assert.match(npmWf, /npm publish --access public --provenance/);
  for (const s of [
    "npm install --no-audit --no-fund",
    "npm run build",
    "npm test",
    "npm publish --access public --provenance",
    "Trusted Publishing (OIDC)",
    "tag check is **skipped**",
  ]) {
    assert.ok(doc.includes(s), `PUBLISHING.md should mention: ${s}`);
  }
});

test("no lockfile, so the docs never instruct npm ci", () => {
  assert.match(read(".gitignore"), /^package-lock\.json$/m);
  assert.doesNotMatch(npmWf, /npm ci\b/);
  assert.doesNotMatch(doc, /^\s*npm ci\b/m);
});

test("documented scripts exist with the expected meaning", () => {
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.json");
  assert.equal(pkg.scripts.test, "vitest run");
  assert.ok(pkg.scripts["sync-manifest"]);
  assert.ok(pkg.scripts["sync-readme-tag"]);
  for (const s of ["npm run sync-manifest", "npm run sync-readme-tag", "npm pack --dry-run"]) {
    assert.ok(doc.includes(s), `PUBLISHING.md should keep: ${s}`);
  }
});

test("retry guidance uses an exact scoped-version read and warns it is not idempotent", () => {
  assert.ok(doc.includes(`npm view ${pkg.name}@X.Y.Z version`));
  assert.match(doc, /\*\*not idempotent\*\*/);
  assert.match(doc, /never in a loop/);
});

test("a failed registry query is inconclusive, and the ClawHub echo is not registry proof", () => {
  assert.match(doc, /explicitly absent/);
  assert.match(doc, /\*\*inconclusive\*\*, not "missing"/);
  assert.match(clawhubWf, /echo "Published \$PACKAGE_NAME@\$VERSION to ClawHub"/);
  assert.match(doc, /\*\*not\*\* a read of the\s+registry/);
  assert.match(doc, /record it as unverified/);
});

test("no stale manual-only, stored-token or tag-rewriting instructions", () => {
  assert.doesNotMatch(doc, /never CI/i);
  assert.doesNotMatch(doc, /npm whoami|npm login|NPM_TOKEN|NODE_AUTH_TOKEN|automation token/);
  assert.doesNotMatch(doc, /git tag (-d|-f|--delete|--force)|git push[^\n]*(--delete|--force|:refs\/tags)/);
});

test("package publication is kept distinct from host deployment", () => {
  assert.match(doc, /## Publication is not deployment/);
  assert.match(doc, /need their own authorisation/);
  assert.match(doc, /explicit authorisation from the project's operator/);
});
