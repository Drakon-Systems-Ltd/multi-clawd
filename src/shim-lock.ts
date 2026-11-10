/** Short, best-effort cross-process guard for shim state and retry decisions. */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const WAIT_MS = 150;
const LEASE_MS = 5_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Test seam for the replacement interleaving and close failure. */
interface ShimLockTestHooks {
  beforeStaleSnapshot?: () => void;
  beforeStaleUnlink?: () => void;
  close?: (fd: number) => void;
  /** procfs root for generation checks; defaults to /proc on Linux only. */
  procRoot?: string;
}

/**
 * Fields 3 (state) and 22 (starttime) of a Linux /proc/<pid>/stat line.
 * comm (field 2) may hold spaces and parentheses, so fields are counted from
 * the last ")" in the line; the kernel prints nothing after comm that holds one.
 */
function parseProcStat(stat: string): { state?: string; start?: string } {
  const close = stat.lastIndexOf(")");
  if (close < 0) return {};
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  return {
    state: state !== undefined && /^[A-Za-z]$/.test(state) ? state : undefined,
    start: start !== undefined && /^\d+$/.test(start) ? start : undefined,
  };
}

/** Field 22 (starttime) of a Linux /proc/<pid>/stat line, as a decimal string. */
export function parseProcStatStartTime(stat: string): string | undefined {
  return parseProcStat(stat).start;
}

/** State and start time of pid as procfs reports them; fields are undefined when unknowable. */
function readProcStat(procRoot: string | undefined, pid: number | "self"): { state?: string; start?: string } {
  if (procRoot === undefined) return {};
  try { return parseProcStat(readFileSync(join(procRoot, String(pid), "stat"), "utf8")); } catch { return {}; }
}

/** The start time of pid as procfs reports it, or undefined when unknowable. */
function readGeneration(procRoot: string | undefined, pid: number | "self"): string | undefined {
  return readProcStat(procRoot, pid).start;
}

/**
 * This process's generation, recorded only when <root>/self and <root>/<pid>
 * agree: a procfs from another pid namespace would make waiters compare the
 * recorded value against an unrelated process and wrongly reclaim the lock.
 */
const ownGenerations = new Map<string, string>();
function ownGeneration(procRoot: string | undefined): string | undefined {
  if (procRoot === undefined) return undefined;
  const cached = ownGenerations.get(procRoot);
  if (cached !== undefined) return cached;
  const self = readGeneration(procRoot, "self");
  if (self === undefined || self !== readGeneration(procRoot, process.pid)) return undefined;
  ownGenerations.set(procRoot, self);
  return self;
}

/** Where the lock for `file` lives. Its bytes name the current holder. */
export function shimLockFile(file: string): string {
  return `${file}.lock`;
}

/**
 * Releases the lock. `held()` says whether the lock file is still the one
 * this acquisition created: same inode, same bytes. Live holders are not
 * reclaimed by age, but external replacement can still remove ownership.
 */
export type ShimLockRelease = (() => void) & { held: () => boolean };

/** Undefined means fail open: callers must avoid replacing protected snapshots. */
export function acquireShimLock(file: string, waitMs = WAIT_MS, hooks: ShimLockTestHooks = {}): ShimLockRelease | undefined {
  if (!file || !isAbsolute(file)) return undefined;
  const lock = shimLockFile(file);
  const deadline = Date.now() + waitMs;
  const procRoot = hooks.procRoot ?? (process.platform === "linux" ? "/proc" : undefined);
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { return undefined; }
  do {
    try {
      const fd = openSync(lock, "wx", 0o600);
      const token = randomUUID();
      const generation = ownGeneration(procRoot);
      const content = Buffer.from(`${process.pid} ${Date.now()} ${token}${generation === undefined ? "" : ` ${generation}`}\n`);
      let ino: number | undefined;
      try {
        ino = fstatSync(fd).ino;
        writeFileSync(fd, content);
      } catch {
        // A failed write may leave an empty file. Never remove a replacement.
        try {
          if (ino !== undefined && statSync(lock).ino === ino) {
            const found = readFileSync(lock);
            if (found.includes(Buffer.from(token)) || found.length === 0) unlinkSync(lock);
          }
        } catch { /* best effort */ }
        try { closeSync(fd); } catch { /* best effort */ }
        return undefined;
      }
      const held = () => {
        try { return statSync(lock).ino === ino && readFileSync(lock).equals(content); }
        catch { return false; }
      };
      const release: ShimLockRelease = Object.assign(() => {
        try {
          if (held()) unlinkSync(lock);
        } catch { /* best effort */ }
      }, { held });
      try { (hooks.close ?? closeSync)(fd); } catch {
        try { closeSync(fd); } catch { /* best effort */ }
        // The caller still owns the lock and can release it in its finally block.
        return release;
      }
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    let staleFd: number | undefined;
    try {
      staleFd = openSync(lock, "r");
      const before = fstatSync(staleFd);
      hooks.beforeStaleSnapshot?.();
      const observed = readFileSync(staleFd);
      const text = observed.toString("utf8");
      const [pidText, timeText, , storedGeneration] = text.trim().split(" ");
      const pid = Number(pidText);
      const age = Date.now() - Number(timeText);
      // A live holder is never reclaimed, however old its lock: a holder
      // paused past the lease would still commit the snapshot it read, over
      // whatever its replacement wrote (#151). Age only recovers a lock whose
      // holder cannot be checked: empty, malformed, or an inconclusive probe.
      // A live pid whose start time differs from the recorded generation is a
      // reused pid: the recorded holder is gone, since no two processes share
      // a pid at once. An unreadable generation, or a legacy lock without one,
      // keeps the live-pid protection, and the generation is compared only
      // in a complete record (newline-terminated): a waiter can read the lock
      // mid-write and see a truncated fourth field. A live pid whose procfs
      // state is Z or X with a parsed start time has exited: an unreaped
      // zombie still passes kill(0) but can never commit, generation or not.
      // An incomplete or unparseable stat keeps the live-pid protection.
      let dead = false;
      let live = false;
      if (/^\d+$/.test(pidText ?? "") && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); live = true; } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          dead = code === "ESRCH";
          live = code === "EPERM";
        }
        if (live) {
          const { state, start } = readProcStat(procRoot, pid);
          const reused = text.endsWith("\n") && storedGeneration !== undefined && /^\d+$/.test(storedGeneration)
            && start !== undefined && BigInt(start) !== BigInt(storedGeneration);
          if ((start !== undefined && (state === "Z" || state === "X")) || reused) {
            live = false;
            dead = true;
          }
        }
      }
      const expired = (Number.isFinite(age) && age > LEASE_MS) || Date.now() - before.mtimeMs > LEASE_MS;
      if (!live && (dead || expired)) {
        hooks.beforeStaleUnlink?.();
        // Recheck the bytes as well as the inode; old pid/timestamp locks can
        // still be recovered. The final read and unlinkSync are not atomic on
        // POSIX without OS locks: another writer can replace the file in that
        // gap. This advisory guard fails open if that rare race occurs.
        const current = statSync(lock);
        if (current.ino === before.ino && current.dev === before.dev && readFileSync(lock).equals(observed)) {
          unlinkSync(lock);
          continue;
        }
      }
    } catch { /* the holder may have released it */ }
    finally {
      if (staleFd !== undefined) try { closeSync(staleFd); } catch { /* best effort */ }
    }
    if (Date.now() >= deadline) break;
    Atomics.wait(pause, 0, 0, Math.min(10, deadline - Date.now()));
  } while (Date.now() <= deadline);
  return undefined;
}
