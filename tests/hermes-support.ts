/**
 * Shared discovery for the Hermes integration suites.
 *
 * Never spawns a bare `python3`: the bridge only works in the interpreter that
 * has Hermes importable, which is the venv sibling of the `hermes` launcher —
 * the same one `scripts/hermes.mjs` resolves at runtime. When that interpreter
 * is absent or too old, the suites skip instead of failing, so `npm test` stays
 * green on a machine without Hermes installed.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const REQUIRED_HERMES_SYMBOLS = [
  "from hermes_cli.config import read_raw_config,save_config",
  "from hermes_cli.auth import read_credential_pool,write_credential_pool",
  "from agent.credential_pool import PooledCredential",
  "from hermes_constants import get_hermes_home,get_default_hermes_root",
];

export interface HermesRuntime {
  launcher: string;
  python: string;
  version: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

let cached: HermesRuntime | undefined | null = null;

/** Returns undefined when Hermes is unavailable or lacks the required APIs. */
export function findHermesRuntime(): HermesRuntime | undefined {
  if (cached !== null) return cached;
  cached = undefined;
  const launcher = findOnPath("hermes");
  if (!launcher) return cached;
  let resolved: string;
  try {
    resolved = realpathSync(launcher);
  } catch {
    return cached;
  }
  const bin = dirname(resolved);
  const probe = [
    "import importlib.metadata,json",
    ...REQUIRED_HERMES_SYMBOLS,
    "print(json.dumps({'version':importlib.metadata.version('hermes-agent')}))",
  ].join(";");
  for (const name of ["python3", "python"]) {
    const python = join(bin, name);
    if (!executable(python)) continue;
    const result = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) continue;
    try {
      const info = JSON.parse(result.stdout.trim());
      if (typeof info.version === "string") {
        cached = { launcher: resolved, python, version: info.version };
        return cached;
      }
    } catch {
      // Try the next sibling interpreter.
    }
  }
  return cached;
}

export const HERMES = findHermesRuntime();
export const SKIP_REASON =
  "Hermes Agent with the required credential-pool APIs is not installed on this machine";

/**
 * Every suite gets its own HOME as well as its own HERMES_HOME. HERMES_HOME
 * alone is not isolation: Hermes resolves the global-root auth store from HOME,
 * and its pytest seat belt does not fire under vitest, so a suite that leaves
 * HOME alone can read the developer's real credentials.
 */
export function isolatedEnv(home: string, hermesHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.HERMES_HOME = hermesHome;
  delete env.XDG_CONFIG_HOME;
  delete env.HERMES_MANAGED;
  // Hermes 0.20.6 seeds Anthropic pool rows from these ambient variables.
  // A test child must see only the staged auth.json, never the developer's
  // real subscription or API credential.
  delete env.ANTHROPIC_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Write an auth.json exactly as Hermes stores it, without invoking Hermes. */
export function writeAuthStore(hermesHome: string, anthropicRows: unknown[]): string {
  mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
  const path = join(hermesHome, "auth.json");
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, providers: {}, credential_pool: { anthropic: anthropicRows } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}

/** Run a snippet in the Hermes interpreter against one isolated home. */
export function hermesPython(
  home: string,
  hermesHome: string,
  source: string,
): unknown {
  const runtime = findHermesRuntime();
  if (!runtime) throw new Error(SKIP_REASON);
  const result = spawnSync(runtime.python, ["-c", source], {
    env: isolatedEnv(home, hermesHome),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`hermes python failed: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}
