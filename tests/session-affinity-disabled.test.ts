import { expect, test } from "vitest";
import { eligibleSessionAccount } from "../src/session-affinity.js";

test("a saved pin cannot resume onto a disabled member absent from the enabled roster", () => {
  expect(eligibleSessionAccount(
    { account: "claw2", servedAt: Date.now() }, "claw1",
    [{ id: "claw1", verdict: "ok" }], ["claw1"],
  )).toBeUndefined();
});
