/**
 * Harness for tests/issue-155-unbound-cron-route.test.ts (multi-clawd#155).
 *
 * Two halves:
 *
 *  1. Pure helpers (scratch layout, child environment, isolation guard,
 *     evidence evaluators). They start nothing and run everywhere, so the
 *     guards and detectors are themselves tested on every `npm test`.
 *  2. Gateway-child helpers (start a throwaway OpenClaw gateway, drive it
 *     through the documented `openclaw cron` CLI). These are only ever called
 *     from the gated suite: MC155_GATEWAY_ROUTE=1, set by the CI job and by
 *     nobody else. They must never run on a host with a live gateway.
 *
 * Nothing here deletes anything. The scratch root is left for the runner
 * (CI workspace teardown, the remote test runner's own temp sweep) to discard.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../../src/claude-command.js";
import { installedOpenClawRoot } from "./openclaw-upstream.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const FAKE_CLAUDE = join(REPO_ROOT, "tests", "fixtures", "fake-claude.mjs");
export const TRIPWIRE = join(REPO_ROOT, "tests", "fixtures", "mc155", "net-tripwire.cjs");
const WRAPPER_ENTRY = join(REPO_ROOT, "tests", "fixtures", "mc155", "wrapper-plugin.mjs");

/** The admission error reported in #155. Not an upstream contract: pinned so a change is noticed. */
export const ADMISSION_REFUSAL_155 =
  "Automation requires a stored inference account or a key in provider config. Select an account with model@profile.";
/** Fragment of the run-time refusal for an automation with no recorded account. */
export const RUNTIME_REFUSAL_FRAGMENT = "no recorded inference account";
/** Core's startup notice for a CLI backend that declares no modelProvider. */
export const MISSING_MODEL_PROVIDER_FRAGMENT = "is missing modelProvider";

export const POOL_ID = "clawd";
export const POOL_ACCOUNTS = ["claw1", "claw2"] as const;
export const CLAUDE_MODEL_ID = "claude-sonnet-5-5";
export const MODEL_REF = `${POOL_ID}/${CLAUDE_MODEL_ID}`;
/** A fixture value, not a credential: it guards a loopback gateway that lives for one test. */
export const FIXTURE_GATEWAY_TOKEN = "mc155-fixture-token-not-a-secret";
/** Earliest OpenClaw whose admission binder this evidence was traced against. */
export const MIN_BINDER_OPENCLAW = "2026.10.10";

export type Variant = "M0" | "M1";

export interface Scratch {
  root: string;
  home: string;
  state: string;
  config: string;
  tmp: string;
  work: string;
  bin: string;
  logs: string;
  pluginDir: string;
  accountDirs: Record<string, string>;
  launchLog: string;
  tripwireLog: string;
  gatewayStdout: string;
  gatewayStderr: string;
  /** OpenClaw's own rolling file log, pinned into scratch through `logging.file`. */
  gatewayFileLog: string;
}

/**
 * Create the scratch tree for one gateway child. Creates directories only.
 *
 * MC155_SCRATCH_BASE overrides the parent directory (default: the OS temp
 * dir). OpenClaw refuses to run a CLI backend under a group- or
 * world-writable ancestor that lacks the sticky bit, which is what a private
 * per-run temp dir on a shared test runner can be; point this at a sticky
 * /tmp there.
 */
export function createScratch(label: string): Scratch {
  const base = process.env.MC155_SCRATCH_BASE?.trim() || tmpdir();
  const root = realpathSync(mkdtempSync(join(base, `mc155-${label}-`)));
  const scratch: Scratch = {
    root,
    home: join(root, "home"),
    state: join(root, "state"),
    config: join(root, "openclaw.json"),
    tmp: join(root, "tmp"),
    work: join(root, "work"),
    bin: join(root, "bin"),
    logs: join(root, "logs"),
    pluginDir: join(root, "plugin"),
    accountDirs: { claw1: join(root, "accts", "a1"), claw2: join(root, "accts", "a2") },
    launchLog: join(root, "logs", "fake-claude-launches.jsonl"),
    tripwireLog: join(root, "logs", "net-tripwire.jsonl"),
    gatewayStdout: join(root, "logs", "gateway.stdout.log"),
    gatewayStderr: join(root, "logs", "gateway.stderr.log"),
    gatewayFileLog: join(root, "logs", "openclaw-file.log"),
  };
  for (const dir of [
    scratch.home,
    scratch.state,
    scratch.tmp,
    scratch.work,
    scratch.bin,
    scratch.logs,
    scratch.pluginDir,
    ...Object.values(scratch.accountDirs),
  ]) {
    // Owner-only whatever the host umask is: OpenClaw refuses to run a CLI
    // backend from a temp workspace with a group-writable ancestor.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  chmodSync(join(root, "accts"), 0o700);
  // The child's whole PATH is this one directory: `node` and `sh`, nothing
  // else. Whatever the host keeps beside them (a real `claude` in /usr/bin on
  // the remote test runner, say) is not reachable from the gateway child.
  symlinkSync(process.execPath, join(scratch.bin, "node"));
  symlinkSync("/bin/sh", join(scratch.bin, "sh"));
  return scratch;
}

/**
 * Materialise the wrapper plugin as one self-contained directory: the
 * checked-in wrapper entry, a copy of the built `dist/` (so the shim sits
 * beside the entry, as in a real install), and the repository's own manifest
 * (copied at run time, so it can never drift from the real one).
 */
export function writeWrapperPlugin(scratch: Scratch): void {
  const dist = join(REPO_ROOT, "dist");
  for (const file of ["index.js", "shim.js"]) {
    if (!existsSync(join(dist, file))) throw new Error(`mc155: dist/${file} is missing; the global build did not run`);
  }
  cpSync(dist, join(scratch.pluginDir, "dist"), { recursive: true });
  copyFileSync(WRAPPER_ENTRY, join(scratch.pluginDir, "index.mjs"));
  copyFileSync(join(REPO_ROOT, "openclaw.plugin.json"), join(scratch.pluginDir, "openclaw.plugin.json"));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
    openclaw?: { compat?: unknown; build?: unknown };
  };
  writeFileSync(
    join(scratch.pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "mc155-wrapper-fixture",
        private: true,
        version: pkg.version,
        type: "module",
        openclaw: {
          build: pkg.openclaw?.build,
          extensions: ["./index.mjs"],
          runtimeExtensions: ["./index.mjs"],
          compat: pkg.openclaw?.compat,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

/** The operator config for one variant. M1 adds the `agentRuntime` policy; M0 has none. */
export function buildConfig(scratch: Scratch, variant: Variant, port: number): Record<string, unknown> {
  return {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token: FIXTURE_GATEWAY_TOKEN },
    },
    // Documented switches for OpenClaw's own background requests (docs
    // gateway/telemetry.md, gateway/config-runtime.md). The tripwire would
    // refuse them anyway; with these off, a clean tripwire log is expected.
    // Without this the rolling file log goes to the shared /tmp/openclaw
    // directory, outside scratch (docs logging.md).
    logging: { file: scratch.gatewayFileLog },
    update: { checkOnStart: false },
    models: { catalogRefresh: { enabled: false } },
    plugins: {
      load: { paths: [scratch.pluginDir] },
      entries: {
        "multi-clawd": {
          enabled: true,
          config: {
            accounts: POOL_ACCOUNTS.map((id) => ({ id, configDir: scratch.accountDirs[id] })),
            pool: { id: POOL_ID, accounts: [...POOL_ACCOUNTS] },
          },
        },
      },
    },
    ...(variant === "M1"
      ? { agents: { defaults: { models: { [MODEL_REF]: { agentRuntime: { id: POOL_ID } } } } } }
      : {}),
  };
}

/**
 * The gateway child's whole environment, built from nothing. `process.env` is
 * not read. PATH is one scratch directory holding only `node` and `sh`.
 */
export function buildChildEnv(scratch: Scratch, variant: Variant): Record<string, string> {
  return {
    PATH: scratch.bin,
    HOME: scratch.home,
    OPENCLAW_HOME: scratch.home,
    OPENCLAW_STATE_DIR: scratch.state,
    OPENCLAW_CONFIG_PATH: scratch.config,
    XDG_CONFIG_HOME: join(scratch.home, ".config"),
    XDG_STATE_HOME: join(scratch.home, ".local", "state"),
    XDG_CACHE_HOME: join(scratch.home, ".cache"),
    XDG_DATA_HOME: join(scratch.home, ".local", "share"),
    TMPDIR: scratch.tmp,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    // Documented embedding preset (docs gateway/embedding.md).
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}`,
    MC155_TRIPWIRE_LOG: scratch.tripwireLog,
    MC155_MODEL_PROVIDER: variant === "M1" ? "own-id" : "",
    // Interpreter form: the plugin keeps its legacy `node dist/shim.js` launch
    // and the shim runs the fake. The shim refuses to fall back to a `claude`
    // on PATH when this is set (src/shim.ts). The backend clears NODE_OPTIONS
    // for its child (as the bundled claude-cli backend does), so the tripwire
    // is preloaded into the fake explicitly.
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify(fakeClaudeArgv()),
    FAKE_CLAUDE_LAUNCH_LOG: scratch.launchLog,
  };
}

/** The interpreter-form override: node, with the tripwire preloaded, running the fake. */
export function fakeClaudeArgv(): string[] {
  return [process.execPath, "--require", TRIPWIRE, FAKE_CLAUDE];
}

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TZ",
  "LANG",
  "NO_COLOR",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_DISABLE_BONJOUR",
  "OPENCLAW_NO_RESPAWN",
  "OPENCLAW_EXEC_SHELL_SNAPSHOT",
  "NODE_OPTIONS",
  "MC155_TRIPWIRE_LOG",
  "MC155_MODEL_PROVIDER",
  "MULTI_CLAWD_CLAUDE_BIN",
  "FAKE_CLAUDE_LAUNCH_LOG",
]);
const SCRATCH_PATH_KEYS = [
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "MC155_TRIPWIRE_LOG",
  "FAKE_CLAUDE_LAUNCH_LOG",
];

function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Every reason this environment must NOT be used to start a gateway child.
 * Empty means isolated. `realHome` is injectable so the guard's own tests can
 * prove it fires.
 */
export function isolationViolations(
  env: Readonly<Record<string, string>>,
  scratchRoot: string,
  realHome: string = homedir(),
): string[] {
  const violations: string[] = [];
  if (!/^mc155-/.test(scratchRoot.split(sep).pop() ?? "")) {
    violations.push(`scratch root ${scratchRoot} is not an mc155- temp directory`);
  }
  if (scratchRoot === realHome || isInside(scratchRoot, realHome)) {
    violations.push("scratch root contains the real home directory");
  }
  for (const key of Object.keys(env)) {
    if (!ALLOWED_ENV_KEYS.has(key)) violations.push(`environment variable ${key} is not on the allowlist`);
  }
  for (const key of SCRATCH_PATH_KEYS) {
    const value = env[key];
    if (value === undefined) violations.push(`${key} is not set`);
    else if (!isInside(scratchRoot, value)) violations.push(`${key} points outside the scratch root`);
  }
  if (env.HOME === realHome) violations.push("HOME is the real home directory");
  for (const key of [
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_DISABLE_BONJOUR",
    "OPENCLAW_NO_RESPAWN",
  ]) {
    if (env[key] !== "1") violations.push(`${key} must be "1"`);
  }
  if (!(env.NODE_OPTIONS ?? "").includes(TRIPWIRE)) violations.push("NODE_OPTIONS does not preload the network tripwire");
  let claudeBin: unknown;
  try {
    claudeBin = JSON.parse(env.MULTI_CLAWD_CLAUDE_BIN ?? "");
  } catch {
    claudeBin = undefined;
  }
  if (!Array.isArray(claudeBin) || JSON.stringify(claudeBin.slice(1)) !== JSON.stringify(fakeClaudeArgv().slice(1))) {
    violations.push("MULTI_CLAWD_CLAUDE_BIN is not the interpreter-form fake Claude fixture");
  }
  if (findOnPath("claude", env.PATH)) violations.push("a real `claude` executable is reachable on the child PATH");
  return violations;
}

export function assertIsolated(env: Readonly<Record<string, string>>, scratchRoot: string): void {
  const violations = isolationViolations(env, scratchRoot);
  if (violations.length > 0) {
    throw new Error(`mc155: refusing to start a gateway child:\n - ${violations.join("\n - ")}`);
  }
}

/** Account directories must hold no credential (or anything else) before the run. */
export function accountDirsAreEmpty(scratch: Scratch, list: (dir: string) => string[]): boolean {
  return Object.values(scratch.accountDirs).every((dir) => list(dir).length === 0);
}

// ---------------------------------------------------------------------------
// Evidence: readers and evaluators (pure)
// ---------------------------------------------------------------------------

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export interface TripwireEntry {
  pid: number;
  event: "armed" | "blocked-connect" | "blocked-udp" | "blocked-lookup";
  host?: string;
  port?: number | null;
  script?: string | null;
}

/** True only when the log proves the tripwire loaded in at least one process. */
export function tripwireArmed(entries: readonly TripwireEntry[]): boolean {
  return entries.some((entry) => entry.event === "armed");
}

/** Every refused attempt. Each one was stopped before a packet left the process. */
export function tripwireBlocked(entries: readonly TripwireEntry[]): TripwireEntry[] {
  return entries.filter((entry) => entry.event !== "armed");
}

/**
 * Hosts OpenClaw itself contacts in the background (update check, hosted
 * model catalog, plugin registry). The config turns off the two that have a
 * documented switch; any that remain are refused by the tripwire and recorded
 * as evidence. They are OpenClaw's own, carry no credential from this
 * fixture, and never reach the network here.
 */
export const OPENCLAW_BACKGROUND_HOSTS: readonly string[] = [
  "telemetry.openclaw.ai",
  "catalog.openclaw.ai",
  "clawhub.ai",
];

/** Refused attempts to anything that is NOT one of OpenClaw's own background hosts. Must be empty. */
export function unexpectedBlocked(entries: readonly TripwireEntry[]): TripwireEntry[] {
  return tripwireBlocked(entries).filter((entry) => !OPENCLAW_BACKGROUND_HOSTS.includes(entry.host ?? ""));
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** S0: the reported #155 admission refusal, and nothing weaker. */
export function isAdmissionRefusal155(result: CliResult): boolean {
  return result.status !== 0 && `${result.stdout}\n${result.stderr}`.includes(ADMISSION_REFUSAL_155);
}

export interface FakeLaunch {
  pid: number;
  model: string | null;
  account_id: string | null;
  config_dir: string | null;
  home: string | null;
  anthropic_env_names: string[];
  has_oauth_token: boolean;
  tripwire_armed: boolean;
}

/**
 * S2: every reason the launch log does NOT show one clean pool launch.
 * Empty means the route evidence holds.
 */
export function routeEvidenceProblems(
  launches: readonly FakeLaunch[],
  scratch: Pick<Scratch, "root" | "accountDirs">,
): string[] {
  if (launches.length === 0) return ["no fake Claude launch was recorded"];
  const problems: string[] = [];
  if (launches.length !== 1) problems.push(`expected exactly 1 launch, saw ${launches.length}`);
  for (const launch of launches) {
    if (launch.model !== CLAUDE_MODEL_ID) {
      problems.push(`launch model is ${JSON.stringify(launch.model)}, expected ${CLAUDE_MODEL_ID}`);
    }
    const account = launch.account_id ?? "";
    if (!(POOL_ACCOUNTS as readonly string[]).includes(account)) {
      problems.push(`launch account ${JSON.stringify(launch.account_id)} is not a pool account`);
    } else if (launch.config_dir !== scratch.accountDirs[account]) {
      problems.push(`launch config dir is not the scratch dir of ${account}`);
    }
    if (!launch.config_dir || !isInside(scratch.root, launch.config_dir)) {
      problems.push("launch config dir is outside the scratch root");
    }
    if (!launch.home || !isInside(scratch.root, launch.home)) {
      problems.push("launch HOME is outside the scratch root");
    }
    if (launch.anthropic_env_names.length > 0) {
      problems.push(`launch carried ANTHROPIC_* variables: ${launch.anthropic_env_names.join(", ")}`);
    }
    if (launch.has_oauth_token) problems.push("launch carried a CLAUDE_CODE_OAUTH_TOKEN");
    if (!launch.tripwire_armed) problems.push("the network tripwire was not armed in the fake Claude process");
  }
  return problems;
}

/** The exact run-time refusal core raises when it runs an automation that has no recorded account. */
export const RUNTIME_REFUSAL_SENTENCE = "Automation has no recorded inference account.";

/**
 * S3: the lines that show OUR job being refused at run time. A line counts
 * when it carries the exact refusal sentence, or when it carries the fragment
 * in any wording together with this job's id or name. Core also logs an
 * account-check notice in that wording about its own built-in jobs; those are
 * about another job and are reported separately by `otherJobAccountNotices`.
 */
export function runtimeRefusalLines(texts: readonly string[], job: { id: string; name: string }): string[] {
  return fragmentLines(texts)
    .filter((line) => line.includes(RUNTIME_REFUSAL_SENTENCE) || mentionsJob(line, job))
    .map(clip);
}

/** Lines with the fragment that concern some other job (observation only, never asserted). */
export function otherJobAccountNotices(texts: readonly string[], job: { id: string; name: string }): string[] {
  return fragmentLines(texts)
    .filter((line) => !line.includes(RUNTIME_REFUSAL_SENTENCE) && !mentionsJob(line, job))
    .map(clip);
}

function fragmentLines(texts: readonly string[]): string[] {
  return texts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.toLowerCase().includes(RUNTIME_REFUSAL_FRAGMENT));
}
function mentionsJob(line: string, job: { id: string; name: string }): boolean {
  return (job.id !== "" && line.includes(job.id)) || (job.name !== "" && line.includes(job.name));
}
function clip(line: string): string {
  return line.slice(0, 500);
}

/** Parse the last JSON document in CLI output (the CLI may print notices before it). */
export function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through: look for the last top-level JSON object or array
  }
  for (let start = trimmed.length - 1; start >= 0; start -= 1) {
    const ch = trimmed[start];
    if (ch !== "{" && ch !== "[") continue;
    if (start > 0 && trimmed[start - 1] !== "\n") continue;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // keep scanning backwards
    }
  }
  throw new Error(`mc155: no JSON document in CLI output:\n${stdout.slice(0, 2000)}`);
}

/** Every key path in a JSON value whose key name matches `pattern` and whose value is set. */
export function keyPathsMatching(value: unknown, pattern: RegExp, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (pattern.test(key) && child !== null && child !== undefined) hits.push(path);
    hits.push(...keyPathsMatching(child, pattern, path));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Gateway child (gated suite only)
// ---------------------------------------------------------------------------

export function openClawEntry(): string {
  const entry = join(installedOpenClawRoot(), "openclaw.mjs");
  if (!existsSync(entry)) throw new Error(`mc155: ${entry} not found in the installed openclaw package`);
  return entry;
}

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("mc155: no free loopback port"))));
    });
  });
}

function loopbackPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface GatewayChild {
  variant: Variant;
  scratch: Scratch;
  env: Record<string, string>;
  port: number;
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start one throwaway gateway. Refuses unless the environment passes the isolation guard. */
export async function startGateway(variant: Variant): Promise<GatewayChild> {
  if (process.env.MC155_GATEWAY_ROUTE !== "1") {
    throw new Error("mc155: gateway-child helpers require MC155_GATEWAY_ROUTE=1 (CI or the remote test runner)");
  }
  const scratch = createScratch(variant.toLowerCase());
  const port = await freeLoopbackPort();
  writeWrapperPlugin(scratch);
  writeFileSync(scratch.config, JSON.stringify(buildConfig(scratch, variant, port), null, 2) + "\n");
  const env = buildChildEnv(scratch, variant);
  assertIsolated(env, scratch.root);
  const out = openSync(scratch.gatewayStdout, "a");
  const err = openSync(scratch.gatewayStderr, "a");
  const child = spawn(
    process.execPath,
    [openClawEntry(), "gateway", "--allow-unconfigured", "--port", String(port), "--bind", "loopback"],
    { cwd: scratch.work, env, stdio: ["ignore", out, err] },
  );
  closeSync(out);
  closeSync(err);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { variant, scratch, env, port, child, exit };
}

export function gatewayLogs(gateway: GatewayChild): string {
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  return `--- gateway stdout ---\n${read(gateway.scratch.gatewayStdout)}\n--- gateway stderr ---\n${read(
    gateway.scratch.gatewayStderr,
  )}`;
}

/** Run `openclaw cron <args>` against the child with the child's own environment. */
export function cron(gateway: GatewayChild, args: string[], timeoutMs = 120_000): CliResult {
  const result = spawnSync(
    process.execPath,
    [openClawEntry(), "cron", ...args, "--port", String(gateway.port), "--token", FIXTURE_GATEWAY_TOKEN],
    { cwd: gateway.scratch.work, env: gateway.env, encoding: "utf8", timeout: timeoutMs },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Wait until the gateway answers an authenticated cron RPC, or throw with its logs. */
export async function waitForGateway(gateway: GatewayChild, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void gateway.exit.then((value) => {
    exited = value;
  });
  let last: CliResult | undefined;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `mc155: gateway exited before it was ready (code ${exited.code}, signal ${exited.signal})\n${gatewayLogs(gateway)}`,
      );
    }
    if (await loopbackPortOpen(gateway.port)) {
      last = cron(gateway, ["list", "--json"], 60_000);
      if (last.status === 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `mc155: gateway not ready after ${timeoutMs} ms\n--- last cron list ---\nstatus ${last?.status}\n${last?.stdout}\n${last?.stderr}\n${gatewayLogs(gateway)}`,
  );
}

/** Ask the child to stop and wait for it. Signals only this harness's own child process. */
export async function stopGateway(gateway: GatewayChild): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  gateway.child.kill("SIGTERM");
  const stopped = await Promise.race([
    gateway.exit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!stopped) {
    gateway.child.kill("SIGKILL");
    await gateway.exit;
  }
}
