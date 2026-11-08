/**
 * Helpers for tests/openclaw-sdk-contract.test.ts: locate the installed
 * OpenClaw package and read the semi-internal bundled-Anthropic constants that
 * our CLEAR_ENV and backend config must stay aligned with.
 *
 * These files are NOT on the openclaw exports map, so upstream may move them
 * between releases. The helpers fail LOUDLY with a message that says what moved
 * and what to do, never skip: a skipped assertion is how this suite went blind
 * to OpenClaw 2026.9+ drift (#135).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Root of the installed `openclaw` package (the directory with package.json). */
export function installedOpenClawRoot(): string {
  // dist/ sits directly under the package root; walk up from the resolved entry
  // until a package.json named "openclaw" is found.
  let dir = dirname(require.resolve("openclaw"));
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "openclaw") return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the installed openclaw package root from require.resolve('openclaw')");
}

export function installedOpenClawVersion(root = installedOpenClawRoot()): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  if (typeof pkg.version !== "string") throw new Error(`no version in ${root}/package.json`);
  return pkg.version;
}

/** Compare calendar versions like 2026.10.10 numerically, ignoring any suffix. */
export function compareCalVer(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface UpstreamClearEnv {
  names: string[];
  /** The file the list was read from, relative to the anthropic extension dir. */
  source: "cli-constants.js" | "cli-shared.js";
}

/** Where upstream has exported CLAUDE_CLI_CLEAR_ENV, newest layout first. */
const CLEAR_ENV_SOURCES = ["cli-constants.js", "cli-shared.js"] as const;

/**
 * Read upstream's CLAUDE_CLI_CLEAR_ENV from the bundled Anthropic extension.
 * 2026.9+ exports it from cli-constants.js; 2026.8.x from cli-shared.js. The
 * legacy location is kept as a real fallback so the pinned devDependency stays
 * covered. Throws (never returns empty) when neither file exports a string
 * array, naming every location tried.
 */
export async function readUpstreamClaudeClearEnv(
  anthropicDir = join(installedOpenClawRoot(), "dist", "extensions", "anthropic"),
): Promise<UpstreamClearEnv> {
  const tried: string[] = [];
  for (const file of CLEAR_ENV_SOURCES) {
    const path = join(anthropicDir, file);
    if (!existsSync(path)) {
      tried.push(`${file}: file not found`);
      continue;
    }
    let mod: { CLAUDE_CLI_CLEAR_ENV?: unknown };
    try {
      mod = (await import(pathToFileURL(path).href)) as typeof mod;
    } catch (error) {
      tried.push(`${file}: import failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const value = mod.CLAUDE_CLI_CLEAR_ENV;
    if (Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "string")) {
      return { names: value as string[], source: file };
    }
    tried.push(`${file}: CLAUDE_CLI_CLEAR_ENV is not a non-empty string[]`);
  }
  throw new Error(
    "Unsupported OpenClaw contract: CLAUDE_CLI_CLEAR_ENV was not found where this test expects it.\n" +
      `Looked in ${anthropicDir}:\n  - ${tried.join("\n  - ")}\n` +
      "Fix: find where the installed OpenClaw now exports the bundled Claude CLI clear-env list, " +
      "add that file to CLEAR_ENV_SOURCES in tests/support/openclaw-upstream.ts, and confirm src/index.ts " +
      "CLEAR_ENV still mirrors it (plus CLAUDE_CONFIG_DIR). Do not skip this assertion.",
  );
}
