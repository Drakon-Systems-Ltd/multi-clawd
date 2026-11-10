/** Short, best-effort cross-process guard for shim state and retry decisions. */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const WAIT_MS = 150;
const LEASE_MS = 5_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Test seam for the replacement interleaving and close failure. */
interface ShimLockTestHooks {
  beforeStaleSnapshot?: () => void;
  beforeStaleUnlink?: () => void;
  close?: (fd: number) => void;
}

/** Where the lock for `file` lives. Its bytes name the current holder. */
export function shimLockFile(file: string): string {
  return `${file}.lock`;
}

/**
 * Releases the lock. `held()` says whether the lock file is still the one
 * this acquisition created: same inode, same bytes. The lock is a lease, so
 * a holder that was paused past it can find that it no longer is.
 */
export type ShimLockRelease = (() => void) & { held: () => boolean };

/** Undefined means fail open: callers must avoid replacing protected snapshots. */
export function acquireShimLock(file: string, waitMs = WAIT_MS, hooks: ShimLockTestHooks = {}): ShimLockRelease | undefined {
  if (!file || !isAbsolute(file)) return undefined;
  const lock = shimLockFile(file);
  const deadline = Date.now() + waitMs;
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { return undefined; }
  do {
    try {
      const fd = openSync(lock, "wx", 0o600);
      const token = randomUUID();
      const content = Buffer.from(`${process.pid} ${Date.now()} ${token}\n`);
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
      const [pidText, timeText] = observed.toString("utf8").trim().split(" ");
      const pid = Number(pidText);
      const age = Date.now() - Number(timeText);
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (err) { dead = (err as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead || (Number.isFinite(age) && age > LEASE_MS) || Date.now() - before.mtimeMs > LEASE_MS) {
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
