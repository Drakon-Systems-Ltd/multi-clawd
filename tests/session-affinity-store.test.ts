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
});
