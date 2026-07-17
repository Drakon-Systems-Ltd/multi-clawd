import { describe, expect, test } from "vitest";
import { checkAccountCredential, createRefProbeTracker, type CredentialIo } from "../src/login-health";

const MIN = 60 * 1000;

function io(overrides: Partial<CredentialIo>): CredentialIo {
  return {
    readFile: () => {
      throw new Error("no file");
    },
    keychainHasClaudeCredentials: () => false,
    platform: "darwin",
    ...overrides,
  };
}

describe("checkAccountCredential", () => {
  test("token-file account with a plausible token is ok", () => {
    const result = checkAccountCredential(
      { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
      io({ readFile: () => "sk-ant-oat01-abc" }),
    );
    expect(result.status).toBe("ok");
  });

  test("token-file account with empty or junk content is broken", () => {
    expect(
      checkAccountCredential(
        { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
        io({ readFile: () => "   " }),
      ).status,
    ).toBe("broken");
    expect(
      checkAccountCredential(
        { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
        io({ readFile: () => "pbpaste > ~/.claw2/oauth-token" }),
      ).status,
    ).toBe("broken");
  });

  test("token-file account with unreadable file is broken", () => {
    const result = checkAccountCredential(
      { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
      io({}),
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("unreadable");
  });

  test("native macOS account checks the keychain", () => {
    expect(
      checkAccountCredential({ id: "claw1", native: true }, io({ keychainHasClaudeCredentials: () => true })).status,
    ).toBe("ok");
    expect(
      checkAccountCredential({ id: "claw1", native: true }, io({ keychainHasClaudeCredentials: () => false })).status,
    ).toBe("broken");
  });

  test("native/configDir Linux account checks credentials.json access token", () => {
    const good = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-x", expiresAt: 9999999999999 } });
    expect(
      checkAccountCredential(
        { id: "claw3", configDir: "~/.claw3" },
        io({ platform: "linux", readFile: () => good }),
      ).status,
    ).toBe("ok");
    const blank = JSON.stringify({ claudeAiOauth: { accessToken: "" } });
    const result = checkAccountCredential(
      { id: "claw3", configDir: "~/.claw3" },
      io({ platform: "linux", readFile: () => blank }),
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("blank");
  });

  test("ref-based accounts are unknown to the sync check (probed async elsewhere)", () => {
    expect(
      checkAccountCredential(
        { id: "claw2", oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://x/y/z" } },
        io({}),
      ).status,
    ).toBe("unknown");
  });
});

describe("createRefProbeTracker", () => {
  test("empty_result is a credential problem — broken immediately", () => {
    const tracker = createRefProbeTracker();
    const out = tracker.observe({ failure: "empty_result" }, 0);
    expect(out.status).toBe("broken");
    expect(out.reason).toBe("oauthTokenRef resolved to nothing (credential problem)");
  });

  test("a single provider error degrades, does not break", () => {
    const tracker = createRefProbeTracker();
    const out = tracker.observe({ failure: "provider_error" }, 0);
    expect(out.status).toBe("degraded");
    expect(out.reason).toContain("streak 1/3");
  });

  test("three FAST provider errors (under 10min) stay degraded, never broken", () => {
    const tracker = createRefProbeTracker();
    expect(tracker.observe({ failure: "provider_error" }, 0).status).toBe("degraded");
    expect(tracker.observe({ failure: "provider_error" }, 30 * 1000).status).toBe("degraded");
    // third failure, but only ~1 minute since the first — thresholds are AND
    const third = tracker.observe({ failure: "provider_error" }, 60 * 1000);
    expect(third.status).toBe("degraded");
    expect(third.reason).toContain("streak 3/3");
  });

  test("declares broken only at the 3rd consecutive error once >=10min elapsed", () => {
    const tracker = createRefProbeTracker();
    expect(tracker.observe({ failure: "provider_error" }, 0).status).toBe("degraded");
    expect(tracker.observe({ failure: "provider_error" }, 5 * MIN).status).toBe("degraded");
    const out = tracker.observe({ failure: "provider_error" }, 11 * MIN);
    expect(out.status).toBe("broken");
    expect(out.reason).toContain("3+ consecutive");
  });

  test("two errors over 10min are not enough — needs the 3rd consecutive too", () => {
    const tracker = createRefProbeTracker();
    expect(tracker.observe({ failure: "provider_error" }, 0).status).toBe("degraded");
    // 20 minutes elapsed but only the 2nd error — consecutive threshold unmet
    expect(tracker.observe({ failure: "provider_error" }, 20 * MIN).status).toBe("degraded");
  });

  test("a success resets the streak and clears degraded", () => {
    const tracker = createRefProbeTracker();
    tracker.observe({ failure: "provider_error" }, 0);
    tracker.observe({ failure: "provider_error" }, 5 * MIN);
    expect(tracker.observe({ value: "sk-ant-oat01-x" }, 6 * MIN).status).toBe("ok");
    // streak is reset: two fresh fast errors are just degraded again
    expect(tracker.observe({ failure: "provider_error" }, 7 * MIN).status).toBe("degraded");
    const out = tracker.observe({ failure: "provider_error" }, 8 * MIN);
    expect(out.status).toBe("degraded");
    expect(out.reason).toContain("streak 2/3");
  });

  test("recovery from broken returns ok", () => {
    const tracker = createRefProbeTracker();
    tracker.observe({ failure: "provider_error" }, 0);
    tracker.observe({ failure: "provider_error" }, 5 * MIN);
    expect(tracker.observe({ failure: "provider_error" }, 11 * MIN).status).toBe("broken");
    expect(tracker.observe({ value: "sk-ant-oat01-x" }, 12 * MIN).status).toBe("ok");
  });

  test("an empty_result after provider errors still breaks immediately (credential problem)", () => {
    const tracker = createRefProbeTracker();
    tracker.observe({ failure: "provider_error" }, 0);
    const out = tracker.observe({ failure: "empty_result" }, 30 * 1000);
    expect(out.status).toBe("broken");
    expect(out.reason).toContain("credential problem");
  });
});
