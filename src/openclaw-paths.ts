/**
 * Where THIS OpenClaw instance keeps its config and state (#116).
 *
 * OpenClaw documents two variables for relocated or multi-instance installs
 * and one for a relocated home:
 *
 *   OPENCLAW_HOME         replaces the home directory OpenClaw's defaults hang
 *                         off (default: the OS home)
 *   OPENCLAW_STATE_DIR    the mutable state directory (default: <home>/.openclaw);
 *                         sessions, credentials, caches, plugin installs
 *   OPENCLAW_CONFIG_PATH  the config file (default: <state>/openclaw.json)
 *
 * Values are trimmed, a blank value counts as unset, a leading `~` expands
 * against the effective home, and a relative path resolves against the
 * working directory, as OpenClaw itself does. `OPENCLAW_PROFILE` is not
 * interpreted here: `openclaw --profile <name>` translates it into the two
 * variables above for the processes it starts, and those are what we read.
 *
 * Every multi-clawd path under the OpenClaw tree derives from this one
 * resolver, so the plugin, the shim and the CLI never act on a different
 * instance than the one the environment points at. scripts/_shared.mjs
 * carries the same logic for the plain-JS scripts, and the launcher rendered
 * by watchdog-schedule.ts embeds it; tests/issue-116-config-path-env.test.ts
 * holds the three to the same answers. Node built-ins only: this is imported
 * by the shim, which must stay free of the `openclaw` peer.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type OpenclawPathSource = "default" | "OPENCLAW_HOME" | "OPENCLAW_STATE_DIR" | "OPENCLAW_CONFIG_PATH";

export interface OpenclawPaths {
  /** The home directory the defaults hang off. */
  home: string;
  stateDir: string;
  stateSource: Exclude<OpenclawPathSource, "OPENCLAW_CONFIG_PATH">;
  configPath: string;
  configSource: OpenclawPathSource;
  /** `<state>/state/multi-clawd`: everything this plugin writes. */
  multiClawdStateDir: string;
  /** `<state>/agents`: per-agent session stores. */
  agentsDir: string;
  /** `<state>/extensions`: path installs of plugins. */
  extensionsDir: string;
  /** `<state>/npm/projects`: registry installs of plugins. */
  npmProjectsDir: string;
}

type Env = Record<string, string | undefined>;

function pick(env: Env, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function expand(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return resolve(value);
}

export function resolveOpenclawPaths(env: Env = process.env, osHome: string = homedir()): OpenclawPaths {
  const homeOverride = pick(env, "OPENCLAW_HOME");
  const home = homeOverride ? expand(homeOverride, osHome) : osHome;
  const stateOverride = pick(env, "OPENCLAW_STATE_DIR");
  const stateDir = stateOverride ? expand(stateOverride, home) : join(home, ".openclaw");
  const stateSource: OpenclawPaths["stateSource"] =
    stateOverride ? "OPENCLAW_STATE_DIR" : homeOverride ? "OPENCLAW_HOME" : "default";
  const configOverride = pick(env, "OPENCLAW_CONFIG_PATH");
  const configPath = configOverride ? expand(configOverride, home) : join(stateDir, "openclaw.json");
  const configSource: OpenclawPathSource = configOverride ? "OPENCLAW_CONFIG_PATH" : stateSource;
  return {
    home,
    stateDir,
    stateSource,
    configPath,
    configSource,
    multiClawdStateDir: join(stateDir, "state", "multi-clawd"),
    agentsDir: join(stateDir, "agents"),
    extensionsDir: join(stateDir, "extensions"),
    npmProjectsDir: join(stateDir, "npm", "projects"),
  };
}

/** The OpenClaw config file this process operates on. */
export function openclawConfigPath(env: Env = process.env): string {
  return resolveOpenclawPaths(env).configPath;
}

/** `<state>/state/multi-clawd` for this process's instance. */
export function multiClawdStateDir(env: Env = process.env): string {
  return resolveOpenclawPaths(env).multiClawdStateDir;
}

/** `<state>/agents` for this process's instance. */
export function openclawAgentsDir(env: Env = process.env): string {
  return resolveOpenclawPaths(env).agentsDir;
}

/**
 * The instance variables to pin into something that runs OUTSIDE this
 * environment (a scheduler unit): each one that is set, with its resolved
 * value, so the unit does not depend on the scheduler's own HOME or `~`.
 * Empty when the instance is the default one.
 */
export function openclawInstanceEnv(env: Env = process.env, osHome: string = homedir()): Record<string, string> {
  const paths = resolveOpenclawPaths(env, osHome);
  const pinned: Record<string, string> = {};
  if (pick(env, "OPENCLAW_HOME")) pinned.OPENCLAW_HOME = paths.home;
  if (pick(env, "OPENCLAW_STATE_DIR")) pinned.OPENCLAW_STATE_DIR = paths.stateDir;
  if (pick(env, "OPENCLAW_CONFIG_PATH")) pinned.OPENCLAW_CONFIG_PATH = paths.configPath;
  return pinned;
}

/** ` (OPENCLAW_X is set)` for a path chosen by the environment; empty for the default. */
export function describeOpenclawPathSource(source: OpenclawPathSource): string {
  return source === "default" ? "" : ` (${source} is set)`;
}
