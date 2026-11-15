import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { launchSessionId, readSessionPin, recordSessionPin } from "../src/session-affinity.js";

// #186: a session id may be any name launchSessionId accepts, including the
// names every plain object inherits. A pin dictionary must treat those like
// any other id: v2.7.2 stored and read them, and a lookup that finds an
// inherited function instead of "no pin" drops the pin without an error.
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-affinity-proto-"));
  file = join(dir, "state", "pool-clawd.sessions.json");
  mkdirSync(join(dir, "state"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const IDS = ["constructor", "toString", "hasOwnProperty", "valueOf"] as const;
const TTL = 100_000;
/** The store lock named for this live process: it is never reclaimed, so every write parks. */
const holdStoreLock = () => writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()} issue-186-live-holder\n`);
const pending = () => readdirSync(join(dir, "state")).filter((name) => name.includes(".pending-"));
const leftovers = () => readdirSync(join(dir, "state")).filter((name) =>
  name.endsWith(".lock") || name.includes(".tmp-") || name.includes(".pending-"));
const stored = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const own = (pins: Record<string, unknown>, id: string) =>
  Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : undefined;

describe("session ids named like Object.prototype members (#186)", () => {
  test.each(IDS)("%s is an accepted session id", (id) => {
    expect(launchSessionId(["--session-id", id])).toBe(id);
    expect(launchSessionId([`--resume=${id}`])).toBe(id);
  });

  test.each(IDS)("%s: a read with no store and no parked file is undefined, never a function", (id) => {
    const pin = readSessionPin(file, id, 100, TTL);
    expect(typeof pin).toBe("undefined");
    expect(pin).toBeUndefined();
  });

  test.each(IDS)("%s: a read over a store without that id, or one that cannot be read, is undefined", (id) => {
    writeFileSync(file, JSON.stringify({ other: { account: "claw1", servedAt: 50 } }));
    expect(readSessionPin(file, id, 100, TTL)).toBeUndefined();
    writeFileSync(file, "{broken");
    expect(readSessionPin(file, id, 100, TTL)).toBeUndefined();
  });

  test.each(IDS)("%s: a plain record is stored and read back", (id) => {
    recordSessionPin(file, id, "claw2", 100, TTL);
    expect(own(stored(), id)).toEqual({ account: "claw2", servedAt: 100 });
    expect(readSessionPin(file, id, 100, TTL)).toEqual({ account: "claw2", servedAt: 100 });
    // The usual ordering still holds for it: a later pin replaces, an earlier one does not.
    recordSessionPin(file, id, "claw3", 200, TTL);
    recordSessionPin(file, id, "claw1", 150, TTL);
    expect(readSessionPin(file, id, 200, TTL)).toEqual({ account: "claw3", servedAt: 200 });
    expect(Object.keys(stored())).toEqual([id]);
    expect(leftovers()).toEqual([]);
  });

  test("each of them, parked while the store lock is held, is read back from its parked file", () => {
    holdStoreLock();
    for (const [i, id] of IDS.entries()) recordSessionPin(file, id, `claw${i}`, 100 + i, TTL);
    expect(pending()).toHaveLength(IDS.length);
    for (const [i, id] of IDS.entries()) {
      expect(readSessionPin(file, id, 200, TTL)).toEqual({ account: `claw${i}`, servedAt: 100 + i });
    }
  }, 30_000);

  test("each of them, parked again, keeps one parked file holding its latest pin", () => {
    holdStoreLock();
    for (const id of IDS) recordSessionPin(file, id, "first", 100, TTL);
    for (const id of IDS) recordSessionPin(file, id, "second", 200, TTL);
    expect(pending()).toHaveLength(IDS.length);
    for (const id of IDS) expect(readSessionPin(file, id, 200, TTL)).toEqual({ account: "second", servedAt: 200 });
  }, 30_000);

  test("each of them, parked and then folded, is in the store and its parked file is gone", () => {
    holdStoreLock();
    for (const [i, id] of IDS.entries()) recordSessionPin(file, id, `claw${i}`, 100 + i, TTL);
    rmSync(`${file}.lock`);
    recordSessionPin(file, "other", "claw9", 200, TTL);
    const pins = stored();
    for (const [i, id] of IDS.entries()) {
      expect(own(pins, id)).toEqual({ account: `claw${i}`, servedAt: 100 + i });
      expect(readSessionPin(file, id, 200, TTL)).toEqual({ account: `claw${i}`, servedAt: 100 + i });
    }
    expect(Object.keys(pins).sort()).toEqual([...IDS, "other"].sort());
    expect(leftovers()).toEqual([]);
  }, 30_000);

  test("a parked pin replaces a stored one of the same id only when it was served later", () => {
    for (const id of IDS) recordSessionPin(file, id, "stored", 150, TTL);
    holdStoreLock();
    recordSessionPin(file, "constructor", "later", 200, TTL);
    recordSessionPin(file, "toString", "earlier", 100, TTL);
    expect(readSessionPin(file, "constructor", 200, TTL)).toEqual({ account: "later", servedAt: 200 });
    expect(readSessionPin(file, "toString", 200, TTL)).toEqual({ account: "stored", servedAt: 150 });
    rmSync(`${file}.lock`);
    recordSessionPin(file, "other", "claw9", 200, TTL);
    const pins = stored();
    expect(own(pins, "constructor")).toEqual({ account: "later", servedAt: 200 });
    expect(own(pins, "toString")).toEqual({ account: "stored", servedAt: 150 });
    expect(own(pins, "valueOf")).toEqual({ account: "stored", servedAt: 150 });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});
