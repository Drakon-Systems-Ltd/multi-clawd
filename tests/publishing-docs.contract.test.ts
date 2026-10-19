// PUBLISHING.md must describe the release procedure the checked-in workflows
// actually run. Text-only checks: nothing extracted from the docs is executed.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const doc = read("PUBLISHING.md");
const npmWf = read(".github/workflows/npm-publish.yml");
const clawhubWf = read(".github/workflows/clawhub-publish.yml");
const ciWf = read(".github/workflows/ci.yml");
const pkg = JSON.parse(read("package.json"));

function expectDocMentions(...snippets: string[]) {
  for (const s of snippets) expect(doc.includes(s), `PUBLISHING.md should mention: ${s}`).toBe(true);
}

describe("PUBLISHING.md matches the release workflows", () => {
  test("publish workflows run on a published release or manual dispatch, never on push", () => {
    for (const wf of [npmWf, clawhubWf]) {
      expect(wf).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
      expect(wf).toMatch(/workflow_dispatch:/);
      expect(wf).not.toMatch(/^\s*push:/m);
    }
    expect(doc).toMatch(/release: published/);
    expect(doc).toMatch(/Pushing a tag on its own publishes \*\*nothing\*\*/);
  });

  test("CI runs on PRs and master pushes, read-only, and is not release evidence", () => {
    expect(ciWf).toMatch(/^\s*pull_request:/m);
    expect(ciWf).toMatch(/push:\s*\n\s*branches:\s*\[master\]/);
    expect(ciWf).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(ciWf).toMatch(/node: \[22, 24\]/);
    expect(ciWf).not.toMatch(/npm publish|clawhub/);
    expectDocMentions(".github/workflows/ci.yml", "Node 22 and 24", "It never publishes");
  });

  test("npm publishing is OIDC Trusted Publishing with provenance, and the steps match", () => {
    expect(npmWf).toMatch(/id-token: write/);
    expect(npmWf).toMatch(/if: github\.event_name == 'release'/);
    expect(npmWf).toMatch(/node-version: 24/);
    expect(npmWf).toMatch(/npm install --no-audit --no-fund/);
    expect(npmWf).toMatch(/run: npm run build/);
    expect(npmWf).toMatch(/run: npm test/);
    expect(npmWf).toMatch(/npm publish --access public --provenance/);
    expect(npmWf).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
    expectDocMentions(
      "npm Trusted Publishing (OIDC) — no stored npm token",
      "npm install --no-audit --no-fund",
      "npm run build",
      "npm test",
      "npm publish --access public --provenance",
      "provenance attestation",
      "tag check is **skipped**",
    );
  });

  test("the lockfile is committed, so the documented npm ci works and npm version bumps it", () => {
    expect(read(".gitignore").split(/\r?\n/)).not.toContain("package-lock.json");
    expect(pkg.scripts.version).toContain("package-lock.json");
    expect(doc).not.toMatch(/gitignores\s+`package-lock\.json`/);
    expectDocMentions("npm ci && npm run build && npm test", "committed `package-lock.json`");
    expect(doc).toMatch(/npm version <X\.Y\.Z> --no-git-tag-version\s+# package\.json \+ package-lock\.json/);
  });

  test("documented scripts exist with the expected meaning", () => {
    expect(pkg.scripts.build).toBe("tsc -p tsconfig.json");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.version).toContain("npm run sync-manifest");
    expect(pkg.scripts.version).toContain("npm run sync-readme-tag");
    expectDocMentions("npm run sync-manifest", "npm run sync-readme-tag", "npm pack --dry-run");
  });

  test("npm retry guidance uses an exact scoped-version read and warns it is not idempotent", () => {
    expectDocMentions(`npm view ${pkg.name}@X.Y.Z version`, "gh workflow run npm-publish.yml --ref vX.Y.Z");
    expect(doc).toMatch(/\*\*not idempotent\*\*/);
    expect(doc).toMatch(/never in a loop/);
  });

  test("ClawHub re-run passes the dispatch input the workflow defines", () => {
    expect(clawhubWf).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*version:/);
    expect(clawhubWf).toMatch(/git describe --tags --abbrev=0/);
    expect(clawhubWf).toMatch(/CHANGELOG\.md/);
    expectDocMentions("gh workflow run clawhub-publish.yml --ref vX.Y.Z -f version=X.Y.Z", "`git describe --tags`");
  });

  test("a failed registry query is inconclusive, and the ClawHub echo is not registry proof", () => {
    expect(doc).toMatch(/explicitly absent/);
    expect(doc).toMatch(/\*\*inconclusive\*\*, not "missing"/);
    expect(clawhubWf).toMatch(/echo "Published \$PACKAGE_NAME@\$VERSION to ClawHub"/);
    expect(doc).toMatch(/\*\*not\*\* a read of the\s+registry/);
    expect(doc).toMatch(/record it as unverified/);
  });

  test("no stale manual-only, stored-token or tag-rewriting instructions", () => {
    expect(doc).not.toMatch(/never CI/i);
    expect(doc).not.toMatch(/npm whoami|npm login|NPM_TOKEN|NODE_AUTH_TOKEN|automation token/);
    expect(doc).not.toMatch(/git tag (-d|-f|--delete|--force)|git push[^\n]*(--delete|--force|:refs\/tags)/);
  });

  test("package publication is kept distinct from host deployment", () => {
    expect(doc).toMatch(/## Publication is not deployment/);
    expect(doc).toMatch(/need their own authorisation/);
    expect(doc).toMatch(/explicit authorisation from the project's operator/);
  });
});
