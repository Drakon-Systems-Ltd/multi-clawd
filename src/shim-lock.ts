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
 * Field 22 (starttime) of a Linux /proc/<pid>/stat line, as a decimal string.
 * comm (field 2) may hold spaces and parentheses, so fields are counted from
 * the last ")" in the line; the kernel prints nothing after comm that holds one.
 */
export function parseProcStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/** The start time of pid as procfs reports it, or undefined when unknowable. */
function readGeneration(procRoot: string | undefined, pid: number | "self"): string | undefined {
  if (procRoot === undefined) return undefined;
  try { return parseProcStatStartTime(readFileSync(join(procRoot, String(pid), "stat"), "utf8")); } catch { return undefined; }
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

/** Undefined means fail open: callers must avoid replacing protected snapshots. */
export function acquireShimLock(file: string, waitMs = WAIT_MS, hooks: ShimLockTestHooks = {}): (() => void) | undefined {
  if (!file || !isAbsolute(file)) return undefined;
  const lock = `${file}.lock`;
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
      const release = () => {
        try {
          if (statSync(lock).ino === ino && readFileSync(lock).equals(content)) unlinkSync(lock);
        } catch { /* best effort */ }
      };
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
      const [pidText, timeText, , storedGeneration] = observed.toString("utf8").trim().split(" ");
      const pid = Number(pidText);
      const age = Date.now() - Number(timeText);
      // A live holder is never reclaimed, however old its lock: a holder
      // paused past the lease would still commit the snapshot it read, over
      // whatever its replacement wrote (#151). Age only recovers a lock whose
      // holder cannot be checked: empty, malformed, or an inconclusive probe.
      // A live pid whose start time differs from the recorded generation is a
      // reused pid: the recorded holder is gone, since no two processes share
      // a pid at once. An unreadable generation, or a legacy lock without one,
      // keeps the live-pid protection.
      let dead = false;
      let live = false;
      if (/^\d+$/.test(pidText ?? "") && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); live = true; } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          dead = code === "ESRCH";
          live = code === "EPERM";
        }
        if (live && storedGeneration !== undefined && /^\d+$/.test(storedGeneration)) {
          const current = readGeneration(procRoot, pid);
          if (current !== undefined && BigInt(current) !== BigInt(storedGeneration)) {
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
