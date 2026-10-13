/**
 * Verified launch (OpenClaw 2026.10): the backend's command is the real claude
 * executable so the host can bind it as a setup owner, side-question turns run
 * it directly, and agent turns still run through the shim via the execute
 * transport. Every behaviour the shim provides must survive that transport.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanShimEnv } from "./shim-env";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { buildBackend, registerPoolBackend, resolveBackendLaunch, hostRunsExecuteTransports, CLAUDE_RUNTIME_ARTIFACT } =
  await import("../src/index.js");
const { resolveClaudeExecutable, findOnPath } = await import("../src/claude-command.js");
const { createShimExecute, assertWrappableInvocation, composePromptForStdin } = await import(
  "../src/shim-transport.js"
);
const { RETRY_ROSTER_ENV } = await import("../src/retry-plan.js");
const { SESSION_DIRS_ENV } = await import("../src/session-handover.js");
const { recordModelLimit } = await import("../src/shim-core.js");

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  expect(existsSync(SHIM)).toBe(true);
});

let scratch: string;
beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-verified-home-"));
  scratch = mkdtempSync(join(tmpdir(), "mc-verified-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function writeExecutable(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** An executable `claude` that runs the fake CLI and marks that it was exec'd. */
function fakeClaudeBinary(dir = join(scratch, "bin")): string {
  return writeExecutable(
    join(dir, "claude"),
    `#!/bin/sh\nFAKE_VIA_WRAPPER=1 exec "${process.execPath}" "${FAKE}" "$@"\n`,
  );
}

function liveSessionRecorder(fingerprint = "fp-1") {
  const calls: string[] = [];
  let handle: { isIdle(): boolean; fingerprint: string; generation: string } | undefined;
  return {
    calls,
    get handle() {
      return handle;
    },
    capability: {
      fingerprint,
      restart: async () => {
        calls.push("restart");
      },
      register: (h: typeof handle) => {
        handle = h;
        calls.push("register");
      },
      activate: () => {
        calls.push("activate");
      },
      remove: () => {
        calls.push(`remove:${handle?.isIdle() ? "idle" : "busy"}`);
      },
    },
  };
}

async function collect(iter: AsyncIterable<Record<string, unknown>>) {
  const out: Record<string, unknown>[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

describe("resolving the claude executable", () => {
  test("keeps the PATH-visible symlink, not the versioned binary it points at", () => {
    const real = writeExecutable(join(scratch, "versions", "2.1.0"), "#!/bin/sh\n");
    mkdirSync(join(scratch, "bin"));
    symlinkSync(real, join(scratch, "bin", "claude"));
    const r = resolveClaudeExecutable({ PATH: `relative/dir:${join(scratch, "bin")}` }, "darwin");
    expect(r).toEqual({ ok: true, command: join(scratch, "bin", "claude"), source: "path" });
  });

  test("skips relative PATH entries", () => {
    writeExecutable(join(scratch, "rel", "claude"), "#!/bin/sh\n");
    expect(findOnPath("claude", "rel")).toBeUndefined();
  });

  test("an operator override wins, and an unusable one is unresolvable", () => {
    const bin = fakeClaudeBinary();
    expect(resolveClaudeExecutable({ MULTI_CLAWD_CLAUDE_BIN: bin, PATH: "" }, "linux")).toMatchObject({
      ok: true,
      command: bin,
      source: "override",
    });
    expect(
      resolveClaudeExecutable({ MULTI_CLAWD_CLAUDE_BIN: join(scratch, "missing"), PATH: "" }, "linux").ok,
    ).toBe(false);
    expect(
      resolveClaudeExecutable(
        { MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]), PATH: "" },
        "linux",
      ).ok,
    ).toBe(false);
  });

  test("nothing on PATH, or Windows, is unresolvable", () => {
    expect(resolveClaudeExecutable({ PATH: scratch }, "darwin").ok).toBe(false);
    fakeClaudeBinary();
    expect(resolveClaudeExecutable({ PATH: join(scratch, "bin") }, "win32").ok).toBe(false);
  });
});

describe("launch mode at registration", () => {
  test("resolves claude and declares the bundled backend's runtime artifact", async () => {
    const bin = fakeClaudeBinary();
    const launch = resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: join(scratch, "bin") }, platform: "darwin", shimPath: SHIM });
    expect(launch).toMatchObject({ kind: "verified", claudeCommand: bin });
    const backend = buildBackend({ id: "claw1", native: true }, "full", launch);
    expect(backend.config.command).toBe(bin);
    expect(backend.config.args?.[0]).toBe("-p");
    expect(backend.config.args).not.toContain(SHIM);
    expect(backend.config.resumeArgs).not.toContain(SHIM);
    expect(backend.config.resumeArgs).toEqual(expect.arrayContaining(["--resume", "{sessionId}"]));
    expect(backend.runtimeArtifact).toEqual(CLAUDE_RUNTIME_ARTIFACT);
    expect(backend.runtimeArtifact?.nativeExecutableNames).not.toContain("node");
    expect(backend.runtimeArtifact?.exactToolAvailabilityVersionPolicy).toBeUndefined();
    expect(backend.runtimeArtifact?.packageName).toBe("@anthropic-ai/claude-code");

    // Byte-for-byte the bundled claude-cli declaration.
    const require = createRequire(import.meta.url);
    const upstream = (await import(
      pathToFileURL(join(dirname(require.resolve("openclaw")), "extensions", "anthropic", "cli-backend.js")).href
    )) as { buildAnthropicCliBackend: () => { runtimeArtifact?: unknown } };
    expect(backend.runtimeArtifact).toEqual(upstream.buildAnthropicCliBackend().runtimeArtifact);
  });

  test("falls back to today's exact node+shim launch when claude is unresolvable", () => {
    const launch = resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: scratch }, platform: "darwin", shimPath: SHIM });
    expect(launch.kind).toBe("legacy");
    const backend = buildBackend({ id: "claw1", native: true }, "full", launch);
    expect(backend.config.command).toBe(process.execPath);
    expect(backend.config.args?.[0]).toBe(SHIM);
    expect(backend.config.resumeArgs?.[0]).toBe(SHIM);
    expect(backend.runtimeArtifact).toBeUndefined();
  });

  test("a host without the execute transport keeps the legacy launch", () => {
    fakeClaudeBinary();
    const env = { PATH: join(scratch, "bin") };
    expect(resolveBackendLaunch({ hostSupportsExecute: false, env, platform: "darwin" })).toMatchObject({
      kind: "legacy",
      reason: expect.stringContaining("execute transports"),
    });
    expect(resolveBackendLaunch({ hostSupportsExecute: true, env, platform: "darwin" }).kind).toBe("verified");
  });

  test("the execute capability is probed positively, never inferred from a missing version", () => {
    const fn = () => {};
    // 2026.8.1+ runtime shapes.
    expect(hostRunsExecuteTransports({ agent: { runCommandFromIngress: fn } })).toBe(true);
    expect(hostRunsExecuteTransports({ hooks: { dispatchHookAgentTurn: fn } })).toBe(true);
    // Pre-2026.8.1 shapes (no probe surface), version or not.
    expect(hostRunsExecuteTransports({ version: "2026.10.2", agent: {}, hooks: {} })).toBe(false);
    expect(hostRunsExecuteTransports({ config: { current: () => ({}) } })).toBe(false);
    expect(hostRunsExecuteTransports(undefined)).toBe(false);
    // Metadata-mode runtime: a Proxy that throws on any read.
    const throwing = new Proxy({}, { get() { throw new Error("runtime unavailable"); } });
    expect(hostRunsExecuteTransports(throwing)).toBe(false);
  });

  test("registration probes the real runtime and picks the verified launch", async () => {
    const bin = fakeClaudeBinary();
    const { default: plugin } = await import("../src/index.js");
    const backends: Array<{ id: string; config: { command: string }; runtimeArtifact?: unknown }> = [];
    const saved = { PATH: process.env.PATH, BIN: process.env.MULTI_CLAWD_CLAUDE_BIN };
    process.env.PATH = join(scratch, "bin");
    delete process.env.MULTI_CLAWD_CLAUDE_BIN;
    const config = { plugins: { entries: { "multi-clawd": { config: { accounts: [{ id: "claw1", native: true }] } } } } };
    try {
      plugin.register({
        config: {},
        pluginConfig: {},
        runtime: { config: { current: () => config }, agent: { runCommandFromIngress: () => {} } },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        registerCliBackend: (b: (typeof backends)[number]) => backends.push(b),
        registerProvider: () => {},
        on: () => {},
      } as never);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.BIN !== undefined) process.env.MULTI_CLAWD_CLAUDE_BIN = saved.BIN;
    }
    expect(backends[0]?.config.command).toBe(bin);
    expect(backends[0]?.runtimeArtifact).toEqual(CLAUDE_RUNTIME_ARTIFACT);
  });

  test("a legacy backend never returns a transport, even for agent turns", async () => {
    const backend = buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" });
    const prepared = await backend.prepareExecution!({
      workspaceDir: "/tmp", provider: "claw1", modelId: "claude-fable-5", executionMode: "agent",
    });
    expect(prepared?.execute).toBeUndefined();
    expect(prepared?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claw1-login");
  });
});

describe("prepareExecution on a verified backend", () => {
  function verifiedLaunch() {
    const bin = fakeClaudeBinary();
    return resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: join(scratch, "bin") }, platform: "darwin", shimPath: SHIM });
  }

  test("side-question turns get no transport, but do get the account's env", async () => {
    const backend = buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" }, undefined, verifiedLaunch());
    const prepared = await backend.prepareExecution!({
      workspaceDir: "/tmp", provider: "claw1", modelId: "claude-fable-5", executionMode: "side-question",
    });
    expect(prepared?.execute).toBeUndefined();
    expect(prepared?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claw1-login");
  });

  test("agent turns get the shim transport", async () => {
    const backend = buildBackend({ id: "claw1", configDir: "/tmp/claw1-login" }, undefined, verifiedLaunch());
    const prepared = await backend.prepareExecution!({
      workspaceDir: "/tmp", provider: "claw1", modelId: "claude-fable-5", executionMode: "agent",
    });
    expect(typeof prepared?.execute).toBe("function");
  });

  test("pool side-questions launch on the pool-chosen account, without the shim's steering env", async () => {
    let pool: { prepareExecution?: (ctx: unknown) => Promise<{ env: Record<string, string>; execute?: unknown }> } | undefined;
    const api = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerCliBackend: (b: { id?: string }) => {
        if (b.id === "clawd") pool = b as typeof pool;
      },
      registerProvider: () => {},
    } as never;
    // Home is rejected: the pool must choose claw2 before launch.
    const stateDir = join(home.dir, ".openclaw", "state", "multi-clawd");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "claw1.json"),
      JSON.stringify({ accountId: "claw1", updatedAt: Date.now(), windows: { five_hour: { status: "rejected", seenAt: Date.now() } } }),
    );
    registerPoolBackend(
      api,
      { id: "clawd", accounts: ["claw1", "claw2"] },
      [
        { id: "claw1", configDir: "/tmp/claw1-login" },
        { id: "claw2", configDir: "/tmp/claw2-login" },
      ],
      new Set(["claw1", "claw2"]),
      undefined,
      { launch: verifiedLaunch() },
    );
    const side = await pool!.prepareExecution!({
      workspaceDir: "/tmp", provider: "clawd", modelId: "claude-fable-5", executionMode: "side-question",
    });
    expect(side.execute).toBeUndefined();
    expect(side.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claw2-login");
    expect(side.env[RETRY_ROSTER_ENV]).toBeUndefined();
    expect(side.env[SESSION_DIRS_ENV]).toBeUndefined();

    const agent = await pool!.prepareExecution!({
      workspaceDir: "/tmp", provider: "clawd", modelId: "claude-fable-5", executionMode: "agent",
    });
    expect(typeof agent.execute).toBe("function");
    expect(agent.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claw2-login");
    expect(agent.env[RETRY_ROSTER_ENV]).toBeDefined();
  });
});

describe("pool side-questions and model limits", () => {
  const MODEL = "claude-opus-5";
  function limitFor(accountId: string, model = MODEL) {
    const stateDir = join(home.dir, ".openclaw", "state", "multi-clawd");
    mkdirSync(stateDir, { recursive: true });
    const state = recordModelLimit({ accountId, windows: {} }, model, Date.now(), Math.floor(Date.now() / 1000) + 86_400);
    writeFileSync(join(stateDir, `${accountId}.json`), JSON.stringify(state));
  }
  function registerVerifiedPool(pool: Record<string, unknown> = {}) {
    let backend: { prepareExecution?: (ctx: unknown) => Promise<{ env: Record<string, string>; execute?: unknown }> } | undefined;
    const warn: string[] = [];
    const api = {
      logger: { info: () => {}, warn: (m: string) => warn.push(m), error: () => {} },
      registerCliBackend: (b: { id?: string }) => {
        if (b.id === "clawd") backend = b as typeof backend;
      },
      registerProvider: () => {},
    } as never;
    fakeClaudeBinary();
    registerPoolBackend(
      api,
      { id: "clawd", accounts: ["claw1", "claw2"], ...pool },
      [
        { id: "claw1", configDir: "/tmp/claw1-login" },
        { id: "claw2", configDir: "/tmp/claw2-login" },
      ],
      new Set(["claw1", "claw2"]),
      undefined,
      { launch: resolveBackendLaunch({ hostSupportsExecute: true, env: { PATH: join(scratch, "bin") }, platform: "darwin", shimPath: SHIM }) },
    );
    const prepare = (executionMode: string) =>
      backend!.prepareExecution!({ workspaceDir: "/tmp/ws", provider: "clawd", modelId: MODEL, executionMode });
    return { prepare, warn };
  }

  test("a side-question never launches on an account limited for its model while another is not", async () => {
    limitFor("claw1");
    const { prepare } = registerVerifiedPool();
    const side = await prepare("side-question");
    expect(side.execute).toBeUndefined();
    expect(side.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claw2-login");
  });

  test("a wholly limited pool: agent turns degrade via the shim; side-questions say they cannot", async () => {
    limitFor("claw1");
    limitFor("claw2");
    const { prepare, warn } = registerVerifiedPool({ degrade: { ladder: ["claude-sonnet-5"] } });
    const agent = await prepare("agent");
    expect(agent.env.MULTI_CLAWD_MODEL_OVERRIDE).toBe("claude-sonnet-5");
    const side = await prepare("side-question");
    expect(side.env.MULTI_CLAWD_MODEL_OVERRIDE).toBeUndefined();
    expect(warn.some((w) => w.includes("side-question runs claude-opus-5 undegraded"))).toBe(true);
  });
});

describe("the shim execute transport", () => {
  function baseCtx(command: string, env: Record<string, string>, extra: Record<string, unknown> = {}) {
    return {
      command,
      args: [...STREAM_ARGS],
      cwd: scratch,
      env: { ...(cleanShimEnv() as Record<string, string>), FAKE_CLAUDE_EXIT: "0", ...env },
      prompt: "the prompt",
      systemPrompt: "",
      ...extra,
    };
  }

  test("spawns the shim pinned to the verified claude and yields its records", async () => {
    const bin = fakeClaudeBinary();
    const live = liveSessionRecorder();
    const exec = createShimExecute({ configuredCommand: bin, shimPath: SHIM });
    const records = await collect(
      exec(
        baseCtx(bin, { FAKE_CLAUDE_REPORT_ARGV: "1", PATH: scratch }, {
          systemPrompt: "  You are helpful.  ",
          liveSession: live.capability,
        }),
      ),
    );
    const result = records.find((r) => r.type === "result")!;
    expect(records[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(records.some((r) => r.type === "rate_limit_event")).toBe(true);
    // The wrapper at the configured path ran, though no claude is on PATH.
    expect(result.via_wrapper).toBe("1");
    expect(result.saw_claude_bin_env).toBe(false);
    expect(result.result).toBe("the prompt");
    expect(result.system_prompt).toBe("You are helpful.");
    expect(result.argv).toEqual(expect.arrayContaining(STREAM_ARGS));
    // Process-per-turn lifecycle: restart, bind, and retire only once exited.
    expect(live.calls).toEqual(["restart", "register", "activate", "remove:idle"]);
    expect(live.handle?.fingerprint).toBe("fp-1");
  });

  test("the prompt context reaches stdin as the host's runner composes it", () => {
    expect(composePromptForStdin("P", { prependContext: "A", appendContext: "Z" })).toBe("A\n\nP\n\nZ");
    expect(composePromptForStdin("P")).toBe("P");
  });

  test("in-turn failover onto a sibling still works through the transport", async () => {
    const bin = fakeClaudeBinary();
    const claw1State = join(scratch, "claw1.json");
    const claw2State = join(scratch, "claw2.json");
    const exec = createShimExecute({ configuredCommand: bin, shimPath: SHIM });
    const records = await collect(
      exec(
        baseCtx(bin, {
          MULTI_CLAWD_ACCOUNT_ID: "claw1",
          MULTI_CLAWD_STATE_FILE: claw1State,
          FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
          [RETRY_ROSTER_ENV]: JSON.stringify([
            { id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-two" } },
          ]),
        }),
      ),
    );
    expect(JSON.stringify(records)).not.toContain("reached your");
    const result = records.find((r) => r.type === "result")!;
    expect(result.served_by).toBe("claw2");
    expect(result.config_dir).toBe("/tmp/claude-two");
    expect(result.result).toBe("the prompt");
    // Rate-limit capture still lands in the account's health file.
    expect(JSON.parse(readFileSync(claw1State, "utf8")).accountId).toBe("claw1");
  });

  test("a failed exit throws the CLI's own diagnostics", async () => {
    const bin = fakeClaudeBinary();
    const exec = createShimExecute({ configuredCommand: bin, shimPath: SHIM });
    const ctx = baseCtx(bin, { FAKE_CLAUDE_EMULATE_RESUME: "1", CLAUDE_CONFIG_DIR: scratch });
    ctx.args = [...STREAM_ARGS, "--resume", "missing-session"];
    await expect(collect(exec(ctx))).rejects.toThrow(/No conversation found/);
  });

  test("refuses a command other than the registered one, without spawning", async () => {
    const bin = fakeClaudeBinary();
    const other = writeExecutable(join(scratch, "versions", "2.1.0"), "#!/bin/sh\n");
    const live = liveSessionRecorder();
    const exec = createShimExecute({ configuredCommand: bin, shimPath: SHIM });
    await expect(collect(exec(baseCtx(other, {}, { liveSession: live.capability })))).rejects.toThrow(
      /only wraps its registered claude executable/,
    );
    expect(live.calls).toEqual([]);
  });

  test("accepts a host-verified invocation: the realpath of the registered symlink, argv0 = the symlink", async () => {
    const real = writeExecutable(
      join(scratch, "versions", "2.1.0"),
      `#!/bin/sh\nFAKE_VIA_WRAPPER=1 exec "${process.execPath}" "${FAKE}" "$@"\n`,
    );
    mkdirSync(join(scratch, "bin"));
    const link = join(scratch, "bin", "claude");
    symlinkSync(real, link);
    const exec = createShimExecute({ configuredCommand: link, shimPath: SHIM });
    const records = await collect(
      exec({ ...baseCtx(realpathSync(link), { PATH: scratch, FAKE_CLAUDE_REPORT_ARGV: "1" }), argv0: link }),
    );
    const result = records.find((r) => r.type === "result")!;
    expect(result.via_wrapper).toBe("1");
    expect(result.result).toBe("the prompt");
    // Still refuses a leading argv on the verified path.
    expect(() =>
      assertWrappableInvocation({ command: realpathSync(link), argv0: link, args: ["/x/cli.js", "-p"] }, link),
    ).toThrow(/leading argv/);
    // And a different file is still a different file.
    const other = writeExecutable(join(scratch, "versions", "9.9.9"), "#!/bin/sh\n");
    expect(() => assertWrappableInvocation({ command: other, args: ["-p"] }, link)).toThrow(/only wraps/);
    expect(() => assertWrappableInvocation({ command: join(scratch, "gone"), args: ["-p"] }, link)).toThrow(/only wraps/);
  });

  test("refuses a leading interpreter argv it would otherwise wrap", () => {
    expect(() =>
      assertWrappableInvocation({ command: "/x/claude", args: ["/x/cli.js", "-p"] }, "/x/claude"),
    ).toThrow(/leading argv/);
    expect(() => assertWrappableInvocation({ command: "/x/claude", args: ["-p"] }, "/x/claude")).not.toThrow();
  });

  test("passes argv0 to the shim and never inherits a stale one", async () => {
    const bin = fakeClaudeBinary();
    // A stand-in shim that reports what it was handed.
    const probe = writeExecutable(
      join(scratch, "probe-shim.mjs"),
      `process.stdout.write(JSON.stringify({type:"result",bin:process.env.MULTI_CLAWD_CLAUDE_BIN??null,argv0:process.env.MULTI_CLAWD_CLAUDE_ARGV0??null})+"\\n");\n`,
    );
    const exec = createShimExecute({ configuredCommand: bin, shimPath: probe });
    const withArgv0 = await collect(exec({ ...baseCtx(bin, {}), argv0: "/home/u/.local/bin/claude" }));
    expect(withArgv0[0]).toMatchObject({ bin, argv0: "/home/u/.local/bin/claude" });
    const without = await collect(exec(baseCtx(bin, { MULTI_CLAWD_CLAUDE_ARGV0: "/stale" })));
    expect(without[0]).toMatchObject({ bin, argv0: null });
  });

  test("a host live-session capacity refusal is never attributed to the launched account", async () => {
    const bin = fakeClaudeBinary();
    const marker = join(scratch, "shim-ran");
    const probe = writeExecutable(
      join(scratch, "marker-shim.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    // OpenClaw's ensureCliLiveSessionCapacity: a FailoverError, reason rate_limit.
    const capacity = Object.assign(new Error("Too many CLI live sessions are active."), {
      name: "FailoverError",
      reason: "rate_limit",
    });
    const calls: string[] = [];
    const capability = {
      fingerprint: "fp",
      restart: async () => void calls.push("restart"),
      register: () => {
        calls.push("register");
        throw capacity;
      },
      activate: () => void calls.push("activate"),
      remove: () => void calls.push("remove"),
    };
    const stateFile = join(scratch, "claw1.json");
    const exec = createShimExecute({ configuredCommand: bin, shimPath: probe });
    const err = await collect(
      exec(baseCtx(bin, { MULTI_CLAWD_ACCOUNT_ID: "claw1", MULTI_CLAWD_STATE_FILE: stateFile }, { liveSession: capability })),
    ).catch((e: unknown) => e);
    // The host's own error, untouched, so the host classifies it as its own.
    expect(err).toBe(capacity);
    expect(calls).toEqual(["restart", "register"]);
    // Nothing launched, so nothing could record a limit against claw1.
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  test("cancellation kills the process and ends the turn", async () => {
    const sleeper = writeExecutable(join(scratch, "bin", "claude"), "#!/bin/sh\nsleep 30\n");
    const live = liveSessionRecorder();
    const exec = createShimExecute({ configuredCommand: sleeper, shimPath: SHIM });
    const controller = new AbortController();
    const started = Date.now();
    const run = collect(exec(baseCtx(sleeper, {}, { abortSignal: controller.signal, liveSession: live.capability })));
    setTimeout(() => controller.abort(new Error("cancelled by test")), 300);
    await expect(run).rejects.toThrow(/cancelled by test/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(live.calls.at(-1)).toBe("remove:idle");
  });
});

describe("the shim fails closed on MULTI_CLAWD_CLAUDE_BIN", () => {
  test("a set-but-unusable binary is refused even when a claude is on PATH", () => {
    fakeClaudeBinary();
    const res = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], {
      input: "hi\n",
      encoding: "utf8",
      env: cleanShimEnv({
        PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}`,
        MULTI_CLAWD_CLAUDE_BIN: join(scratch, "not-there"),
      }),
    });
    expect(res.status).toBe(127);
    expect(res.stderr).toContain("refusing to launch claude");
    expect(res.stdout).toBe("");
  });

  test("argv0 without a binary is refused", () => {
    const res = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], {
      input: "hi\n",
      encoding: "utf8",
      env: cleanShimEnv({ MULTI_CLAWD_CLAUDE_ARGV0: "/x/claude" }),
    });
    expect(res.status).toBe(127);
  });
});
