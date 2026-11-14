import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  eligibleSessionAccount, launchSessionId, MAX_SESSION_PINS, readSessionPin, recordSessionPin,
} from "../src/session-affinity.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-affinity-store-"));
  file = join(dir, "state", "pool-clawd.sessions.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session affinity state", () => {
  test("CLI argv supplies either fresh or resumed session ids", () => {
    expect(launchSessionId(["--session-id", "a"])).toBe("a");
    expect(launchSessionId(["--resume=b"])).toBe("b");
    expect(launchSessionId(["-p"])).toBeUndefined();
    expect(launchSessionId(["--session-id", "../bad"])).toBeUndefined();
  });

  test("healthy current member wins, unhealthy or removed member loses", () => {
    const pin = { account: "claw2", servedAt: 1 };
    const verdicts = [{ id: "claw1", verdict: "ok" }, { id: "claw2", verdict: "no_data" }];
    expect(eligibleSessionAccount(pin, "claw1", verdicts, ["claw2"])).toBe("claw2");
    expect(eligibleSessionAccount(pin, "claw1", [{ ...verdicts[1], verdict: "near_limit" }], ["claw2"])).toBeUndefined();
    expect(eligibleSessionAccount(pin, "claw1", verdicts, [])).toBeUndefined();
  });

  test("missing, expired, and corrupt files act as no pin", () => {
    expect(readSessionPin(file, "a", 200, 100)).toBeUndefined();
    recordSessionPin(file, "a", "claw2", 10, 100);
    expect(readSessionPin(file, "a", 200, 100)).toBeUndefined();
    writeFileSync(file, "{broken");
    expect(readSessionPin(file, "a", 20, 100)).toBeUndefined();
    recordSessionPin(file, "a", "claw1", 20, 100);
    expect(readSessionPin(file, "a", 20, 100)?.account).toBe("claw1");
  });

  test("successful replacement refreshes pin and oldest entries are pruned", () => {
    recordSessionPin(file, "a", "claw2", 10, 100_000);
    recordSessionPin(file, "a", "claw1", 20, 100_000);
    expect(readSessionPin(file, "a", 20, 100_000)?.account).toBe("claw1");
    const now = 10_000;
    const seeded = Object.fromEntries(Array.from({ length: MAX_SESSION_PINS }, (_, i) =>
      [`s${i}`, { account: "claw1", servedAt: now + i }]));
    writeFileSync(file, JSON.stringify(seeded));
    recordSessionPin(file, "new", "claw1", now + MAX_SESSION_PINS, 100_000);
    const pins = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(pins)).toHaveLength(MAX_SESSION_PINS);
    expect(pins.s0).toBeUndefined();
    expect(pins.new.account).toBe("claw1");
  });

  // A lock file is whatever a concurrent shim's turn left there. "held" has
  // no pid to probe, so it stays held until the test removes it.
  const holdLock = () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(`${file}.lock`, "held");
  };
  const leftovers = () => readdirSync(join(dir, "state")).filter((name) =>
    name.endsWith(".lock") || name.includes(".tmp-") || name.includes(".pending-"));

  test("a write that cannot take the lock keeps its pin, and the next write folds it into the store", () => {
    holdLock();
    expect(() => recordSessionPin(file, "blocked", "claw1", 10, 100)).not.toThrow();
    // The store was not replaced by a writer that did not hold the lock.
    expect(existsSync(file)).toBe(false);
    // The pin is not lost: the next turn of that session reads it.
    expect(readSessionPin(file, "blocked", 10, 100)).toEqual({ account: "claw1", servedAt: 10 });
    rmSync(`${file}.lock`);
    recordSessionPin(file, "first", "claw1", 10, 100);
    recordSessionPin(file, "second", "claw2", 20, 100);
    const pins = JSON.parse(readFileSync(file, "utf8"));
    expect(pins.blocked).toEqual({ account: "claw1", servedAt: 10 });
    expect(pins.first.account).toBe("claw1");
    expect(pins.second.account).toBe("claw2");
    expect(leftovers()).toEqual([]);
  });

  test("a parked pin moves a session only when it was served later than the stored pin", () => {
    recordSessionPin(file, "moved", "claw1", 10, 1000);
    recordSessionPin(file, "kept", "claw1", 50, 1000);
    holdLock();
    recordSessionPin(file, "moved", "claw2", 30, 1000);
    recordSessionPin(file, "kept", "claw2", 40, 1000);
    expect(readSessionPin(file, "moved", 60, 1000)).toEqual({ account: "claw2", servedAt: 30 });
    expect(readSessionPin(file, "kept", 60, 1000)).toEqual({ account: "claw1", servedAt: 50 });
    rmSync(`${file}.lock`);
    recordSessionPin(file, "other", "claw3", 60, 1000);
    const pins = JSON.parse(readFileSync(file, "utf8"));
    expect(pins.moved).toEqual({ account: "claw2", servedAt: 30 });
    expect(pins.kept).toEqual({ account: "claw1", servedAt: 50 });
    expect(leftovers()).toEqual([]);
  }, 10_000);

  test("a parked file left behind after its fold is applied again without effect", () => {
    holdLock();
    recordSessionPin(file, "a", "claw1", 10, 1000);
    const parked = readdirSync(join(dir, "state")).filter((name) => name.includes(".pending-"));
    expect(parked).toHaveLength(1);
    const copy = readFileSync(join(dir, "state", parked[0]), "utf8");
    rmSync(`${file}.lock`);
    recordSessionPin(file, "a", "claw2", 20, 1000);
    // A holder that stopped after its replace leaves the parked file in place.
    writeFileSync(join(dir, "state", parked[0]), copy);
    expect(readSessionPin(file, "a", 20, 1000)).toEqual({ account: "claw2", servedAt: 20 });
    recordSessionPin(file, "b", "claw1", 20, 1000);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: "claw2", servedAt: 20 });
    expect(leftovers()).toEqual([]);
  });

  test("a reader whose parked file is folded and removed under it still finds the pin in the store", () => {
    holdLock();
    recordSessionPin(file, "a", "claw1", 10, 1000);
    rmSync(`${file}.lock`);
    // Enumerated-then-gone is the other order: the fold lands first, so the
    // reader's parked list is empty and the store it opens next has the pin.
    const pin = readSessionPin(file, "a", 10, 1000, {
      afterParked: () => recordSessionPin(file, "b", "claw2", 10, 1000),
    });
    expect(pin).toEqual({ account: "claw1", servedAt: 10 });
    expect(leftovers()).toEqual([]);
  });

  test("an expired or malformed parked file is no pin and is cleared by the next write", () => {
    holdLock();
    recordSessionPin(file, "old", "claw1", 10, 100);
    const [name] = readdirSync(join(dir, "state")).filter((entry) => entry.includes(".pending-"));
    writeFileSync(join(dir, "state", name.replace(/[0-9a-f]{12}$/, "0123456789ab")), "{broken");
    rmSync(`${file}.lock`);
    expect(readSessionPin(file, "old", 500, 100)).toBeUndefined();
    recordSessionPin(file, "new", "claw2", 500, 100);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ new: { account: "claw2", servedAt: 500 } });
    expect(leftovers()).toEqual([]);
  });

  test("a store that exists and cannot be read is left alone and the pin is parked", () => {
    mkdirSync(file, { recursive: true });
    recordSessionPin(file, "a", "claw1", 10, 100);
    expect(readdirSync(file)).toEqual([]);
    expect(readSessionPin(file, "a", 10, 100)).toEqual({ account: "claw1", servedAt: 10 });
    expect(readdirSync(join(dir, "state")).filter((name) => name.endsWith(".lock") || name.includes(".tmp-"))).toEqual([]);
  });

  // The lock names this test process, which is alive: no waiter may reclaim
  // it, however long it is held (#151). This is the starvation the reviews of
  // #179 probed with.
  const holdLiveLock = () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()} review-179-live-holder\n`);
  };
  const pending = () => readdirSync(join(dir, "state")).filter((name) => name.includes(".pending-")).sort();

  test("a delayed older writer does not replace a newer stored pin", () => {
    recordSessionPin(file, "a", "claw2", 200, 1000);
    recordSessionPin(file, "a", "claw1", 100, 1000);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: "claw2", servedAt: 200 });
    expect(readSessionPin(file, "a", 200, 1000)).toEqual({ account: "claw2", servedAt: 200 });
    expect(leftovers()).toEqual([]);
  });

  test("a delayed older writer does not replace a newer parked pin that was already folded and removed", () => {
    holdLiveLock();
    recordSessionPin(file, "a", "claw2", 200, 1000);
    expect(pending()).toHaveLength(1);
    rmSync(`${file}.lock`);
    // Another session's write folds the parked pin in and removes its file.
    recordSessionPin(file, "b", "claw3", 200, 1000);
    expect(pending()).toEqual([]);
    // The writer that was served earlier arrives last.
    recordSessionPin(file, "a", "claw1", 100, 1000);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: "claw2", servedAt: 200 });
    expect(readSessionPin(file, "a", 200, 1000)).toEqual({ account: "claw2", servedAt: 200 });
    expect(leftovers()).toEqual([]);
  });

  test("a delayed older writer that has to park does not hide a newer parked pin", () => {
    holdLiveLock();
    recordSessionPin(file, "a", "claw2", 200, 1000);
    recordSessionPin(file, "a", "claw1", 100, 1000);
    expect(readSessionPin(file, "a", 200, 1000)).toEqual({ account: "claw2", servedAt: 200 });
    // One parked file per session: the superseded one is gone.
    expect(pending()).toHaveLength(1);
    rmSync(`${file}.lock`);
    recordSessionPin(file, "b", "claw3", 200, 1000);
    expect(JSON.parse(readFileSync(file, "utf8")).a).toEqual({ account: "claw2", servedAt: 200 });
    expect(leftovers()).toEqual([]);
  }, 10_000);

  test("a writer with the same clock reading as the stored pin still refreshes it", () => {
    recordSessionPin(file, "a", "claw2", 100, 1000);
    recordSessionPin(file, "a", "claw1", 100, 1000);
    expect(readSessionPin(file, "a", 100, 1000)).toEqual({ account: "claw1", servedAt: 100 });
  });

  test("a session parked again while the lock stays held keeps one parked file holding its latest pin", () => {
    holdLiveLock();
    recordSessionPin(file, "a", "claw1", 10, 1000);
    recordSessionPin(file, "a", "claw2", 20, 1000);
    recordSessionPin(file, "a", "claw3", 30, 1000);
    recordSessionPin(file, "b", "claw1", 15, 1000);
    expect(pending()).toHaveLength(2);
    expect(readSessionPin(file, "a", 30, 1000)).toEqual({ account: "claw3", servedAt: 30 });
    expect(readSessionPin(file, "b", 30, 1000)).toEqual({ account: "claw1", servedAt: 15 });
    expect(readFileSync(`${file}.lock`, "utf8")).toContain("review-179-live-holder");
  }, 15_000);

  test("parked pins past the TTL are removed by a later starved writer while the lock is still held", () => {
    holdLiveLock();
    recordSessionPin(file, "old1", "claw1", 10, 100);
    recordSessionPin(file, "old2", "claw2", 20, 100);
    recordSessionPin(file, "fresh", "claw3", 90, 100);
    expect(pending()).toHaveLength(3);
    recordSessionPin(file, "late", "claw1", 115, 100);
    // old1 is 105 old (expired); old2 is 95 old and fresh is 25 old (both live).
    expect(pending()).toHaveLength(3);
    expect(readSessionPin(file, "old1", 115, 100)).toBeUndefined();
    expect(readSessionPin(file, "old2", 115, 100)).toEqual({ account: "claw2", servedAt: 20 });
    recordSessionPin(file, "later", "claw2", 500, 100);
    // Everything but the newest pin is past the TTL now, and is gone.
    expect(pending()).toHaveLength(1);
    expect(readSessionPin(file, "later", 500, 100)).toEqual({ account: "claw2", servedAt: 500 });
    expect(readFileSync(`${file}.lock`, "utf8")).toContain("review-179-live-holder");
  }, 15_000);

  // A parked file's name is `<store>.pending-<servedAt>-<session key>-<park
  // time>-<pid>-<sequence>-<random>`. Writing files directly gives a test more
  // parked sessions than it could wait out the lock for.
  const parkDirect = (sessionId: string, account: string, servedAt: number) => {
    const fixed = (value: number, width: number) => String(value).padStart(width, "0");
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    const name = `pool-clawd.sessions.json.pending-${fixed(servedAt, 13)}-${key}-${fixed(servedAt, 13)}-0000004242-000000000-0123456789ab`;
    writeFileSync(join(dir, "state", name), JSON.stringify({ [sessionId]: { account, servedAt } }));
  };

  test("the directly written parked-file name is the one a real park uses", () => {
    holdLiveLock();
    recordSessionPin(file, "real", "claw1", 10, 1000);
    const [real] = pending();
    parkDirect("real", "claw1", 10);
    const direct = pending().find((name) => name !== real)!;
    const shape = (name: string) => name.replace(/\d/g, "0").replace(/[0-9a-f]{12}$/, "r");
    expect(shape(direct)).toBe(shape(real));
    expect(direct.split("-").slice(0, 4)).toEqual(real.split("-").slice(0, 4));
  });

  test("a session's parked pin is found behind any number of other sessions' parked files", () => {
    holdLiveLock();
    writeFileSync(file, JSON.stringify({ target: { account: "claw1", servedAt: 5 } }));
    recordSessionPin(file, "target", "claw2", 10, 100_000);
    recordSessionPin(file, "bare", "claw3", 11, 100_000);
    for (let i = 0; i < 300; i++) parkDirect(`noise${i}`, "claw1", 1000 + i);
    expect(readSessionPin(file, "target", 2000, 100_000)).toEqual({ account: "claw2", servedAt: 10 });
    expect(readSessionPin(file, "bare", 2000, 100_000)).toEqual({ account: "claw3", servedAt: 11 });
    expect(readSessionPin(file, "noise0", 2000, 100_000)).toEqual({ account: "claw1", servedAt: 1000 });
    expect(readSessionPin(file, "noise299", 2000, 100_000)).toEqual({ account: "claw1", servedAt: 1299 });
  }, 10_000);

  test("parked files never exceed the store's own bound, and the least recently served go first", () => {
    holdLiveLock();
    const extra = 5;
    for (let i = 0; i < MAX_SESSION_PINS + extra; i++) parkDirect(`s${i}`, "claw1", 1000 + i);
    recordSessionPin(file, "own", "claw2", 5000, 100_000);
    expect(pending()).toHaveLength(MAX_SESSION_PINS);
    expect(readSessionPin(file, "own", 5000, 100_000)).toEqual({ account: "claw2", servedAt: 5000 });
    expect(readSessionPin(file, `s${extra}`, 5000, 100_000)).toBeUndefined();
    expect(readSessionPin(file, `s${extra + 1}`, 5000, 100_000)).toEqual({ account: "claw1", servedAt: 1000 + extra + 1 });
    expect(readSessionPin(file, `s${MAX_SESSION_PINS + extra - 1}`, 5000, 100_000)?.account).toBe("claw1");
  }, 15_000);

  test("a reader whose parked file is superseded and removed under it finds the newer parked pin", () => {
    holdLiveLock();
    recordSessionPin(file, "a", "claw1", 10, 1000);
    let once = true;
    const pin = readSessionPin(file, "a", 20, 1000, {
      afterParkedList: () => {
        if (!once) return;
        once = false;
        recordSessionPin(file, "a", "claw2", 20, 1000);
      },
    });
    expect(pin).toEqual({ account: "claw2", servedAt: 20 });
    expect(pending()).toHaveLength(1);
  }, 10_000);
});
