/** Durable, best-effort journal for the shim's per-account health file. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireShimLock } from "./shim-lock.js";
import { mergeHealthStates, parseStoredState, type AccountHealthState } from "./shim-core.js";

type ReadOptions = {
  onSnapshotError?: (raw: string | undefined) => void;
  strictSnapshot?: boolean;
  /** Test seam for a pending file folded between listing and opening. */
  afterList?: (files: string[]) => void;
};

function pendingFiles(file: string): string[] {
  const prefix = `${basename(file)}.pending-`;
  try {
    return readdirSync(dirname(file)).filter((name) => name.startsWith(prefix) && /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name.slice(prefix.length))).map((name) => join(dirname(file), name));
  } catch { return []; }
}

function snapshot(file: string, onError?: (raw: string | undefined) => void, strict = false): AccountHealthState | undefined {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onError?.(undefined);
      if (strict) throw err;
    }
    return undefined;
  }
  const state = parseStoredState(raw);
  if (!state) {
    onError?.(raw);
    if (strict) throw new Error("not valid health-state JSON");
  }
  return state;
}

/** Read all published observations without pruning. Retry a fold/unlink race. */
export function readHealthStateFile(file: string, opts: ReadOptions = {}): AccountHealthState | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    let state = snapshot(file, opts.onSnapshotError, opts.strictSnapshot);
    const files = pendingFiles(file);
    opts.afterList?.(files);
    let missing = false;
    for (const pending of files) {
      let raw: string;
      try { raw = readFileSync(pending, "utf8"); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") missing = true;
        continue;
      }
      const delta = parseStoredState(raw);
      if (delta) state = state ? mergeHealthStates(state, delta) : delta;
    }
    if (!missing || attempt === 2) return state;
  }
  return undefined;
}

function publish(file: string, state: AccountHealthState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Only lock holders replace the snapshot. Timed-out writers publish deltas;
 * the next locked write folds them, bounding journal growth by contention.
 */
export function persistHealthState(file: string, state: AccountHealthState, opts: {
  /** Test seam for a delta published after the holder's list. */
  afterList?: (files: string[]) => void;
  onSnapshotError?: (raw: string | undefined) => void;
} = {}): AccountHealthState {
  const release = acquireShimLock(file);
  try {
    if (!release) {
      publish(`${file}.pending-${process.pid}-${randomUUID()}`, state);
      return state;
    }
    let merged = snapshot(file, opts.onSnapshotError);
    const files = pendingFiles(file);
    opts.afterList?.(files);
    const folded: string[] = [];
    for (const pending of files) {
      let raw: string;
      try { raw = readFileSync(pending, "utf8"); }
      catch { continue; }
      const delta = parseStoredState(raw);
      if (!delta) {
        try { renameSync(pending, `${pending}.corrupt-${Date.now()}`); } catch { /* best effort */ }
        continue;
      }
      merged = merged ? mergeHealthStates(merged, delta) : delta;
      folded.push(pending);
    }
    merged = merged ? mergeHealthStates(merged, state, Date.now()) : mergeHealthStates(state, state, Date.now());
    publish(file, merged);
    for (const pending of folded) {
      try { unlinkSync(pending); } catch { /* next fold may see it again */ }
    }
    return merged;
  } catch (err) {
    process.stderr.write(`[multi-clawd shim] state write failed: ${String(err)}\n`);
    return state;
  } finally { release?.(); }
}
