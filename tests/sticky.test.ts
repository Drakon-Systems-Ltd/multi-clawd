import { describe, expect, test } from "vitest";
import { decideStickySelection, type StickyEntry } from "../src/sticky";
import type { HealthVerdict } from "../src/health";

const NOW = 1_784_200_000_000;
const DWELL = 10 * 60 * 1000;

function decide(
  verdicts: Array<[string, HealthVerdict]>,
  sticky?: StickyEntry,
  nowMs = NOW,
) {
  return decideStickySelection({
    verdicts: verdicts.map(([id, verdict]) => ({ id, verdict })),
    sticky,
    nowMs,
    minDwellMs: DWELL,
  });
}

describe("decideStickySelection", () => {
  test("home healthy, no sticky: run home, no sticky needed", () => {
    const d = decide([["claw1", "ok"], ["claw2", "ok"]]);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("home near-limit: rotate away and stick to the target", () => {
    const d = decide([["claw1", "near_limit"], ["claw2", "ok"]]);
    expect(d.account).toBe("claw2");
    expect(d.sticky).toEqual({ account: "claw2", since: NOW });
  });

  test("stuck away, home recovered but dwell not elapsed: stay on sticky", () => {
    const sticky = { account: "claw2", since: NOW - DWELL / 2 };
    const d = decide([["claw1", "ok"], ["claw2", "ok"]], sticky);
    expect(d.account).toBe("claw2");
    expect(d.sticky).toEqual(sticky);
  });

  test("stuck away, home recovered and dwell elapsed: return home, clear sticky", () => {
    const sticky = { account: "claw2", since: NOW - DWELL - 1 };
    const d = decide([["claw1", "ok"], ["claw2", "ok"]], sticky);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("health beats dwell: sticky account degrades while home is fine — go home immediately", () => {
    const sticky = { account: "claw2", since: NOW - 1000 };
    const d = decide([["claw1", "ok"], ["claw2", "near_limit"]], sticky);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("sticky and home both bad: move to the next usable account and re-stick", () => {
    const sticky = { account: "claw2", since: NOW - 1000 };
    const d = decide(
      [["claw1", "exhausted"], ["claw2", "exhausted"], ["claw3", "ok"]],
      sticky,
    );
    expect(d.account).toBe("claw3");
    expect(d.sticky).toEqual({ account: "claw3", since: NOW });
  });

  test("whole pool exhausted: home account, sticky cleared", () => {
    const sticky = { account: "claw2", since: NOW - 1000 };
    const d = decide([["claw1", "exhausted"], ["claw2", "exhausted"]], sticky);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("sticky pointing at an account no longer in the pool is ignored", () => {
    const sticky = { account: "gone", since: NOW - 1000 };
    const d = decide([["claw1", "ok"], ["claw2", "ok"]], sticky);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("home has no data while sticky is healthy: honor the sticky through dwell", () => {
    const sticky = { account: "claw2", since: NOW - 1000 };
    const d = decide([["claw1", "no_data"], ["claw2", "ok"]], sticky);
    expect(d.account).toBe("claw2");
    expect(d.sticky).toEqual(sticky);
  });
});

describe("credential-broken members (#8)", () => {
  test("a dead login on home rotates away and sticks, exactly like near_limit", () => {
    const d = decide([["claw1", "credential_failed"], ["claw2", "ok"]]);
    expect(d.account).toBe("claw2");
    expect(d.sticky).toEqual({ account: "claw2", since: NOW });
  });

  test("re-authenticating home restores normal return-home once dwell elapses", () => {
    // Rotation happened because claw1's login was rejected...
    const rotated = decide([["claw1", "credential_failed"], ["claw2", "ok"]]);
    expect(rotated.account).toBe("claw2");
    // ...a successful run / `multi-clawd login claw1` clears the exclusion, so
    // claw1 classifies healthy again. Dwell still governs the benign direction:
    // no snap-back mid-dwell, return home after it.
    const midDwell = decide(
      [["claw1", "ok"], ["claw2", "ok"]],
      rotated.sticky,
      NOW + DWELL / 2,
    );
    expect(midDwell.account).toBe("claw2");
    const afterDwell = decide(
      [["claw1", "ok"], ["claw2", "ok"]],
      rotated.sticky,
      NOW + DWELL + 1,
    );
    expect(afterDwell.account).toBe("claw1");
    expect(afterDwell.sticky).toBeUndefined();
  });

  test("health beats dwell for credentials too: a sticky whose login dies is abandoned", () => {
    const sticky = { account: "claw2", since: NOW - 1000 };
    const d = decide([["claw1", "ok"], ["claw2", "credential_failed"]], sticky);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });

  test("nothing usable: run on the member that can at least authenticate", () => {
    // claw1's login is dead, claw2 is merely out of quota. Launching on claw1
    // would produce an auth error that says nothing about the real problem and
    // that the degrade ladder cannot act on; claw2 fails with the true quota
    // error instead.
    const d = decide([["claw1", "credential_failed"], ["claw2", "exhausted"]]);
    expect(d.account).toBe("claw2");
    expect(d.sticky).toBeUndefined();
  });

  test("every login dead: falls back to home (the pool raises the hard auth error)", () => {
    const d = decide([["claw1", "credential_failed"], ["claw2", "credential_failed"]]);
    expect(d.account).toBe("claw1");
    expect(d.sticky).toBeUndefined();
  });
});
