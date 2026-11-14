import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MAX_SESSION_PINS, readSessionPin, recordSessionPin } from "../src/session-affinity.js";

// #183: a read must return a pin at least as recent as the session's latest
// valid pin (store or parked) at the moment the read began, however many
// same-session pins are parked while it runs. Every interleaving here is
// driven through the read's own test seam, in one process, against a fixture
// directory: no timing, no provider, no real state.
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-affinity-snapshot-"));
  file = join(dir, "state", "pool-clawd.sessions.json");
  mkdirSync(join(dir, "state"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TTL = 1000;
const sessionKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
const names = () => readdirSync(join(dir, "state")).sort();
const pending = () => names().filter((name) => name.includes(".pending-"));
const sessionLocks = () => names().filter((name) => name.includes(".parked-"));

/** A lock naming this live process: it is never reclaimed, so whoever wants it waits out its budget. */
const holdLive = (target: string) => writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()} issue-183-live-holder\n`);
/** The store lock held by a live turn: every write in the test parks. */
const holdStoreLock = () => holdLive(file);
/** The session's parked-file lock held by a live process: nobody may remove that session's parked files. */
const sessionLockTarget = (sessionId: string) => `${file}.parked-${sessionKey(sessionId)}`;

const parkDirect = (sessionId: string, account: string, servedAt: number) => {
  const fixed = (value: number, width: number) => String(value).padStart(width, "0");
  const name = `pool-clawd.sessions.json.pending-${fixed(servedAt, 13)}-${sessionKey(sessionId)}-${fixed(servedAt, 13)}-0000004242-000000000-0123456789ab`;
  writeFileSync(join(dir, "state", name), JSON.stringify({ [sessionId]: { account, servedAt } }));
};

/** A read during which every listing of the session's parked files is followed by one more same-session park. */
function readWhileReplacing(sessionId: string, now: number, servedAts: number[]) {
  const queue = [...servedAts];
  let listings = 0;
  const pin = readSessionPin(file, sessionId, now, TTL, {
    afterParkedList: () => {
      listings++;
      const servedAt = queue.shift();
      if (servedAt !== undefined) recordSessionPin(file, sessionId, `account${servedAt}`, servedAt, TTL);
    },
  });
  return { pin, listings, parked: servedAts.length - queue.length };
}

describe("a read racing same-session replacements (#183)", () => {
  test("four successive replacements with no store still yield a pin no older than the one parked at read start", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { pin, parked } = readWhileReplacing("a", 500, [200, 300, 400, 500]);
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
    expect(pin!.account).toBe(`account${pin!.servedAt}`);
    // The next ordinary read sees the last pin any of those turns parked.
    const last = 100 * (parked + 1);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: `account${last}`, servedAt: last });
    expect(sessionLocks()).toEqual([]);
  }, 30_000);

  test("four successive replacements over an older stored pin do not fall back to the stored pin", () => {
    writeFileSync(file, JSON.stringify({ a: { account: "old", servedAt: 50 } }));
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { pin } = readWhileReplacing("a", 500, [200, 300, 400, 500]);
    expect(pin).toBeDefined();
    expect(pin!.account).not.toBe("old");
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: { account: "old", servedAt: 50 } });
  }, 30_000);

  test("a replacement on every listing, well past any retry count, cannot starve the read", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const servedAts = Array.from({ length: 14 }, (_, i) => 200 + i * 10);
    const started = Date.now();
    const { pin, listings, parked } = readWhileReplacing("a", 500, servedAts);
    const elapsed = Date.now() - started;
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
    expect(pin!.account).toBe(`account${pin!.servedAt}`);
    // The read ends on its own: it does not keep listing for as long as parkers keep arriving.
    expect(listings).toBeLessThanOrEqual(2);
    expect(parked).toBe(listings);
    // Each park in the hook waits out the 1 s store lock; the read itself adds no unbounded wait.
    expect(elapsed).toBeLessThan(parked * 1500 + 2000);
    expect(sessionLocks()).toEqual([]);
  }, 60_000);

  test("a replacement served after the read's own clock reading still counts", () => {
    // In production a turn that parks during a read captured its clock after
    // the read did. Its pin is the session's latest, not a pin from the future.
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { pin } = readWhileReplacing("a", 100, [101, 102, 103, 104]);
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
    expect(pin!.account).toBe(`account${pin!.servedAt}`);
  }, 30_000);

  test("a pin far ahead of the read's clock is still no pin", () => {
    writeFileSync(file, JSON.stringify({ a: { account: "skewed", servedAt: 100 + 61_000 } }));
    parkDirect("b", "skewed", 100 + 61_000);
    expect(readSessionPin(file, "a", 100, 1_000_000)).toBeUndefined();
    expect(readSessionPin(file, "b", 100, 1_000_000)).toBeUndefined();
  });
});

describe("removal of a session's superseded parked files (#183)", () => {
  test("while the session's parked-file lock is held, a park removes nothing of that session and a read sees every pin", () => {
    holdStoreLock();
    holdLive(sessionLockTarget("a"));
    recordSessionPin(file, "a", "account100", 100, TTL);
    recordSessionPin(file, "a", "account200", 200, TTL);
    recordSessionPin(file, "a", "account150", 150, TTL);
    expect(pending()).toHaveLength(3);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: "account200", servedAt: 200 });
    // Another session is not held up by that lock.
    recordSessionPin(file, "b", "claw1", 110, TTL);
    recordSessionPin(file, "b", "claw2", 120, TTL);
    expect(pending()).toHaveLength(4);
    // Once the lock is free the next park of the session trims it to its latest pin.
    rmSync(`${sessionLockTarget("a")}.lock`);
    recordSessionPin(file, "a", "account300", 300, TTL);
    expect(pending()).toHaveLength(2);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: "account300", servedAt: 300 });
    expect(sessionLocks()).toEqual([]);
  }, 30_000);

  test("a read that cannot take the session's lock waits a bounded time and still finds a folded pin in the store", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    holdLive(sessionLockTarget("a"));
    let once = true;
    const started = Date.now();
    const pin = readSessionPin(file, "a", 500, TTL, {
      afterParkedList: () => {
        if (!once) return;
        once = false;
        // The store lock frees and another session's write folds the parked pin in and removes its file.
        rmSync(`${file}.lock`);
        recordSessionPin(file, "b", "claw2", 120, TTL);
      },
    });
    expect(pin).toEqual({ account: "account100", servedAt: 100 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(pending()).toEqual([]);
    // The read neither took nor removed the other process's lock.
    expect(readFileSync(`${sessionLockTarget("a")}.lock`, "utf8")).toContain("issue-183-live-holder");
  }, 30_000);

  test("after the race, a fold moves the latest pin into the store and a replayed older file changes nothing", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { parked } = readWhileReplacing("a", 500, [200, 300, 400, 500]);
    const last = 100 * (parked + 1);
    // An older parked pin of the session that a slower writer left behind.
    parkDirect("a", "account150", 150);
    rmSync(`${file}.lock`);
    recordSessionPin(file, "b", "claw2", 500, TTL);
    expect(pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: `account${last}`, servedAt: last });
    // The same older pin replayed after the fold.
    parkDirect("a", "account150", 150);
    recordSessionPin(file, "c", "claw3", 500, TTL);
    expect(pending()).toEqual([]);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: `account${last}`, servedAt: last });
    expect(names().filter((name) => name.endsWith(".lock") || name.includes(".tmp-"))).toEqual([]);
  }, 30_000);

  test("at the parked-file bound a session's superseded files go before any session's only pin", () => {
    holdStoreLock();
    // "hot" could not be trimmed (its lock is held), so it has five parked pins, all newer than the rest.
    holdLive(sessionLockTarget("hot"));
    const others = MAX_SESSION_PINS - 2;
    for (let i = 0; i < others; i++) parkDirect(`s${i}`, "claw1", 1000 + i);
    for (let i = 0; i < 5; i++) parkDirect("hot", `hot${i}`, 3000 + i);
    recordSessionPin(file, "own", "claw2", 5000, 100_000);
    expect(pending()).toHaveLength(MAX_SESSION_PINS);
    // No session lost its only pin: the four files over the bound were hot's superseded ones.
    expect(readSessionPin(file, "s0", 5000, 100_000)).toEqual({ account: "claw1", servedAt: 1000 });
    expect(readSessionPin(file, `s${others - 1}`, 5000, 100_000)?.account).toBe("claw1");
    expect(readSessionPin(file, "hot", 5000, 100_000)).toEqual({ account: "hot4", servedAt: 3004 });
    expect(readSessionPin(file, "own", 5000, 100_000)).toEqual({ account: "claw2", servedAt: 5000 });
  }, 30_000);
});

describe("equal servedAt across the store and a parked pin (#183, recorded, not changed)", () => {
  test("the stored pin stays: equal timestamps carry no order, and a replayed parked file must not displace a stored write", () => {
    writeFileSync(file, JSON.stringify({ a: { account: "stored", servedAt: 100 } }));
    holdStoreLock();
    recordSessionPin(file, "a", "parked", 100, TTL);
    const pin = readSessionPin(file, "a", 100, TTL);
    // Either account served the session at 100; the read is as recent as the latest pin.
    expect(pin).toEqual({ account: "stored", servedAt: 100 });
    rmSync(`${file}.lock`);
    recordSessionPin(file, "b", "claw2", 100, TTL);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: "stored", servedAt: 100 });
    expect(pending()).toEqual([]);
  }, 30_000);
});
