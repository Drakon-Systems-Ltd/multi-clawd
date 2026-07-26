/**
 * Keep the README's pinned SETUP-AGENT.md URL on the current release tag.
 *
 * The agent-install one-liner points people's assistants at a raw GitHub URL,
 * and that URL is what they will actually EXECUTE. Pinning it to a tag makes
 * those instructions immutable per release — but a hand-maintained version
 * number in prose drifts (the openclaw.plugin.json version did exactly that,
 * twice), so the `version` npm hook rewrites it here instead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readmePath = join(root, "README.md");

// npm sets npm_package_version during the version lifecycle; fall back to the
// file for direct invocations.
const version =
  process.env.npm_package_version ||
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const PATTERN =
  /(raw\.githubusercontent\.com\/Drakon-Systems-Ltd\/multi-clawd\/)(?:master|v[\d.]+)(\/SETUP-AGENT\.md)/g;

const readme = readFileSync(readmePath, "utf8");
const updated = readme.replace(PATTERN, `$1v${version}$2`);

if (updated === readme) {
  console.log(`sync-readme-tag: already pinned to v${version}`);
} else {
  writeFileSync(readmePath, updated);
  console.log(`sync-readme-tag: pinned SETUP-AGENT.md URL to v${version}`);
}
