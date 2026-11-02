/**
 * Shared helpers for the CLI scripts (cli.mjs, setup.mjs, doctor.mjs,
 * hermes.mjs, eviction-watchdog.mjs, account-config.mjs).
 *
 * Two real footguns shaped this file: run via `npx`, a script's __dirname is
 * the EPHEMERAL npx cache; and the npm install dir itself is regenerated on
 * every update. So nothing durable (scheduler units) may point at either —
 * they point at the stable WATCHDOG_LAUNCHER, which resolves the current
 * install at runtime.
 *
 * A third (#116): the OpenClaw instance is chosen by the environment.
 * OPENCLAW_CONFIG_PATH names the config file, OPENCLAW_STATE_DIR the state
 * directory (and the default config location `<state>/openclaw.json`), and
 * OPENCLAW_HOME the home the `~/.openclaw` default hangs off. Every script
 * path under the OpenClaw tree comes from resolveOpenclawPaths below, so a
 * command never reads, and above all never WRITES, a different instance than
 * the one the user pointed it at. src/openclaw-paths.ts is the same resolver
 * for the plugin and shim; tests/issue-116-config-path-env.test.ts keeps the
 * two in step.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function pick(env, name) {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function expand(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return resolve(value);
}

/**
 * Where this OpenClaw instance keeps its config and state. Values are
 * trimmed, a blank value counts as unset, a leading `~` expands against the
 * effective home and a relative path resolves against the working directory,
 * as OpenClaw itself does. OPENCLAW_PROFILE is not interpreted: `openclaw
 * --profile` translates it into the two variables for the processes it starts.
 */
export function resolveOpenclawPaths(env = process.env, osHome = homedir()) {
  const homeOverride = pick(env, "OPENCLAW_HOME");
  const home = homeOverride ? expand(homeOverride, osHome) : osHome;
  const stateOverride = pick(env, "OPENCLAW_STATE_DIR");
  const stateDir = stateOverride ? expand(stateOverride, home) : join(home, ".openclaw");
  const stateSource = stateOverride ? "OPENCLAW_STATE_DIR" : homeOverride ? "OPENCLAW_HOME" : "default";
  const configOverride = pick(env, "OPENCLAW_CONFIG_PATH");
  const configPath = configOverride ? expand(configOverride, home) : join(stateDir, "openclaw.json");
  const configSource = configOverride ? "OPENCLAW_CONFIG_PATH" : stateSource;
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

/** The OpenClaw config path this process operates on, resolved for display (never a literal `~`). */
export function openclawConfigPath(env = process.env) {
  return resolveOpenclawPaths(env).configPath;
}

/** `<state>/state/multi-clawd`: everything multi-clawd writes for this instance. */
export function multiClawdStateDir(env = process.env) {
  return resolveOpenclawPaths(env).multiClawdStateDir;
}

/** `<state>/agents`: the instance's per-agent session stores. */
export function openclawAgentsDir(env = process.env) {
  return resolveOpenclawPaths(env).agentsDir;
}

/**
 * The instance variables to pin into something that runs OUTSIDE this
 * environment (a scheduler unit): each one that is set, with its resolved
 * value. Empty for the default instance.
 */
export function openclawInstanceEnv(env = process.env, osHome = homedir()) {
  const paths = resolveOpenclawPaths(env, osHome);
  const pinned = {};
  if (pick(env, "OPENCLAW_HOME")) pinned.OPENCLAW_HOME = paths.home;
  if (pick(env, "OPENCLAW_STATE_DIR")) pinned.OPENCLAW_STATE_DIR = paths.stateDir;
  if (pick(env, "OPENCLAW_CONFIG_PATH")) pinned.OPENCLAW_CONFIG_PATH = paths.configPath;
  return pinned;
}

/** ` (OPENCLAW_X is set)` for a path chosen by the environment; empty for the default. */
export function describeOpenclawPathSource(source) {
  return source === "default" ? "" : ` (${source} is set)`;
}

/** Where the plugin is installed: path install wins, else newest npm-project install. */
export function resolveInstallDir() {
  const { extensionsDir, npmProjectsDir } = resolveOpenclawPaths();
  const extDir = join(extensionsDir, "multi-clawd");
  if (existsSync(join(extDir, "openclaw.plugin.json"))) return extDir;
  let best;
  let bestM = -1;
  try {
    for (const p of readdirSync(npmProjectsDir)) {
      if (!p.startsWith("drakon-systems-multi-clawd-")) continue;
      const dir = join(npmProjectsDir, p, "node_modules", "@drakon-systems", "multi-clawd");
      const manifest = join(dir, "openclaw.plugin.json");
      if (!existsSync(manifest)) continue;
      const m = statSync(manifest).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = dir;
      }
    }
  } catch {
    /* no npm projects dir */
  }
  return best;
}

/**
 * The stable launcher path scheduler units point at. Lives in the instance's
 * state dir (never moved by installs); its content is rendered by
 * watchdog-schedule.ts#renderWatchdogLauncher and resolves the current
 * install at runtime.
 */
export const WATCHDOG_LAUNCHER = join(multiClawdStateDir(), "watchdog-launcher.mjs");

/**
 * One diagnostic for every command that needs the OpenClaw config (#106).
 *
 * `error` is whatever reading or parsing threw. The message names the resolved
 * path and the next step, and keeps the real causes apart: the file is missing
 * (and whether OpenClaw itself looks installed), it is unreadable for this
 * user, it is not a regular file, or it is present but not valid JSON. It never
 * repeats raw Node error text: an fs message is noise to a first-time user, and
 * a JSON SyntaxError quotes a slice of the file, which may hold credentials.
 *
 * A `configPath` other than the instance's own (hermes `--config`) gets a
 * "check the path" step instead of `multi-clawd setup`, which only writes the
 * instance path; that split applies to the missing and the not-a-regular-file
 * cases alike. When the environment chose the path (#116), a missing file
 * says which variable did, so nobody hunts for it at the default location.
 */
export function describeOpenclawConfigError(error, configPath = openclawConfigPath()) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  const paths = resolveOpenclawPaths();
  const isDefault = configPath === paths.configPath;
  const fromEnv = isDefault && paths.configSource !== "default";
  const at = `OpenClaw config at ${configPath}`;
  if (code === "ENOENT") {
    const dir = dirname(configPath);
    if (fromEnv) {
      return `OpenClaw config not found at ${configPath} (${paths.configSource} is set). ` +
        `Run \`multi-clawd setup\` in this environment to create it there, or correct ${paths.configSource}.`;
    }
    if (isDefault && !existsSync(dir)) {
      return `OpenClaw config not found at ${configPath} (no ${dir} directory). ` +
        "Install and start OpenClaw first, then run `multi-clawd setup`.";
    }
    return `OpenClaw config not found at ${configPath}. ` + (isDefault
      ? "Run `multi-clawd setup` to create it."
      : "Check the --config path, or omit it to use the default location.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return `${at} is not readable: permission denied. Run multi-clawd as the user that ` +
      "owns the OpenClaw install, or fix the file's ownership and mode; `multi-clawd setup` cannot fix this.";
  }
  const notRegular = { EISDIR: "it is a directory", ELOOP: "it is a symbolic-link loop",
    ENOTDIR: "a parent in the path is not a directory" }[code];
  if (notRegular) {
    // `multi-clawd setup` writes only the instance path, so for a custom
    // `--config` the fix is the named path (or the option), never setup.
    return `${at} is not a regular file (${notRegular}). ` + (isDefault
      ? "Move whatever is at that path aside, then run `multi-clawd setup` or restore the OpenClaw config file."
      : "Restore the OpenClaw config file at that path, or correct the --config path (omit it to use the " +
        "default location); `multi-clawd setup` only writes the default path.");
  }
  if (error instanceof SyntaxError) {
    return `${at} is malformed JSON. Fix the file by hand (a JSON validator helps) and retry; ` +
      "`multi-clawd setup` does not repair it.";
  }
  return `${at} could not be read${code ? ` (${code})` : ""}.`;
}
