#!/usr/bin/env node
/** Secret-safe multi-clawd → Hermes credential-pool adapter. */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "hermes_bridge.py");
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SETUP_TOKEN_BYTES = 8 * 1024;
const STRATEGIES = "fill_first|round_robin|random|least_used";
// Imported by discoverHermes so a Hermes whose credential-pool API — or its
// home/root layout — has moved fails loudly at discovery instead of opaquely
// at write time.
const REQUIRED_HERMES_SYMBOLS = [
  "from hermes_cli.config import read_raw_config,save_config",
  "from hermes_cli.auth import read_credential_pool,write_credential_pool",
  "from agent.credential_pool import PooledCredential",
  "from hermes_constants import get_hermes_home,get_default_hermes_root",
];

function usage() {
  console.log(`Usage:
  multi-clawd hermes sync [--dry-run] [--profile <name>] [--strategy ${STRATEGIES}] [--config <openclaw.json>]
  multi-clawd hermes doctor [--profile <name>] [--config <openclaw.json>]

Only accounts with an oauthTokenFile (a stable \`claude setup-token\`) are
imported. A native login needs nothing imported — Hermes' own claude_code
credential source already reads that same native ~/.claude/.credentials.json.
A configDir login has no Hermes-native equivalent (claude_code only reads the
native path) — give it its own oauthTokenFile, or leave it OpenClaw-only.
Omitting --strategy leaves Hermes' configured strategy alone.`);
}

function fail(message) {
  throw new Error(message);
}

function safePath(raw, label) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) fail(`${label} path is invalid`);
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

class ReadLimitedError extends Error {}

/**
 * `requirePrivate` rejects a POSIX file readable or writable by group/other
 * (mode & 0o077 != 0) — checked via fstat on the already-open fd, so nothing
 * can be swapped between the check and the read. Windows has no equivalent
 * bit layout, so the check is skipped there; the config JSON is read through
 * here too but never with this flag, since it holds no secret.
 */
function readLimited(path, limit, label, { requirePrivate = false } = {}) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new ReadLimitedError(`${label} is unavailable or too large`);
    if (requirePrivate && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new ReadLimitedError(
        `${label} at ${path} is readable or writable by group/other — chmod 600 ${path}`,
      );
    }
    const data = readFileSync(fd);
    if (data.byteLength > limit) throw new ReadLimitedError(`${label} is unavailable or too large`);
    return data.toString("utf8");
  } catch (error) {
    if (error instanceof ReadLimitedError) fail(error.message);
    fail(`${label} could not be read`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseOptions(command, args, core) {
  if (command !== "sync" && command !== "doctor") fail("Hermes command must be sync or doctor");
  const result = { dryRun: false, profile: "default", strategy: undefined, config: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!option.startsWith("--")) fail("unexpected positional argument");
    if (seen.has(option)) fail("duplicate option");
    seen.add(option);
    if (option === "--dry-run") {
      if (command !== "sync") fail("--dry-run is only valid for hermes sync");
      result.dryRun = true;
      continue;
    }
    if (!["--profile", "--strategy", "--config"].includes(option)) fail("unknown option");
    if (option === "--strategy" && command !== "sync") fail("--strategy is only valid for hermes sync");
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${option}`);
    if (value.includes("\0")) fail(`invalid value for ${option}`);
    if (option === "--profile") result.profile = core.validateHermesProfileName(value);
    else if (option === "--strategy") result.strategy = core.validateHermesStrategy(value);
    else result.config = safePath(value, "config");
  }
  result.profile = core.validateHermesProfileName(result.profile);
  result.config ??= join(homedir(), ".openclaw", "openclaw.json");
  return result;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Guards a Hermes-reported home/root path before it is ever joined or used. */
function validHermesPath(raw) {
  return typeof raw === "string" && raw && !raw.includes("\0") && isAbsolute(raw) ? raw : undefined;
}

function findOnPath(name) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, process.platform === "win32" ? `${name}${extension}` : name);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * A setup token is piped to this interpreter, so flag a bin directory any local
 * user could swap it out in. World-writable only: a group-writable venv under a
 * umask of 002 is the norm and warning on it would be noise.
 */
function worldWritable(dir) {
  if (process.platform === "win32") return false;
  try {
    return (statSync(dir).mode & 0o002) !== 0;
  } catch {
    return false;
  }
}

function discoverHermes() {
  const launcher = findOnPath("hermes");
  if (!launcher) return { ok: false, message: "Hermes executable is not on PATH; install Hermes Agent first" };
  let resolvedLauncher;
  try {
    resolvedLauncher = realpathSync(launcher);
  } catch {
    return { ok: false, message: "Hermes launcher could not be resolved" };
  }
  const bin = dirname(resolvedLauncher);
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const candidates = names.map((name) => join(bin, name)).filter(executable);
  if (candidates.length === 0) {
    return { ok: false, launcher: resolvedLauncher, message: "Hermes venv Python was not found beside its launcher; reinstall Hermes Agent" };
  }
  const probeCode = [
    "import importlib.metadata,json,sys",
    ...REQUIRED_HERMES_SYMBOLS,
    "print(json.dumps({'version':importlib.metadata.version('hermes-agent'),'python':sys.executable," +
      "'root':str(get_default_hermes_root().resolve()),'home':str(get_hermes_home().resolve())}))",
  ].join(";");
  for (const python of candidates) {
    const probe = spawnSync(python, ["-c", probeCode], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    if (probe.status !== 0) continue;
    try {
      const info = JSON.parse(probe.stdout.trim());
      const root = validHermesPath(info.root);
      const home = validHermesPath(info.home);
      if (typeof info.version === "string" && root && home) {
        return {
          ok: true,
          launcher: resolvedLauncher,
          python,
          version: info.version,
          root,
          home,
          insecureBin: worldWritable(bin),
        };
      }
    } catch {
      // Try the next sibling interpreter.
    }
  }
  return { ok: false, launcher: resolvedLauncher, message: "Hermes Python cannot import the required credential-pool APIs; repair or update Hermes Agent" };
}

/**
 * Hermes itself owns the platform layout (native Windows `%LOCALAPPDATA%\hermes`,
 * POSIX `~/.hermes`, or a Docker/custom `HERMES_HOME` root) — this never
 * reimplements it, it only joins onto the root Hermes' own
 * `hermes_constants.get_default_hermes_root` reported. That root resolution
 * already collapses a `HERMES_HOME` pointed at a named profile
 * (`<root>/profiles/other`) back to the root, so an explicit
 * `--profile default` targets the root, never the active named profile.
 */
function targetHome(profile, root) {
  return profile === "default" ? root : join(root, "profiles", profile);
}

/**
 * Hermes refuses to mkdir a named profile home on purpose, so a deleted profile
 * is not resurrected as an empty skeleton. The adapter never creates one either.
 */
function assertProfileExists(profile, home) {
  if (profile === "default") return;
  if (!existsSync(home)) {
    fail(`Hermes profile "${profile}" does not exist; run \`hermes profile create ${profile}\` first`);
  }
}

function invokeBridge(hermes, home, request) {
  const result = spawnSync(hermes.python, [BRIDGE], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 3 * 1024 * 1024,
    env: { ...process.env, HERMES_HOME: home },
  });
  let response;
  try {
    response = JSON.parse(result.stdout || "");
  } catch {
    fail("Hermes bridge returned an invalid response");
  }
  if (result.status !== 0 || !response?.ok) {
    const code = typeof response?.error?.code === "string" ? response.error.code : "bridge_failed";
    const message = typeof response?.error?.message === "string" ? response.error.message : "Hermes bridge failed safely";
    fail(`${code}: ${message}`);
  }
  return response;
}

function loadPluginConfig(configPath) {
  const text = readLimited(configPath, MAX_CONFIG_BYTES, "OpenClaw config");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    fail("OpenClaw config is malformed JSON");
  }
  return config?.plugins?.entries?.["multi-clawd"]?.config;
}

function tokenPathFor(account) {
  return account.oauthTokenFile
    ? safePath(account.oauthTokenFile, `account ${account.id} oauthTokenFile`)
    : undefined;
}

function resolveAccount(account, priority, core) {
  const tokenPath = tokenPathFor(account);
  const source = core.chooseHermesCredentialSource(account, {
    oauthTokenFilePath: tokenPath,
    existingPaths: [tokenPath].filter(Boolean).filter(existsSync),
  });
  const token = core.parseClaudeSetupToken(
    readLimited(source.path, MAX_SETUP_TOKEN_BYTES, `setup token for account ${account.id}`, {
      requirePrivate: true,
    }),
  );
  return {
    account,
    source,
    ok: true,
    credential: core.buildHermesManagedCredential(account, token, priority),
  };
}

function diagnoseAccount(account, priority, core) {
  try {
    return resolveAccount(account, priority, core);
  } catch (error) {
    const tokenPath = (() => {
      try {
        return tokenPathFor(account);
      } catch {
        return undefined;
      }
    })();
    return {
      account,
      source: { kind: "oauthTokenFile", path: tokenPath ?? "(not configured)" },
      exists: Boolean(tokenPath) && existsSync(tokenPath),
      ok: false,
      error: error instanceof Error ? error.message : "credential source is unhealthy",
    };
  }
}

function renderSources(rows, unsupported) {
  console.log("Account setup-token sources:");
  for (const row of rows) {
    if (row.ok) {
      console.log(`  ✓ ${row.account.id}: oauthTokenFile (${row.source.path}), priority ${row.credential.priority}`);
    } else {
      const state = row.exists ? "exists but is unhealthy" : "missing";
      console.log(`  ✗ ${row.account.id}: oauthTokenFile (${row.source.path}) ${state} — ${row.error}`);
    }
  }
  for (const row of unsupported) console.log(`  – ${row.id}: not importable — ${row.reason}`);
  if (rows.length === 0) console.log("  (no importable accounts)");
}

function renderFindings(findings) {
  const errors = Object.entries(findings?.errors || {}).filter(([, rows]) => rows?.length);
  const warnings = Object.entries(findings?.warnings || {}).filter(([, rows]) => rows?.length);
  if (errors.length === 0 && warnings.length === 0) {
    console.log("Pool safety: no findings");
    return;
  }
  for (const [name, rows] of errors) console.log(`  ✗ ${name}: ${rows.length}`);
  for (const [name, rows] of warnings) console.log(`  ! ${name}: ${rows.length} (warning only; not multi-clawd's to fix)`);
}

function renderPool(response) {
  if (response.dryRun) {
    // Nothing was written, so report today's value and what a real run would set.
    const now = response.currentStrategy ?? "not configured";
    console.log(
      `Anthropic pool strategy: ${now}` +
        (response.strategyChanged ? ` → ${response.strategy} (projected)` : ""),
    );
  } else {
    const strategy = response.strategy ?? "not configured";
    const effective = response.effectiveStrategy;
    console.log(
      `Anthropic pool strategy: ${strategy}${effective && effective !== strategy ? ` (effective: ${effective})` : ""}`,
    );
  }
  const rows = response.resultingRows || response.localRows || [];
  const managed = rows.filter((row) => row?.managed);
  console.log(`Managed rows: ${managed.length} of ${rows.length} profile-local rows`);
  for (const row of managed) console.log(`  ${row.label || "multi-clawd managed row"}: ${row.lastStatus || "ready"}`);
  if (response.effectiveIncludesGlobalFallback) {
    console.log(
      "  note: this profile owns no Anthropic rows yet, so Hermes currently reads the " +
        `global pool (${response.effectiveRowCount} rows) as a read-only fallback; sync writes only here`,
    );
  }
  if (response.orphanManagedRowCount > 0) {
    console.log(
      `  note: ${response.orphanManagedRowCount} managed row(s) belong to accounts no longer ` +
        "configured; they are preserved — remove them with Hermes if unwanted",
    );
  }
  renderFindings(response.findings);
}

async function main() {
  let core;
  try {
    core = await import(resolve(HERE, "..", "dist", "hermes-core.js"));
  } catch {
    fail("built dist/hermes-core.js is missing; reinstall the package or run npm run build");
  }
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const options = parseOptions(command, args, core);
  if (options.help) {
    usage();
    return;
  }

  // Validate every account and read every token before anything is mutated.
  const pluginConfig = loadPluginConfig(options.config);
  const { accounts, unsupported } = core.collectHermesAccounts(pluginConfig?.accounts);
  const priorities = core.hermesAccountPriorities(pluginConfig, accounts);
  const sourceRows = accounts.map((account) =>
    command === "doctor"
      ? diagnoseAccount(account, priorities.get(account.id) ?? 0, core)
      : resolveAccount(account, priorities.get(account.id) ?? 0, core),
  );

  // Report what the OpenClaw side looks like before anything depends on the
  // Hermes install, so diagnostics survive a machine without Hermes on it.
  renderSources(sourceRows, unsupported);

  const hermes = discoverHermes();
  console.log(`Hermes: ${hermes.ok ? `v${hermes.version}` : "not ready"}`);
  if (!hermes.ok) fail(hermes.message);
  if (hermes.insecureBin) {
    console.log(`  ! ${dirname(hermes.launcher)} is writable by other users — anyone who can write there can replace the interpreter this sends tokens to`);
  }
  const home = targetHome(options.profile, hermes.root);
  console.log(`Profile: ${options.profile} (${home})`);
  assertProfileExists(options.profile, home);

  if (command === "doctor") {
    const response = invokeBridge(
      hermes,
      home,
      core.buildHermesBridgeRequest({ operation: "doctor", targetHome: home }),
    );
    renderPool(response);
    if (sourceRows.some((row) => !row.ok) || unsupported.length > 0 || !response.healthy) {
      fail("Hermes doctor found unhealthy or unsupported credential sources, or unsafe pool state");
    }
    console.log("Hermes integration: healthy");
    console.log(
      "  note: this checks files, pool/config structure, and integration safety only — it makes " +
        "no live Anthropic request and cannot prove a setup token is still accepted; that surfaces " +
        "at runtime through Hermes' own native 401/429 handling.",
    );
    return;
  }

  if (unsupported.length > 0) {
    fail(
      `${unsupported.length} configured account(s) cannot be imported into Hermes; ` +
        "fix or remove them (listed above) and re-run — nothing was written",
    );
  }
  // Probe first so safety/config failures are reported before an apply request.
  invokeBridge(hermes, home, core.buildHermesBridgeRequest({ operation: "probe", targetHome: home }));
  const response = invokeBridge(
    hermes,
    home,
    core.buildHermesBridgeRequest({
      operation: "apply",
      targetHome: home,
      strategy: options.strategy,
      dryRun: options.dryRun,
      credentials: sourceRows.map((row) => row.credential),
    }),
  );
  const adds = response.actions.filter((row) => row.action === "add").length;
  const updates = response.actions.filter((row) => row.action === "update").length;
  const noops = response.actions.filter((row) => row.action === "noop").length;
  const strategyNote = response.strategyChanged
    ? " (changed)"
    : response.requestedStrategy === null
      ? " (preserved)"
      : "";
  console.log(`Sync: add ${adds}, update ${updates}, noop ${noops}; strategy ${response.strategy}${strategyNote}`);
  if (options.dryRun) console.log(`DRY RUN: no files were written${response.wouldWrite ? "; changes would be made" : "; already in sync"}.`);
  else console.log(response.wrote ? "Hermes credentials synchronized." : "Hermes credentials already in sync; no files written.");
  renderPool(response);
}

main().catch((error) => {
  console.error(`hermes: ${error instanceof Error ? error.message : "operation failed safely"}`);
  process.exitCode = 1;
});
