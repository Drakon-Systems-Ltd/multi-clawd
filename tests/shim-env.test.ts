import { afterEach, describe, expect, test } from "vitest";
import { cleanShimEnv } from "./shim-env";

const TOUCHED = [
  "MULTI_CLAWD_SESSION_DIRS",
  "MULTI_CLAWD_ACCOUNT_ID",
  "MULTI_CLAWD_RETRY_ACCOUNTS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_SESSION_ID",
];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe("cleanShimEnv", () => {
  test("strips the live pool's own steering vars", () => {
    // The suite may be run BY a multi-clawd-managed session, whose env carries
    // all of these. Inheriting them pointed a spawned shim at the operator's
    // real config dirs and made a handover test copy a genuine transcript.
    for (const key of TOUCHED) process.env[key] = "live-value";
    const env = cleanShimEnv();
    for (const key of TOUCHED) expect(env[key]).toBeUndefined();
  });

  test("keeps everything else, and overrides win", () => {
    process.env.MULTI_CLAWD_ACCOUNT_ID = "live-account";
    const env = cleanShimEnv({ MULTI_CLAWD_ACCOUNT_ID: "claw1" });
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
    expect(env.PATH).toBe(process.env.PATH);
  });
});
