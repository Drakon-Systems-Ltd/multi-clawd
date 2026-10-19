/**
 * The agent-turn execution transport for a verified backend.
 *
 * Since 2026.10 the backend's `config.command` is the real `claude` executable
 * (see claude-command.ts), so OpenClaw can bind it as a verified setup owner.
 * Everything the shim does — rate-limit capture, the in-turn retry onto a
 * sibling account (#19), resume handover, model degradation, credential
 * bookkeeping — still has to happen on every normal turn. OpenClaw lets a
 * backend own the launch through `prepareExecution().execute`; this is that
 * transport. It runs the shim exactly as the gateway's own process runner used
 * to (one process per turn, prompt on stdin, stream-json on stdout) and pins
 * the shim to the verified executable through MULTI_CLAWD_CLAUDE_BIN.
 *
 * What the host's process runner did and this transport therefore does itself:
 * - writes the system prompt file and passes `--append-system-prompt-file`
 *   (OpenClaw stages it only for runs it spawns itself);
 * - folds the private prompt context into stdin exactly as the runner composes
 *   it for a raw stdin transport;
 * - joins the host live-session lifecycle (restart before a new process,
 *   register + activate so the MCP capture binds to this process, remove once
 *   it has exited);
 * - kills the process tree on cancellation and turns a failed exit into an
 *   error carrying the CLI's own diagnostics, so failover still classifies it.
 *
 * Fail closed: the transport only ever wraps the executable the backend was
 * registered with — the registered path itself, or the same file reached
 * through its symlinks (a host-verified invocation hands over the realpath,
 * with the registered name as argv0). The realpath is captured once and the
 * shim execs exactly that file, named by the registered path. Any other
 * command or argv0, or a leading interpreter argv, is refused rather than
 * wrapped, because wrapping it would exec a binary nobody verified.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { CLAUDE_ARGV0_ENV, CLAUDE_BIN_ENV } from "./claude-command.js";

/** Structural slice of OpenClaw's CliBackendLiveSessionHandle. */
export interface LiveSessionHandleLike {
  generation: string;
  fingerprint: string;
  isIdle(): boolean;
  close(reason: string, error?: unknown): void;
  waitForExit(): Promise<void>;
}

/** Structural slice of OpenClaw's CliBackendLiveSessionCapability (restart is 2026.10+). */
export interface LiveSessionCapabilityLike {
  fingerprint: string;
  restart?: () => Promise<void>;
  register(handle: LiveSessionHandleLike): void;
  activate(handle: LiveSessionHandleLike): void;
  remove(handle: LiveSessionHandleLike): void;
}

/**
 * Structural slice of OpenClaw's CliBackendExecuteContext. Declared here
 * because the 2026.8.1 SDK this builds against predates `argv0`,
 * `assertCurrent` and `liveSession.restart`.
 */
export interface ShimExecuteContext {
  command: string;
  argv0?: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  promptContext?: { prependContext?: string; appendContext?: string };
  systemPrompt: string;
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  liveSession?: LiveSessionCapabilityLike;
}

export interface ShimTransportOptions {
  /** The absolute claude path the backend registered as `config.command`. */
  configuredCommand: string;
  /** The stable shim copy (issue #31). */
  shimPath: string;
  /** Interpreter for the shim. Defaults to the gateway's own node. */
  nodePath?: string;
  /** Operator log line sink for the shim's own `[multi-clawd shim]` notes. */
  log?: (line: string) => void;
}

/** The first argument of every argv this backend registers (BASE_ARGS[0]). */
const EXPECTED_FIRST_ARG = "-p";
const SYSTEM_PROMPT_FILE_ARG = "--append-system-prompt-file";
const STDERR_TAIL_CHARS = 8192;
const KILL_GRACE_MS = 1000;
const EXIT_WAIT_MS = 3000;

/** OpenClaw's composeCliPromptContext: what its runner writes to a raw CLI's stdin. */
export function composePromptForStdin(
  prompt: string,
  context?: { prependContext?: string; appendContext?: string },
): string {
  const prepended = context?.prependContext ? `${context.prependContext}\n\n${prompt}` : prompt;
  return context?.appendContext ? `${prepended}\n\n${context.appendContext}` : prepended;
}

/** The exact file and invocation name the shim is told to exec. */
export interface WrappableInvocation {
  /** Absolute realpath captured once, at check time; the shim execs this file. */
  executable: string;
  /** Invocation name: the registered command path. */
  argv0: string;
}

/**
 * Refuse any invocation this transport would wrap incorrectly, and pin what
 * it will run. The command must be the registered claude executable — that
 * path itself, or (as a verifying host hands over) its realpath. Its realpath
 * is resolved HERE, once, and that absolute file is what the shim is given, so
 * nothing re-resolves a symlink between this check and the exec. argv0 may only
 * be absent or the registered path (the name OpenClaw's verifier preserves);
 * the exec always carries the registered path as argv0, as a direct launch
 * through the PATH symlink would. Leading interpreter argv is refused.
 */
export function assertWrappableInvocation(
  ctx: Pick<ShimExecuteContext, "command" | "argv0" | "args">,
  configuredCommand: string,
): WrappableInvocation {
  const registered = realpathOf(configuredCommand);
  const handed = realpathOf(ctx.command);
  if (!registered || !handed || registered !== handed) {
    throw new Error(
      `[multi-clawd] refusing to run ${ctx.command} through the shim: this backend only wraps ` +
        `its registered claude executable ${configuredCommand}`,
    );
  }
  if (ctx.args[0] !== EXPECTED_FIRST_ARG) {
    throw new Error(
      `[multi-clawd] refusing to wrap an invocation with a leading argv (${String(ctx.args[0])}): ` +
        `the shim can only exec ${configuredCommand} itself`,
    );
  }
  if (ctx.argv0 !== undefined && ctx.argv0 !== configuredCommand) {
    throw new Error(
      `[multi-clawd] refusing argv0 ${JSON.stringify(ctx.argv0)}: only the registered command ` +
        `${configuredCommand} may name the claude executable`,
    );
  }
  return { executable: handed, argv0: configuredCommand };
}

function realpathOf(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason ? reason : fallback);
}

/** Never echo a credential from the child env into an error message. */
function redact(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name)) continue;
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > STDERR_TAIL_CHARS ? next.slice(-STDERR_TAIL_CHARS) : next;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Build the `execute` transport. The returned function is an async generator
 * yielding each stream-json record exactly as the CLI (via the shim) wrote it.
 */
export function createShimExecute(options: ShimTransportOptions) {
  const nodePath = options.nodePath ?? process.execPath;
  return async function* executeThroughShim(
    ctx: ShimExecuteContext,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    const invocation = assertWrappableInvocation(ctx, options.configuredCommand);
    ctx.assertCurrent?.();
    ctx.abortSignal?.throwIfAborted();

    const capability = ctx.liveSession;
    // Process-per-turn: there is never a reusable process to keep, so a fresh
    // one is always preceded by the host's restart (which joins the previous
    // process's exit and its host-owned cleanup).
    if (capability?.restart) await capability.restart();
    ctx.assertCurrent?.();

    let child: ChildProcess | undefined;
    let exited = false;
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => (resolveExit = r));
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child || exited) return;
      signalTree(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (child && !exited) signalTree(child, "SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const handle: LiveSessionHandleLike | undefined = capability
      ? {
          generation: randomUUID(),
          fingerprint: capability.fingerprint,
          // Never reusable: idle only once the process is gone.
          isIdle: () => exited || !child,
          close: () => terminate(),
          waitForExit: () => (child ? exitPromise : Promise.resolve()),
        }
      : undefined;
    let registered = false;
    let promptDir: string | undefined;
    const onAbort = () => terminate();
    let stderrTail = "";
    let stdoutNoise = "";
    let stderrPartial = "";

    try {
      if (capability && handle) {
        // Before anything is spawned, on purpose: the host refuses here when
        // its live-session table is full (a rate_limit FailoverError about
        // OpenClaw's capacity, not the account). Nothing has run, so the shim
        // cannot record it against the account, and the host's error is
        // rethrown untouched for the host to classify as its own.
        capability.register(handle);
        registered = true;
        // Binds the turn's MCP capture to this process; the host does not do
        // it itself for a run that carries a live-session capability.
        capability.activate(handle);
      }

      const args = [...ctx.args];
      const systemPrompt = ctx.systemPrompt.trim();
      if (systemPrompt) {
        promptDir = mkdtempSync(join(tmpdir(), "multi-clawd-system-prompt-"));
        const file = join(promptDir, "system-prompt.md");
        writeFileSync(file, systemPrompt, { mode: 0o600 });
        args.push(SYSTEM_PROMPT_FILE_ARG, file);
      }

      const env: Record<string, string> = {
        ...ctx.env,
        [CLAUDE_BIN_ENV]: invocation.executable,
        [CLAUDE_ARGV0_ENV]: invocation.argv0,
      };

      ctx.assertCurrent?.();
      ctx.abortSignal?.throwIfAborted();
      const spawned = spawn(nodePath, [options.shimPath, ...args], {
        cwd: ctx.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child = spawned;
      spawned.once("error", (err) => {
        spawnError = err;
        exited = true;
        resolveExit();
      });
      spawned.once("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        exited = true;
        resolveExit();
      });
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

      spawned.stderr!.setEncoding("utf8");
      spawned.stderr!.on("data", (chunk: string) => {
        stderrTail = appendTail(stderrTail, chunk);
        if (!options.log) return;
        const text = stderrPartial + chunk;
        const lines = text.split("\n");
        stderrPartial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("[multi-clawd shim]")) options.log(line);
        }
      });

      spawned.stdin!.on("error", () => {
        // EPIPE when the CLI exits before reading its prompt; the exit status
        // carries the real failure.
      });
      spawned.stdin!.end(composePromptForStdin(ctx.prompt, ctx.promptContext));

      const lines = createInterface({ input: spawned.stdout!, crlfDelay: Infinity });
      for await (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          stdoutNoise = appendTail(stdoutNoise, `${line}\n`);
          continue;
        }
        if (!isPlainRecord(record)) {
          stdoutNoise = appendTail(stdoutNoise, `${line}\n`);
          continue;
        }
        yield record;
      }

      await exitPromise;
      if (ctx.abortSignal?.aborted) {
        throw toError(ctx.abortSignal.reason, "Claude CLI run was aborted.");
      }
      if (spawnError) {
        throw new Error(`[multi-clawd] failed to start the shim: ${spawnError.message}`);
      }
      if (exitSignal || exitCode !== 0) {
        const candidates = [stderrTail.trim(), stdoutNoise.trim()].filter(Boolean);
        const detail = candidates[0] ?? `CLI failed (${exitSignal ? `signal ${exitSignal}` : `exit ${exitCode}`}).`;
        throw new Error(redact(detail, env));
      }
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      if (child && !exited) {
        terminate();
        await Promise.race([
          exitPromise,
          new Promise<void>((r) => setTimeout(r, EXIT_WAIT_MS).unref?.()),
        ]);
      }
      if (killTimer) clearTimeout(killTimer);
      if (!child) resolveExit();
      if (registered && capability && handle) {
        try {
          capability.remove(handle);
        } catch {
          // the host already retired it
        }
      }
      if (promptDir) {
        try {
          rmSync(promptDir, { recursive: true, force: true });
        } catch {
          // temp dir; best effort
        }
      }
    }
  };
}
