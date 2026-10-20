import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (let i = 0; i <= MAX_SESSION_PINS; i++) {
      recordSessionPin(file, `s${i}`, "claw1", now + i, 100_000);
    }
    const pins = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(pins)).toHaveLength(MAX_SESSION_PINS);
    expect(pins.s0).toBeUndefined();
    expect(pins.s1000.account).toBe("claw1");
  });
});
