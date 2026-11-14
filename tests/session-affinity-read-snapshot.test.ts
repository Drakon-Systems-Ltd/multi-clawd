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
/** Reader markers and their staging files: none may outlive the read that wrote it. */
const readerFiles = () => names().filter((name) => name.includes(".reader-"));

/** A lock naming this live process: it is never reclaimed, so whoever wants it waits out its budget. */
const holdLive = (target: string) => writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()} issue-183-live-holder\n`);
/** The store lock held by a live turn: every write in the test parks. */
const holdStoreLock = () => holdLive(file);
/** The session's parked-file lock held by a live process: nobody may remove that session's parked files. */
const sessionLockTarget = (sessionId: string) => `${file}.parked-${sessionKey(sessionId)}`;
/** A reader's marker for the session, as a read that lost a file writes it, naming `pid`. */
const readerMarker = (sessionId: string) => `${sessionLockTarget(sessionId)}.reader-4242-0123456789ab.lock`;
const announce = (sessionId: string, pid: number) =>
  writeFileSync(readerMarker(sessionId), `${pid} ${Date.now()} issue-183-reader\n`);
/** No process has this pid: it is above any pid the kernel hands out. */
const DEAD_PID = 2_147_483_646;

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
    expect(readerFiles()).toEqual([]);
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
    expect(readSessionPin(file, "a", 100, 1_000_000, { clock: () => 100 })).toBeUndefined();
    expect(readSessionPin(file, "b", 100, 1_000_000, { clock: () => 100 })).toBeUndefined();
  });

  test("the allowance ends at exactly 60 s: a pin 60000 ms ahead counts, one 60001 ms ahead is no pin", () => {
    const now = 1_000_000;
    const still = { clock: () => now };
    writeFileSync(file, JSON.stringify({
      storedAt: { account: "edge", servedAt: now + 60_000 },
      storedPast: { account: "over", servedAt: now + 60_001 },
    }));
    parkDirect("parkedAt", "edge", now + 60_000);
    parkDirect("parkedPast", "over", now + 60_001);
    expect(readSessionPin(file, "storedAt", now, 10_000_000, still)).toEqual({ account: "edge", servedAt: now + 60_000 });
    expect(readSessionPin(file, "storedPast", now, 10_000_000, still)).toBeUndefined();
    expect(readSessionPin(file, "parkedAt", now, 10_000_000, still)).toEqual({ account: "edge", servedAt: now + 60_000 });
    expect(readSessionPin(file, "parkedPast", now, 10_000_000, still)).toBeUndefined();
    // A write keeps the same edge when it rewrites the store.
    recordSessionPin(file, "writer", "claw1", now, 10_000_000);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.storedAt).toEqual({ account: "edge", servedAt: now + 60_000 });
    expect(stored.parkedAt).toEqual({ account: "edge", servedAt: now + 60_000 });
    expect(stored.storedPast).toBeUndefined();
    expect(stored.parkedPast).toBeUndefined();
  });

  test("a read stopped for longer than the allowance still counts the pin that replaced its file", () => {
    // The caller read its clock at 100; the read lists its files 100 s later.
    // The turn that parked meanwhile is 70 s ahead of the caller's reading and
    // behind the clock: its pin is the session's latest, not a pin from the future.
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, 10_000_000);
    let once = true;
    const pin = readSessionPin(file, "a", 100, 10_000_000, {
      clock: () => 100_100,
      afterParkedList: () => {
        if (!once) return;
        once = false;
        recordSessionPin(file, "a", "account70100", 70_100, 10_000_000);
      },
    });
    expect(pin).toEqual({ account: "account70100", servedAt: 70_100 });
    expect(readerFiles()).toEqual([]);
  }, 30_000);
});

describe("removals a read holding the session's lock could not stop (#183, review of 0c4afec)", () => {
  const BIG = 100_000;
  /** The bound is full of other sessions' only pins, all served before session "a". */
  const fillBound = () => { for (let i = 0; i < MAX_SESSION_PINS - 1; i++) parkDirect(`s${i}`, "claw1", 1000 + i); };
  function readAtBound(now: number, servedAts: number[]) {
    const queue = [...servedAts];
    let listings = 0;
    const pin = readSessionPin(file, "a", now, BIG, {
      afterParkedList: () => {
        listings++;
        const servedAt = queue.shift();
        if (servedAt !== undefined) recordSessionPin(file, "a", `account${servedAt}`, servedAt, BIG);
      },
    });
    return { pin, listings };
  }

  test("at the 1000-file bound a replacement on every listing does not take the read's file", () => {
    holdStoreLock();
    fillBound();
    recordSessionPin(file, "a", "account5000", 5000, BIG);
    expect(pending()).toHaveLength(MAX_SESSION_PINS);
    const { pin, listings } = readAtBound(6000, [5100, 5200, 5300, 5400, 5500, 5600]);
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(5000);
    expect(pin!.account).toBe(`account${pin!.servedAt}`);
    expect(listings).toBeLessThanOrEqual(2);
    // The file the announced read kept is the only one over the bound; the next park of the session removes it.
    expect(pending()).toHaveLength(MAX_SESSION_PINS + 1);
    expect(readerFiles()).toEqual([]);
    recordSessionPin(file, "a", "account5900", 5900, BIG);
    expect(pending()).toHaveLength(MAX_SESSION_PINS);
    expect(readSessionPin(file, "a", 6000, BIG)).toEqual({ account: "account5900", servedAt: 5900 });
    expect(readSessionPin(file, "s0", 6000, BIG)).toEqual({ account: "claw1", servedAt: 1000 });
    expect(sessionLocks()).toEqual([]);
  }, 60_000);

  test("at the bound, over an older stored pin, the read does not fall back to the stored pin", () => {
    writeFileSync(file, JSON.stringify({ a: { account: "old", servedAt: 4000 } }));
    holdStoreLock();
    fillBound();
    recordSessionPin(file, "a", "account5000", 5000, BIG);
    const { pin } = readAtBound(6000, [5100, 5200, 5300, 5400, 5500, 5600]);
    expect(pin).toBeDefined();
    expect(pin!.account).not.toBe("old");
    expect(pin!.servedAt).toBeGreaterThanOrEqual(5000);
  }, 60_000);

  test("a parker whose clock puts the read's file past the TTL does not remove it under the read", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    let listings = 0;
    const pin = readSessionPin(file, "a", 500, TTL, {
      afterParkedList: () => {
        listings++;
        // First the session's own replacement, then another session's turn that read its clock at 1200: for it a@200 has expired.
        if (listings === 1) recordSessionPin(file, "a", "account200", 200, TTL);
        if (listings === 2) recordSessionPin(file, "b", "claw2", 1200, TTL);
      },
    });
    expect(pin).toEqual({ account: "account200", servedAt: 200 });
    expect(pending()).toHaveLength(2);
    // With no read in the way the next parker with that clock removes the expired file.
    recordSessionPin(file, "c", "claw3", 1200, TTL);
    expect(pending()).toHaveLength(2);
    expect(readSessionPin(file, "a", 1200, TTL)).toBeUndefined();
    expect(readerFiles()).toEqual([]);
  }, 30_000);
});

describe("a read does not depend on taking the session's lock (#183, review of 0c4afec)", () => {
  /** One holder keeps the session's lock while the read would wait for it, then lets go, and the session parks on every later listing. */
  function readPastOneHolder(now: number) {
    let listings = 0;
    const pin = readSessionPin(file, "a", now, TTL, {
      afterParkedList: () => {
        listings++;
        if (listings === 1) {
          recordSessionPin(file, "a", "account200", 200, TTL);
          holdLive(sessionLockTarget("a"));
          return;
        }
        if (listings === 2) rmSync(`${sessionLockTarget("a")}.lock`);
        if (listings <= 5) recordSessionPin(file, "a", `account${listings * 100 + 100}`, listings * 100 + 100, TTL);
      },
    });
    return { pin, listings };
  }

  test("one holder that outlasts a wait and then lets go, no store: the read returns a pin from read start or later", () => {
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { pin, listings } = readPastOneHolder(700);
    expect(pin).toBeDefined();
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
    expect(pin!.account).toBe(`account${pin!.servedAt}`);
    expect(listings).toBeLessThanOrEqual(2);
    expect(readerFiles()).toEqual([]);
  }, 60_000);

  test("one holder that outlasts a wait and then lets go, older stored pin: the read does not return the stored pin", () => {
    writeFileSync(file, JSON.stringify({ a: { account: "old", servedAt: 50 } }));
    holdStoreLock();
    recordSessionPin(file, "a", "account100", 100, TTL);
    const { pin } = readPastOneHolder(700);
    expect(pin).toBeDefined();
    expect(pin!.account).not.toBe("old");
    expect(pin!.servedAt).toBeGreaterThanOrEqual(100);
  }, 60_000);

  test("while a live reader is announced a park removes nothing of that session; a dead reader's marker is cleared", () => {
    holdStoreLock();
    announce("a", process.pid);
    recordSessionPin(file, "a", "account100", 100, TTL);
    recordSessionPin(file, "a", "account200", 200, TTL);
    // A turn whose clock puts both pins past the TTL removes neither.
    recordSessionPin(file, "b", "claw2", 1300, TTL);
    expect(pending()).toHaveLength(3);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: "account200", servedAt: 200 });
    expect(readFileSync(readerMarker("a"), "utf8")).toContain("issue-183-reader");
    // The same marker left by a reader that died does not hold anything up, and goes.
    announce("a", DEAD_PID);
    recordSessionPin(file, "a", "account300", 300, TTL);
    expect(pending().filter((name) => name.includes(sessionKey("a")))).toHaveLength(1);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: "account300", servedAt: 300 });
    expect(readerFiles()).toEqual([]);
    expect(sessionLocks()).toEqual([]);
  }, 30_000);

  test("a read ends after four listings even when files are removed by something that follows no rule", () => {
    parkDirect("a", "account400", 400);
    let listings = 0;
    const pin = readSessionPin(file, "a", 500, TTL, {
      afterParkedList: () => {
        listings++;
        // Not a parker: the listed file is deleted outright and an older one put in its place.
        for (const name of pending()) rmSync(join(dir, "state", name));
        parkDirect("a", `account${400 - listings}`, 400 - listings);
      },
    });
    expect(listings).toBe(4);
    expect(pin).toBeUndefined();
    expect(readerFiles()).toEqual([]);
    expect(readSessionPin(file, "a", 500, TTL)).toEqual({ account: "account396", servedAt: 396 });
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

  test("a read does not wait for the session's lock: with it held, a file folded under the read is found in the store at once", () => {
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
    // The only wait in here is none: the fold in the hook takes the freed store lock at its first try.
    expect(Date.now() - started).toBeLessThan(900);
    expect(pending()).toEqual([]);
    expect(readerFiles()).toEqual([]);
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
    // "hot" was not trimmed (its parks found its lock busy), so it has five parked pins, all newer than the rest.
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
