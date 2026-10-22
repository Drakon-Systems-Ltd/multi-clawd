/** Short, best-effort cross-process guard for shim state and retry decisions. */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const WAIT_MS = 150;
const LEASE_MS = 5_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Undefined means fail open: callers still perform their work. */
export function acquireShimLock(file: string, waitMs = WAIT_MS): (() => void) | undefined {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { return undefined; }
  do {
    try {
      const fd = openSync(lock, "wx", 0o600);
      let ino: number;
      try {
        ino = fstatSync(fd).ino;
        writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      } catch {
        try { unlinkSync(lock); } catch { /* best effort */ }
        return undefined;
      } finally { closeSync(fd); }
      return () => {
        try { if (statSync(lock).ino === ino) unlinkSync(lock); } catch { /* best effort */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    try {
      const before = statSync(lock);
      const [pidText, timeText] = readFileSync(lock, "utf8").trim().split(" ");
      const pid = Number(pidText);
      const age = Date.now() - Number(timeText);
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (err) { dead = (err as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead || (Number.isFinite(age) && age > LEASE_MS) || Date.now() - before.mtimeMs > LEASE_MS) {
        // Identity check avoids removing a lock already replaced by another writer.
        if (statSync(lock).ino === before.ino) unlinkSync(lock);
        continue;
      }
    } catch { /* the holder may have released it */ }
    if (Date.now() >= deadline) break;
    Atomics.wait(pause, 0, 0, Math.min(10, deadline - Date.now()));
  } while (Date.now() <= deadline);
  return undefined;
}
