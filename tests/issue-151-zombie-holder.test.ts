import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { acquireShimLock } from "../src/shim-lock";

/*
 * #151 follow-up (PR #152 B1): an exited-but-unreaped holder. A zombie keeps
 * its pid and its /proc/<pid>/stat start time until its parent reaps it, and
 * kill(pid, 0) still succeeds on it. Liveness plus a matching generation
 * therefore cannot tell a zombie from a running holder; the procfs state
 * (field 3, "Z" or "X") can. A zombie holds nothing: it can never commit the
 * snapshot it read, so its lock must be reclaimed without waiting for the reap.
 *
 * Running ("R"/"S"/"D"/"I") and stopped ("T"/"t") holders are still alive and
 * may resume and commit, so they keep the live-pid protection past the lease.
 */

const box = () => mkdtempSync(join(tmpdir(), "mc-151-zombie-"));
const LATER_MS = 60_000;

function later<T>(fn: () => T): T {
  const real = Date.now;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + LATER_MS);
  try { return fn(); } finally { spy.mockRestore(); }
}

function writeStaleLock(target: string, content: string): string {
  const lock = `${target}.lock`;
  writeFileSync(lock, content);
  const old = new Date(Date.now() - LATER_MS);
  utimesSync(lock, old, old);
  return lock;
}

afterEach(() => { vi.restoreAllMocks(); });

/* ------------------------------------------------------------------------ */
/* Real processes on Linux                                                   */
/* ------------------------------------------------------------------------ */

const realProc = process.platform === "linux" && existsSync("/proc/self/stat") && existsSync("/bin/sh");

/** Fields 3.. of /proc/<pid>/stat (state first, starttime at index 19), or undefined if unreadable. */
function procFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  } catch { return undefined; }
}
const procState = (pid: number) => procFields(pid)?.[0];
const procStart = (pid: number) => procFields(pid)?.[19];

/** Poll until pid's procfs state matches, bounded so a broken environment fails instead of hanging. */
async function waitForState(pid: number, want: RegExp, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = procState(pid);
    if (last !== undefined && want.test(last)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pid ${pid} never reached state ${want} (last ${String(last)})`);
}

/** The first stdout line of child, bounded. */
function firstLine(child: ChildProcess, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("no output from helper process")); }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { cleanup(); resolve(buf.slice(0, nl).trim()); }
    };
    const onExit = () => { cleanup(); reject(new Error("helper process exited before reporting a pid")); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/** SIGKILL child (works on stopped processes too) and wait, bounded, for Node to reap it. */
async function killAndReap(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!child) return;
  child.stdout?.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

/**
 * A real zombie. Node reaps its own children itself, so the zombie is a
 * grandchild: sh backgrounds a short sleep, prints its pid, then execs into a
 * long sleep that never calls wait(). Once the short sleep exits it stays a
 * zombie until the long sleep dies; killing that (in cleanup) reparents the
 * zombie to init or the nearest subreaper, which reaps it. The zombie pid
 * itself is never signalled.
 */
async function spawnZombie(): Promise<{ parent: ChildProcess; pid: number }> {
  const parent = spawn("/bin/sh", ["-c", "sleep 1 & echo $!; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const pid = Number(await firstLine(parent));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`bad zombie pid ${pid}`);
    await waitForState(pid, /^Z$/);
    return { parent, pid };
  } catch (err) {
    await killAndReap(parent);
    throw err;
  }
}

/** A real running holder: a plain long sleep spawned (and later reaped) by Node. */
async function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    if (child.pid === undefined) throw new Error("sleep did not start");
    await waitForState(child.pid, /^[RSD]$/);
    return child;
  } catch (err) {
    await killAndReap(child);
    throw err;
  }
}

describe.runIf(realProc)("a real exited-but-unreaped holder (Linux /proc state Z)", () => {
  let zombie: { parent: ChildProcess; pid: number } | undefined;

  beforeAll(async () => { zombie = await spawnZombie(); }, 15_000);
  afterAll(async () => { await killAndReap(zombie?.parent); zombie = undefined; }, 15_000);

  /** The preconditions that make this a real regression, rechecked per test. */
  function zombiePreconditions(): { pid: number; generation: string } {
    expect(zombie).toBeDefined();
    const pid = zombie!.pid;
    expect(procState(pid)).toBe("Z");
    expect(() => process.kill(pid, 0)).not.toThrow();
    const generation = procStart(pid);
    expect(generation).toMatch(/^\d+$/);
    return { pid, generation: generation! };
  }

  test("a stale lock held by a zombie with a matching starttime is reclaimed before the zombie is reaped", () => {
    const { pid, generation } = zombiePreconditions();
    const target = join(box(), "home.json");
    const held = `${pid} ${Date.now() - LATER_MS} zombie-token ${generation}\n`;
    const lock = writeStaleLock(target, held);

    const release = acquireShimLock(target, 50);
    expect(release).toBeTypeOf("function");
    const now = readFileSync(lock, "utf8");
    expect(now).not.toBe(held);
    expect(now.startsWith(`${process.pid} `)).toBe(true);

    // Still unreaped: the reclaim did not depend on the holder disappearing.
    expect(procState(pid)).toBe("Z");
    expect(procStart(pid)).toBe(generation);
    release?.();
    expect(existsSync(lock)).toBe(false);
  });

  test("a fresh lock held by a zombie with a matching starttime is reclaimed at once, like a dead pid", () => {
    const { pid, generation } = zombiePreconditions();
    const target = join(box(), "home.json");
    const held = `${pid} ${Date.now()} zombie-token ${generation}\n`;
    const lock = `${target}.lock`;
    writeFileSync(lock, held);

    const release = acquireShimLock(target, 50);
    expect(release).toBeTypeOf("function");
    expect(readFileSync(lock, "utf8").startsWith(`${process.pid} `)).toBe(true);
    expect(procState(pid)).toBe("Z");
    release?.();
    expect(existsSync(lock)).toBe(false);
  });
});

describe.runIf(realProc)("real live and stopped holders with a matching starttime stay protected past the lease", () => {
  test("a running holder (state R/S/D) is never reclaimed by age", async () => {
    let child: ChildProcess | undefined;
    try {
      child = await spawnSleeper();
      const pid = child.pid!;
      const generation = procStart(pid);
      expect(generation).toMatch(/^\d+$/);
      const target = join(box(), "home.json");
      const held = `${pid} ${Date.now() - LATER_MS} live-token ${generation}\n`;
      const lock = writeStaleLock(target, held);

      expect(acquireShimLock(target, 20)).toBeUndefined();
      expect(later(() => acquireShimLock(target, 20))).toBeUndefined();
      expect(readFileSync(lock, "utf8")).toBe(held);
      expect(procState(pid)).toMatch(/^[RSD]$/);
    } finally {
      await killAndReap(child);
    }
  }, 15_000);

  test("a stopped holder (SIGSTOP, state T) is never reclaimed by age", async () => {
    let child: ChildProcess | undefined;
    try {
      child = await spawnSleeper();
      const pid = child.pid!;
      process.kill(pid, "SIGSTOP");
      await waitForState(pid, /^[Tt]$/);
      const generation = procStart(pid);
      expect(generation).toMatch(/^\d+$/);
      const target = join(box(), "home.json");
      const held = `${pid} ${Date.now() - LATER_MS} stopped-token ${generation}\n`;
      const lock = writeStaleLock(target, held);

      expect(acquireShimLock(target, 20)).toBeUndefined();
      expect(later(() => acquireShimLock(target, 20))).toBeUndefined();
      expect(readFileSync(lock, "utf8")).toBe(held);
      expect(procState(pid)).toMatch(/^[Tt]$/);
    } finally {
      await killAndReap(child);
    }
  }, 15_000);
});

/* ------------------------------------------------------------------------ */
/* Fake procfs: state field handling, conservative on anything else         */
/* ------------------------------------------------------------------------ */

const OWN_GEN = "424242";
const HOLDER_GEN = "777";

/** A /proc/<pid>/stat line with the given state and starttime and distinct values elsewhere. */
function statLine(pid: number, comm: string, state: string, starttime: string): string {
  const middle = ["1", "7003", "7004", "0", "-1", "4194560", "1010", "1011", "1012", "1013", "1014", "1015", "1016", "1017", "20", "0", "9", "0"];
  return `${pid} (${comm}) ${state} ${middle.join(" ")} ${starttime} 123456789 4321 18446744073709551615\n`;
}

/**
 * A fake procfs holding this writer's own entry and, for pid 1 (kill(1, 0)
 * reports it live via success or EPERM), `holderStat` when given.
 */
function fakeProc(holderStat?: string): string {
  const root = join(box(), "proc");
  const put = (name: string, line: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "stat"), line);
  };
  put("self", statLine(process.pid, "node", "R", OWN_GEN));
  put(String(process.pid), statLine(process.pid, "node", "R", OWN_GEN));
  if (holderStat !== undefined) put("1", holderStat);
  return root;
}

describe("procfs state of a kill-confirmed live holder with a matching generation (fake procfs)", () => {
  test.each([
    ["Z (zombie)", "Z"],
    ["X (dead)", "X"],
  ])("state %s: the stale lock is reclaimed", (_label, state) => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc(statLine(1, "holder", state, HOLDER_GEN));
    const lock = writeStaleLock(target, `1 ${Date.now() - LATER_MS} tok ${HOLDER_GEN}\n`);

    const release = acquireShimLock(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    expect(readFileSync(lock, "utf8").startsWith(`${process.pid} `)).toBe(true);
    release?.();
    expect(existsSync(lock)).toBe(false);
  });

  test.each([
    ["R (running)", "R"],
    ["S (sleeping)", "S"],
    ["D (disk sleep)", "D"],
    ["I (idle)", "I"],
    ["T (stopped)", "T"],
    ["t (tracing stop)", "t"],
  ])("state %s: protected past the lease", (_label, state) => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc(statLine(1, "holder", state, HOLDER_GEN));
    const held = `1 ${Date.now() - LATER_MS} tok ${HOLDER_GEN}\n`;
    const lock = writeStaleLock(target, held);

    expect(acquireShimLock(target, 20, { procRoot })).toBeUndefined();
    expect(later(() => acquireShimLock(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a comm carrying a decoy ') Z' does not make a sleeping holder look like a zombie", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc(statLine(1, "evil) Z (x", "S", HOLDER_GEN));
    const held = `1 ${Date.now() - LATER_MS} tok ${HOLDER_GEN}\n`;
    const lock = writeStaleLock(target, held);

    expect(later(() => acquireShimLock(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("an unreadable holder stat (no procfs entry) stays protected past the lease", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const held = `1 ${Date.now() - LATER_MS} tok ${HOLDER_GEN}\n`;
    const lock = writeStaleLock(target, held);

    expect(later(() => acquireShimLock(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test.each(["Z", "X"])("a holder stat truncated at ') %s' without field 22 stays protected past the lease", (state) => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc(`1 (holder) ${state}`);
    const held = `1 ${Date.now() - LATER_MS} tok ${HOLDER_GEN}\n`;
    const lock = writeStaleLock(target, held);

    expect(acquireShimLock(target, 20, { procRoot })).toBeUndefined();
    expect(later(() => acquireShimLock(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });
});

describe("a partially written lock never reads as a reused pid", () => {
  test("a fresh lock for this live writer with a truncated generation and no newline is protected", () => {
    // A waiter can read the lock between the holder's create and its single
    // write completing. "4242" is a prefix of the holder's real "424242";
    // comparing it would wrongly report a reused pid and reclaim a live lock.
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const partial = `${process.pid} ${Date.now()} tok ${OWN_GEN.slice(0, 4)}`;
    const lock = `${target}.lock`;
    writeFileSync(lock, partial);

    expect(acquireShimLock(target, 20, { procRoot })).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(partial);
  });
});
