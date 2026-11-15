import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MAX_PARKED_FILES, MAX_SESSION_PARKED, MAX_SESSION_PINS, readSessionPin, recordSessionPin,
} from "../src/session-affinity.js";

// #186: the parked files of one session, and of the pool, stay under a named
// bound whatever another process holds and however long it is stopped. Every
// state here is built through the seams the #183 tests use (a lock or marker
// file naming this live test process, parked files written directly), in one
// process, against a fixture directory: no timing, no provider, no real state.
let dir: string;
let file: string;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-affinity-bound-"));
  file = join(dir, "state", "pool-clawd.sessions.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const TTL = 100_000;
const K = MAX_SESSION_PARKED;
const sessionKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
const names = () => readdirSync(join(dir, "state")).sort();
const pending = () => names().filter((name) => name.includes(".pending-"));
const pendingOf = (sessionId: string) => pending().filter((name) => name.includes(`-${sessionKey(sessionId)}-`));
/** What the shim's own diagnostic channel (stderr, `[multi-clawd shim]` lines) was given. */
const refusals = () => stderr.mock.calls.map((call) => String(call[0])).filter((line) =>
  line.startsWith("[multi-clawd shim] session pin not recorded"));

/** A lock naming this live process: it is never reclaimed, however long it is held. */
const holdLive = (target: string) => writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()} issue-186-live-holder\n`);
/** The store lock held by a live, stopped turn: every write in the test parks. */
const holdStoreLock = () => holdLive(file);
const sessionLockTarget = (sessionId: string) => `${file}.parked-${sessionKey(sessionId)}`;
/** The session's parked-file lock held by a live, stopped process. */
const holdSessionLock = (sessionId: string) => holdLive(sessionLockTarget(sessionId));
const readerMarker = (sessionId: string) => `${sessionLockTarget(sessionId)}.reader-4242-0123456789ab.lock`;
/** A reader's marker for the session, as a read that lost a file writes it, naming this live process: a stopped live reader. */
const announceLiveReader = (sessionId: string) =>
  writeFileSync(readerMarker(sessionId), `${process.pid} ${Date.now()} issue-186-reader\n`);

/** A parked file exactly as a real park names and fills it (the store test checks the name against a real one). */
const parkDirect = (sessionId: string, account: string, servedAt: number) => {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  const name = `pool-clawd.sessions.json.pending-${fixed(servedAt, 13)}-${sessionKey(sessionId)}-${fixed(servedAt, 13)}-0000004242-000000000-0123456789ab`;
  writeFileSync(join(dir, "state", name), JSON.stringify({ [sessionId]: { account, servedAt } }));
};
/** `count` parked pins of one session, served at `from`, `from + 1`, ... */
const seed = (sessionId: string, count: number, from: number) => {
  for (let i = 0; i < count; i++) parkDirect(sessionId, `seed${from + i}`, from + i);
};

describe("the bounds are named and related (#186)", () => {
  test("one session's bound is small, and the total leaves room for it above the store's own bound", () => {
    expect(Number.isInteger(MAX_SESSION_PARKED)).toBe(true);
    expect(MAX_SESSION_PARKED).toBeGreaterThanOrEqual(8);
    expect(MAX_SESSION_PARKED).toBeLessThanOrEqual(64);
    expect(MAX_PARKED_FILES).toBe(MAX_SESSION_PINS + MAX_SESSION_PARKED);
  });
});

describe("one session's parked files while a stopped live reader holds its marker (#186)", () => {
  test("parks well past the bound never leave more than the bound, and the newest pin is readable throughout", () => {
    holdStoreLock();
    announceLiveReader("a");
    seed("a", K - 2, 1000);
    let most = pendingOf("a").length;
    // Twelve real parks from two under the bound: each waits out the store lock, then parks.
    for (let i = 0; i < 12; i++) {
      const servedAt = 5000 + i;
      recordSessionPin(file, "a", `account${servedAt}`, servedAt, TTL);
      most = Math.max(most, pendingOf("a").length);
      expect(pendingOf("a").length).toBeLessThanOrEqual(K);
      expect(readSessionPin(file, "a", 6000, TTL)).toEqual({ account: `account${servedAt}`, servedAt });
    }
    // The bound was reached, and what gave way was the stale reader's protection, not a write.
    expect(most).toBe(K);
    expect(refusals()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    // The reader's marker and the store lock belong to other processes: neither was touched.
    expect(readFileSync(readerMarker("a"), "utf8")).toContain("issue-186-reader");
    expect(readFileSync(`${file}.lock`, "utf8")).toContain("issue-186-live-holder");
  }, 60_000);

  test("under the bound the reader's protection is intact: nothing of that session is removed", () => {
    holdStoreLock();
    announceLiveReader("a");
    seed("a", K - 4, 1000);
    for (let i = 0; i < 3; i++) recordSessionPin(file, "a", `account${5000 + i}`, 5000 + i, TTL);
    expect(pendingOf("a")).toHaveLength(K - 1);
    expect(refusals()).toEqual([]);
  }, 30_000);

  test("at the bound a delayed, earlier-served write does not displace the newest pin", () => {
    holdStoreLock();
    announceLiveReader("a");
    seed("a", K, 1000);
    const newest = { account: `seed${1000 + K - 1}`, servedAt: 1000 + K - 1 };
    recordSessionPin(file, "a", "delayed", 500, TTL);
    expect(pendingOf("a").length).toBeLessThanOrEqual(K);
    expect(readSessionPin(file, "a", 6000, TTL)).toEqual(newest);
    expect(refusals()).toEqual([]);
  }, 30_000);

  test("another session is not held to this session's count", () => {
    holdStoreLock();
    announceLiveReader("a");
    seed("a", K, 1000);
    recordSessionPin(file, "b", "claw2", 5000, TTL);
    expect(pendingOf("a")).toHaveLength(K);
    expect(readSessionPin(file, "b", 6000, TTL)).toEqual({ account: "claw2", servedAt: 5000 });
    expect(refusals()).toEqual([]);
  }, 30_000);
});

describe("one session's parked files while a stopped live process holds its parked-file lock (#186)", () => {
  test("at the bound a write is refused: no extra file, the newest parked pin stays, and the refusal is reported", () => {
    holdStoreLock();
    holdSessionLock("a");
    seed("a", K - 1, 1000);
    // Under the bound a park needs no lock, as before.
    recordSessionPin(file, "a", "account5000", 5000, TTL);
    expect(pendingOf("a")).toHaveLength(K);
    expect(refusals()).toEqual([]);
    const before = pending();
    for (let i = 1; i <= 4; i++) {
      expect(() => recordSessionPin(file, "a", `account${5000 + i}`, 5000 + i, TTL)).not.toThrow();
      // Never an extra file, and no file of the session was removed without its lock.
      expect(pending()).toEqual(before);
      expect(refusals()).toHaveLength(i);
      expect(readSessionPin(file, "a", 6000, TTL)).toEqual({ account: "account5000", servedAt: 5000 });
    }
    expect(refusals()[0]).toMatch(/^\[multi-clawd shim\] session pin not recorded: .*\n$/);
    expect(refusals()[0]).toContain(String(K));
    // The message names no session id, account or path.
    expect(refusals()[0]).not.toContain(dir);
    expect(refusals()[0]).not.toContain("account500");
    // No temp file is left, and the other process's locks are still its own.
    expect(names().filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(readFileSync(`${sessionLockTarget("a")}.lock`, "utf8")).toContain("issue-186-live-holder");
    expect(readFileSync(`${file}.lock`, "utf8")).toContain("issue-186-live-holder");
  }, 60_000);

  test("another session still parks, and once the lock is free the session's next write is kept and trims it", () => {
    holdStoreLock();
    holdSessionLock("a");
    seed("a", K, 1000);
    recordSessionPin(file, "a", "refused", 5000, TTL);
    expect(refusals()).toHaveLength(1);
    recordSessionPin(file, "b", "claw2", 5001, TTL);
    expect(readSessionPin(file, "b", 6000, TTL)).toEqual({ account: "claw2", servedAt: 5001 });
    expect(refusals()).toHaveLength(1);
    rmSync(`${sessionLockTarget("a")}.lock`);
    recordSessionPin(file, "a", "kept", 5002, TTL);
    expect(refusals()).toHaveLength(1);
    expect(pendingOf("a")).toHaveLength(1);
    expect(readSessionPin(file, "a", 6000, TTL)).toEqual({ account: "kept", servedAt: 5002 });
  }, 30_000);

  test("a refused write changes nothing for the turn: the store, once free, folds what was parked", () => {
    holdStoreLock();
    holdSessionLock("a");
    seed("a", K, 1000);
    recordSessionPin(file, "a", "refused", 5000, TTL);
    rmSync(`${file}.lock`);
    recordSessionPin(file, "b", "claw2", 5001, TTL);
    recordSessionPin(file, "c", "claw3", 5002, TTL);
    const pins = JSON.parse(readFileSync(file, "utf8"));
    expect(pins.a).toEqual({ account: `seed${1000 + K - 1}`, servedAt: 1000 + K - 1 });
    expect(pending()).toEqual([]);
  }, 30_000);
});

describe("other sessions next to one session's surplus (#186)", () => {
  test("with 999 other sessions parked, none loses its only file to this session's surplus", () => {
    holdStoreLock();
    const others = MAX_SESSION_PINS - 1;
    for (let i = 0; i < others; i++) parkDirect(`s${i}`, "claw1", 1000 + i);
    announceLiveReader("hot");
    seed("hot", K - 2, 3000);
    for (let i = 0; i < 6; i++) {
      const servedAt = 5000 + i;
      recordSessionPin(file, "hot", `account${servedAt}`, servedAt, TTL);
      expect(pendingOf("hot").length).toBeLessThanOrEqual(K);
      expect(pending().length).toBeLessThanOrEqual(MAX_PARKED_FILES);
      expect(readSessionPin(file, "hot", 6000, TTL)).toEqual({ account: `account${servedAt}`, servedAt });
    }
    // Every other session still has its one file, the least recently served included.
    expect(pending().length - pendingOf("hot").length).toBe(others);
    for (const i of [0, 1, 2, 500, others - 2, others - 1]) {
      expect(readSessionPin(file, `s${i}`, 6000, TTL)).toEqual({ account: "claw1", servedAt: 1000 + i });
    }
    expect(refusals()).toEqual([]);
  }, 60_000);
});

describe("the total while stopped live processes hold several sessions' locks (#186)", () => {
  test("at the total bound a write is refused: the count stays, no session loses its only file, the refusal is reported", () => {
    holdStoreLock();
    // Two sessions whose parked-file locks are held by stopped live processes, each at its own bound:
    // their surplus cannot be removed by anyone, and it is what puts the total over the store's bound.
    for (const jammed of ["jam1", "jam2"]) {
      holdSessionLock(jammed);
      seed(jammed, K, 3000);
    }
    const others = MAX_PARKED_FILES - 2 * K;
    for (let i = 0; i < others; i++) parkDirect(`s${i}`, "claw1", 1000 + i);
    expect(pending()).toHaveLength(MAX_PARKED_FILES);
    const before = pending();
    for (let i = 1; i <= 3; i++) {
      expect(() => recordSessionPin(file, `new${i}`, "claw2", 5000 + i, TTL)).not.toThrow();
      expect(pending()).toEqual(before);
      expect(refusals()).toHaveLength(i);
      expect(readSessionPin(file, `new${i}`, 6000, TTL)).toBeUndefined();
    }
    expect(refusals()[0]).toContain(String(MAX_PARKED_FILES));
    expect(readSessionPin(file, "s0", 6000, TTL)).toEqual({ account: "claw1", servedAt: 1000 });
    expect(readSessionPin(file, `s${others - 1}`, 6000, TTL)).toEqual({ account: "claw1", servedAt: 1000 + others - 1 });
    // Once one of the locks is free, a write makes room from that session's surplus and is kept.
    rmSync(`${sessionLockTarget("jam1")}.lock`);
    recordSessionPin(file, "new4", "claw2", 5004, TTL);
    expect(refusals()).toHaveLength(3);
    expect(readSessionPin(file, "new4", 6000, TTL)).toEqual({ account: "claw2", servedAt: 5004 });
    expect(pending().length).toBeLessThanOrEqual(MAX_PARKED_FILES);
    expect(readSessionPin(file, "s0", 6000, TTL)).toEqual({ account: "claw1", servedAt: 1000 });
  }, 60_000);
});

describe("the read guarantee of #183 next to the bound (#186)", () => {
  /** A read during which every listing of the session's parked files is followed by one more same-session park. */
  function readWhileReplacing(sessionId: string, now: number, servedAts: number[]) {
    const queue = [...servedAts];
    const pin = readSessionPin(file, sessionId, now, TTL, {
      afterParkedList: () => {
        const servedAt = queue.shift();
        if (servedAt !== undefined) recordSessionPin(file, sessionId, `account${servedAt}`, servedAt, TTL);
      },
    });
    return { pin, parked: servedAts.length - queue.length };
  }

  test.each([
    ["two under the bound", K - 2],
    ["one under the bound", K - 1],
    ["at the bound", K],
  ])("a session %s, another reader's marker held: a read raced by fewer parks than the bound still returns a pin from read start or later", (_name, count) => {
    holdStoreLock();
    announceLiveReader("a");
    seed("a", count, 1000);
    const atStart = 1000 + count - 1;
    const { pin } = readWhileReplacing("a", 6000, [5000, 5001, 5002, 5003]);
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(atStart);
    expect(pendingOf("a").length).toBeLessThanOrEqual(K);
    // The read's own marker is gone; the other reader's is still there.
    expect(names().filter((name) => name.includes(".reader-"))).toEqual([readerMarker("a").split("/").pop()]);
    expect(refusals()).toEqual([]);
  }, 60_000);
});
