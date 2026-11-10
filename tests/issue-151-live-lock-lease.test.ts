import { mkdtempSync, readFileSync, readdirSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireShimLock } from "../src/shim-lock";
import { persistHealthState, readHealthStateFile } from "../src/health-journal";
import { historyFile, readHistory, recordHistory } from "../src/history";
import type { AccountHealthState } from "../src/shim-core";

// After-read seam for recordHistory, which has no hook of its own: the
// callback runs once, right after the next synchronous read of `path`.
const seam = vi.hoisted(() => ({ path: undefined as string | undefined, run: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = actual.readFileSync(...args);
    if (seam.run && typeof args[0] === "string" && args[0] === seam.path) {
      const run = seam.run;
      seam.run = undefined;
      run();
    }
    return out;
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const box = () => mkdtempSync(join(tmpdir(), "mc-151-"));
const LATER_MS = 60_000;

/** Every clock read in this process lands LATER_MS ahead while `fn` runs, so any lock now looks well past its lease. */
function later<T>(fn: () => T): T {
  const real = Date.now;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + LATER_MS);
  try { return fn(); } finally { spy.mockRestore(); }
}

const lockBytes = (file: string) => { try { return readFileSync(`${file}.lock`); } catch { return undefined; } };

afterEach(() => { seam.path = undefined; seam.run = undefined; vi.restoreAllMocks(); });

describe("#151 a live lock holder is never reclaimed by age", () => {
  test("live pid with an old timestamp and an old mtime keeps its lock", () => {
    const target = join(box(), "home.json");
    const lock = `${target}.lock`;
    const held = `${process.pid} ${Date.now() - LATER_MS} some-token\n`;
    writeFileSync(lock, held);
    const old = new Date(Date.now() - LATER_MS);
    utimesSync(lock, old, old);
    expect(acquireShimLock(target, 20)).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a held lock outlives the lease while its holder runs, then releases normally", () => {
    const target = join(box(), "home.json");
    const release = acquireShimLock(target);
    expect(release).toBeTypeOf("function");
    expect(release?.held()).toBe(true);
    const held = lockBytes(target);
    expect(later(() => acquireShimLock(target, 20))).toBeUndefined();
    expect(lockBytes(target)).toEqual(held);
    expect(release?.held()).toBe(true);
    release?.();
    expect(release?.held()).toBe(false);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("a live holder owned by another user (EPERM) is not reclaimed", () => {
    const target = join(box(), "home.json");
    const lock = `${target}.lock`;
    const held = `${process.pid} ${Date.now() - LATER_MS}\n`;
    writeFileSync(lock, held);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(acquireShimLock(target, 20)).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a dead holder's lock is still recovered at once, old or fresh", () => {
    const target = join(box(), "home.json");
    for (const at of [Date.now(), Date.now() - LATER_MS]) {
      writeFileSync(`${target}.lock`, `99999999 ${at}\n`);
      const release = acquireShimLock(target, 30);
      expect(release).toBeTypeOf("function");
      release?.();
      expect(existsSync(`${target}.lock`)).toBe(false);
    }
  });

  test("an empty or malformed lock is recovered only after the lease", () => {
    const target = join(box(), "home.json");
    const lock = `${target}.lock`;
    for (const content of ["", "garbage\n", "0x1 nope\n"]) {
      writeFileSync(lock, content);
      expect(acquireShimLock(target, 0)).toBeUndefined();
      expect(readFileSync(lock, "utf8")).toBe(content);
      const old = new Date(Date.now() - LATER_MS);
      utimesSync(lock, old, old);
      const release = acquireShimLock(target, 30);
      expect(release).toBeTypeOf("function");
      release?.();
      expect(existsSync(lock)).toBe(false);
    }
  });
});

describe("#151 a paused holder's commit cannot erase a second writer", () => {
  const state = (windows: AccountHealthState["windows"]): AccountHealthState => ({ accountId: "home", windows });
  const seen = (status: "allowed" | "rejected" = "allowed") => ({ status, seenAt: Date.now() });

  test("persistHealthState: observations from before, during and after the pause all survive", () => {
    const file = join(box(), "home.json");
    persistHealthState(file, state({ "before": seen() }));

    let heldAtPause: Buffer | undefined;
    let heldAfterSecond: Buffer | undefined;
    let snapshotAtPause: string | undefined;
    let snapshotAfterSecond: string | undefined;
    persistHealthState(file, state({ "first": seen("rejected") }), {
      // The first writer has read the snapshot and listed pending deltas and
      // is now paused well past the lease while a second writer runs.
      afterList: () => {
        heldAtPause = lockBytes(file);
        snapshotAtPause = readFileSync(file, "utf8");
        later(() => persistHealthState(file, state({ "second": seen("rejected") })));
        heldAfterSecond = lockBytes(file);
        snapshotAfterSecond = readFileSync(file, "utf8");
      },
    });

    expect(heldAtPause).toBeDefined();
    expect(heldAfterSecond).toEqual(heldAtPause);
    expect(snapshotAfterSecond).toBe(snapshotAtPause);
    const windows = readHealthStateFile(file)?.windows ?? {};
    expect(Object.keys(windows).sort()).toEqual(["before", "first", "second"]);
    expect(windows["first"]?.status).toBe("rejected");
    expect(windows["second"]?.status).toBe("rejected");
    expect(existsSync(`${file}.lock`)).toBe(false);

    // The next locked write folds the second writer's delta into the snapshot.
    persistHealthState(file, state({}));
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
    expect(Object.keys(snapshot.windows).sort()).toEqual(["before", "first", "second"]);
  });

  test("recordHistory: no event that became visible is lost to the paused holder's commit", () => {
    const stateFile = join(box(), "claw1.json");
    const file = historyFile(stateFile);
    const ev = (accountId: string) => ({ at: new Date().toISOString(), kind: "served" as const, accountId });
    recordHistory(stateFile, ev("claw0"));
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw0"]);

    let paused = false;
    let heldAtPause: Buffer | undefined;
    let heldAfterSecond: Buffer | undefined;
    let journalAtPause: string | undefined;
    let journalAfterSecond: string | undefined;
    let visibleDuringPause: string[] = [];
    let parkedDuringPause: string[] = [];
    let parkedContentDuringPause: string | undefined;
    const pending = () => readdirSync(dirname(file)).filter((name) => name.startsWith("history.jsonl.pending-"));
    seam.path = file;
    seam.run = () => {
      // The first writer has read the journal and is now paused well past
      // the lease while a second writer records its own event.
      paused = true;
      heldAtPause = lockBytes(file);
      journalAtPause = readFileSync(file, "utf8");
      later(() => recordHistory(stateFile, ev("claw2")));
      parkedDuringPause = pending();
      if (parkedDuringPause.length === 1) {
        parkedContentDuringPause = readFileSync(join(dirname(file), parkedDuringPause[0]), "utf8");
      }
      heldAfterSecond = lockBytes(file);
      journalAfterSecond = readFileSync(file, "utf8");
      visibleDuringPause = readHistory(file).map((e) => e.accountId);
    };
    recordHistory(stateFile, ev("claw1"));

    expect(paused).toBe(true);
    expect(heldAtPause).toBeDefined();
    expect(heldAfterSecond).toEqual(heldAtPause);
    expect(journalAfterSecond).toBe(journalAtPause);
    expect(parkedDuringPause).toHaveLength(1);
    expect(parkedContentDuringPause).toContain('"accountId":"claw2"');
    const final = readHistory(file).map((e) => e.accountId);
    expect(final[0]).toBe("claw0");
    expect(final.slice(1).sort()).toEqual(["claw1", "claw2"]);
    expect(visibleDuringPause).toEqual(["claw0", "claw2"]);
    expect(existsSync(`${file}.lock`)).toBe(false);

    recordHistory(stateFile, ev("claw3"));
    expect(pending()).toEqual([]);
    const folded = readHistory(file).map((e) => e.accountId);
    expect(folded[0]).toBe("claw0");
    expect(folded.slice(1, -1).sort()).toEqual(["claw1", "claw2"]);
    expect(folded[folded.length - 1]).toBe("claw3");
  });
});
