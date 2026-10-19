import { describe, expect, test } from "vitest";
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  AUTH_PROOF_FRESH_MS,
  CLAUDE_KEYCHAIN_SERVICE,
  assessAccountCredential,
  claudeKeychainAccount,
  createRefProbeTracker,
  judgeOauthCredential,
  keychainServiceForConfigDir,
  parseOauthCredential,
  type CredentialIo,
} from "../src/login-health";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
// Fake token strings. Assertions below prove they never reach any output.
const ACCESS = "fake-access-token-value";
const REFRESH = "fake-refresh-token-value";

function cred(o: { expiresAt?: number; accessToken?: string; refreshToken?: string } = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: o.accessToken ?? ACCESS,
      refreshToken: o.refreshToken ?? REFRESH,
      ...(o.expiresAt === undefined ? {} : { expiresAt: o.expiresAt }),
      scopes: ["user:inference"],
    },
  });
}

function io(overrides: Partial<CredentialIo>): CredentialIo {
  return {
    readFile: () => {
      throw new Error("no file");
    },
    expandHome: (p) => p.replace(/^~/, "/home/example"),
    readKeychainItem: () => ({ status: "absent" }),
    keychainAccount: "example-user",
    platform: "darwin",
    ...overrides,
  };
}

/** A keychain holding exactly the given (service, account) → data items. */
function keychain(items: Record<string, string>): CredentialIo["readKeychainItem"] {
  return (service, account) => {
    const data = items[`${service}|${account}`];
    return data === undefined ? { status: "absent" } : { status: "found", data };
  };
}

function noSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
}

describe("assessAccountCredential", () => {
  test("token-file account with a plausible token is ok", () => {
    const result = assessAccountCredential(
      { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
      io({ readFile: () => "sk-ant-oat01-abc" }),
    );
    expect(result.status).toBe("ok");
  });

  test("token-file account with empty or junk content is broken", () => {
    expect(
      assessAccountCredential(
        { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
        io({ readFile: () => "   " }),
      ).status,
    ).toBe("broken");
    expect(
      assessAccountCredential(
        { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
        io({ readFile: () => "pbpaste > ~/.claw2/oauth-token" }),
      ).status,
    ).toBe("broken");
  });

  test("token-file account with unreadable file is broken", () => {
    const result = assessAccountCredential(
      { id: "claw2", oauthTokenFile: "~/.claw2/oauth-token" },
      io({}),
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("unreadable");
  });

  test("native macOS account with an unexpired access token is ok", () => {
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: keychain({
          [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: NOW + 4 * HOUR }),
        }),
      }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("valid until");
    expect(result.expiresAt).toBe(NOW + 4 * HOUR);
    noSecrets(result);
  });

  test("an existing item holding an expired, unproven token is NOT alive", () => {
    // The bug: a presence check read this as "credential source looks alive"
    // while every real turn failed "OAuth session expired".
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: keychain({
          [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: NOW - 3 * HOUR }),
        }),
      }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("unverified");
    expect(result.reason).toContain("expired");
    expect(result.reason).toContain("no successful turn since");
    noSecrets(result);
  });

  test("expired but proven by a successful turn after expiry is ok", () => {
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: keychain({
          [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: NOW - 3 * HOUR }),
        }),
      }),
      { nowMs: NOW, proof: { lastSuccessAt: NOW - 1 * HOUR } },
    );
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("proves the refresh works");
  });

  test("a success from BEFORE the expiry proves nothing about the refresh", () => {
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: keychain({
          [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: NOW - 3 * HOUR }),
        }),
      }),
      { nowMs: NOW, proof: { lastSuccessAt: NOW - 4 * HOUR } },
    );
    expect(result.status).toBe("unverified");
  });

  test("the keychain is read under the CLI's account, never by service alone", () => {
    // A stale duplicate under another acct must not stand in for the CLI's own item.
    const reads: Array<[string, string]> = [];
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: (service, account) => {
          reads.push([service, account]);
          return keychain({
            [`${CLAUDE_KEYCHAIN_SERVICE}|unknown`]: cred({ expiresAt: NOW + 4 * HOUR }),
            [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: NOW - 3 * HOUR }),
          })(service, account);
        },
      }),
      { nowMs: NOW },
    );
    expect(reads).toEqual([[CLAUDE_KEYCHAIN_SERVICE, "example-user"]]);
    expect(result.status).toBe("unverified");
  });

  test("expired with no refresh token is broken", () => {
    const result = judgeOauthCredential(
      { hasAccessToken: true, hasRefreshToken: false, expiresAt: NOW - HOUR },
      "keychain",
      {},
      NOW,
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("no refresh token");
  });

  test("proof older than the freshness bound proves nothing", () => {
    const result = judgeOauthCredential(
      { hasAccessToken: true, hasRefreshToken: true, expiresAt: NOW - 2 * AUTH_PROOF_FRESH_MS },
      "keychain",
      { lastSuccessAt: NOW - AUTH_PROOF_FRESH_MS - MIN },
      NOW,
    );
    expect(result.status).toBe("unverified");
  });

  test("a token inside the expiry skew counts as expired", () => {
    const result = judgeOauthCredential(
      { hasAccessToken: true, hasRefreshToken: true, expiresAt: NOW + ACCESS_TOKEN_EXPIRY_SKEW_MS / 2 },
      "keychain",
      {},
      NOW,
    );
    expect(result.status).toBe("unverified");
  });

  test("a credential recording no expiry stays unverified: no success can be placed after it", () => {
    const meta = { hasAccessToken: true, hasRefreshToken: true };
    expect(judgeOauthCredential(meta, "f", {}, NOW).status).toBe("unverified");
    expect(judgeOauthCredential(meta, "f", { lastSuccessAt: NOW - HOUR }, NOW).status).toBe("unverified");
  });

  test("an item that exists but cannot be read is unknown — not missing, and the file is not judged instead", () => {
    const read: string[] = [];
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: () => ({ status: "unreadable" }),
        readFile: (p) => {
          read.push(p);
          return cred({ expiresAt: NOW + HOUR });
        },
      }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("could not be read");
    expect(result.reason).not.toContain("has no Claude Code credentials");
    expect(read).toEqual([]);
  });

  test("an expiry past year 9999 is garbage, not an expiry", () => {
    expect(parseOauthCredential(cred({ expiresAt: 2.6e14 }))?.expiresAt).toBeUndefined();
  });

  test("a malformed expiry is ignored rather than thrown on", () => {
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readKeychainItem: keychain({
          [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: cred({ expiresAt: 1e20 }),
        }),
      }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("unverified");
    expect(result.expiresAt).toBeUndefined();
  });

  test("native macOS account with no keychain item falls back to the file, as the CLI does", () => {
    const read: string[] = [];
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({
        readFile: (p) => {
          read.push(p);
          return cred({ expiresAt: NOW + HOUR });
        },
      }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("ok");
    expect(read).toEqual(["~/.claude/.credentials.json"]);
  });

  test("native macOS account with neither item nor file is broken", () => {
    const result = assessAccountCredential({ id: "claw1", native: true }, io({}), { nowMs: NOW });
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("keychain has no Claude Code credentials for the default login");
  });

  test("a keychain item that is not a Claude credential is broken", () => {
    const result = assessAccountCredential(
      { id: "claw1", native: true },
      io({ readKeychainItem: keychain({ [`${CLAUDE_KEYCHAIN_SERVICE}|example-user`]: "garbage" }) }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("broken");
  });

  test("native/configDir Linux account judges credentials.json on expiry", () => {
    const good = cred({ expiresAt: NOW + HOUR });
    expect(
      assessAccountCredential(
        { id: "claw3", configDir: "~/.claw3" },
        io({ platform: "linux", readFile: () => good }),
        { nowMs: NOW },
      ).status,
    ).toBe("ok");
    const blank = JSON.stringify({ claudeAiOauth: { accessToken: "" } });
    const result = assessAccountCredential(
      { id: "claw3", configDir: "~/.claw3" },
      io({ platform: "linux", readFile: () => blank }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("blank");
  });

  /**
   * On macOS, Claude Code 2.1.x keeps a non-default-dir login in the keychain
   * (service `Claude Code-credentials-<sha256(absDir)[:8]>`) and writes no
   * .credentials.json. Checking only the file reported a working login as
   * dead on every doctor run and gateway start.
   */
  test("configDir macOS account reads its per-dir keychain item, hashed from the ABSOLUTE dir", () => {
    const service = keychainServiceForConfigDir("/home/example/.claw2");
    const result = assessAccountCredential(
      { id: "claw2", configDir: "~/.claw2" },
      io({ readKeychainItem: keychain({ [`${service}|example-user`]: cred({ expiresAt: NOW + HOUR }) }) }),
      { nowMs: NOW },
    );
    expect(result.status).toBe("ok");
    expect(result.source).toBe(`keychain "${service}"`);
  });

  test("configDir macOS account falls back to credentials.json when the keychain has nothing", () => {
    expect(
      assessAccountCredential(
        { id: "claw2", configDir: "~/.claw2" },
        io({ readFile: () => cred({ expiresAt: NOW + HOUR }) }),
        { nowMs: NOW },
      ).status,
    ).toBe("ok");
  });

  test("configDir macOS account with neither keychain item nor file names both sources", () => {
    const result = assessAccountCredential({ id: "claw2", configDir: "~/.claw2" }, io({}));
    expect(result.status).toBe("broken");
    expect(result.reason).toContain("keychain has no Claude Code credentials for ~/.claw2");
    expect(result.reason).toContain(".credentials.json unreadable");
  });

  test("configDir Linux account never consults the keychain", () => {
    const result = assessAccountCredential(
      { id: "claw2", configDir: "~/.claw2" },
      io({
        platform: "linux",
        readKeychainItem: () => {
          throw new Error("keychain probed on linux");
        },
      }),
    );
    expect(result.status).toBe("broken");
    expect(result.reason).toBe("~/.claw2/.credentials.json unreadable");
  });

  test("keychainServiceForConfigDir matches the CLI's per-dir service name", () => {
    // first 8 hex chars of sha256 over the resolved path
    expect(keychainServiceForConfigDir("/Users/example/.claw2")).toBe("Claude Code-credentials-618edf7f");
    expect(keychainServiceForConfigDir("/Users/example/.claw2")).not.toBe(
      keychainServiceForConfigDir("/Users/example/.claw3"),
    );
  });

  test("ref-based accounts are unknown to the sync check (probed async elsewhere)", () => {
    expect(
      assessAccountCredential(
        { id: "claw2", oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://x/y/z" } },
        io({}),
      ).status,
    ).toBe("unknown");
  });
});

describe("parseOauthCredential", () => {
  test("keeps metadata only — token strings never leave it", () => {
    const meta = parseOauthCredential(cred({ expiresAt: NOW }));
    expect(meta).toEqual({ hasAccessToken: true, hasRefreshToken: true, expiresAt: NOW });
    noSecrets(meta);
  });

  test("reads hex-encoded keychain data", () => {
    const hex = Buffer.from(cred({ expiresAt: NOW }), "utf8").toString("hex");
    expect(parseOauthCredential(hex)?.expiresAt).toBe(NOW);
  });

  test("tolerates an expiry in seconds", () => {
    expect(parseOauthCredential(cred({ expiresAt: NOW / 1000 }))?.expiresAt).toBe(NOW);
  });

  test("anything that is not a claudeAiOauth credential is undefined", () => {
    expect(parseOauthCredential("not json")).toBeUndefined();
    expect(parseOauthCredential(JSON.stringify({ other: 1 }))).toBeUndefined();
  });
});

describe("claudeKeychainAccount mirrors the Claude CLI's user-name rule", () => {
  test("$USER first", () => {
    expect(claudeKeychainAccount({ USER: "alice" }, () => ({ username: "bob" }))).toBe("alice");
  });
  test("the OS user name when $USER is unset or empty", () => {
    expect(claudeKeychainAccount({}, () => ({ username: "bob" }))).toBe("bob");
    expect(claudeKeychainAccount({ USER: "" }, () => ({ username: "bob" }))).toBe("bob");
  });
  test("a fixed fallback when the OS lookup throws", () => {
    expect(
      claudeKeychainAccount({}, () => {
        throw new Error("no passwd entry");
      }),
    ).toBe("claude-code-user");
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

  /**
   * A broken verdict is not one thing. The 8 Aug case was a box-wide network
   * outage: every probe threw, the streak matured, and the account was declared
   * dead — but its credential was fine and rotating away from it would have
   * helped nothing. So the verdict has to say WHICH evidence broke it, because
   * only credential evidence may change account selection.
   */
  test("empty_result breaks with cause `credential`", () => {
    const tracker = createRefProbeTracker();
    expect(tracker.observe({ failure: "empty_result" }, 0)).toMatchObject({
      status: "broken",
      cause: "credential",
    });
  });

  test("a matured provider-error streak breaks with cause `provider`, not `credential`", () => {
    const tracker = createRefProbeTracker();
    tracker.observe({ failure: "provider_error" }, 0);
    tracker.observe({ failure: "provider_error" }, 5 * MIN);
    expect(tracker.observe({ failure: "provider_error" }, 11 * MIN)).toMatchObject({
      status: "broken",
      cause: "provider",
    });
  });

  test("an empty_result after provider errors still breaks immediately (credential problem)", () => {
    const tracker = createRefProbeTracker();
    tracker.observe({ failure: "provider_error" }, 0);
    const out = tracker.observe({ failure: "empty_result" }, 30 * 1000);
    expect(out.status).toBe("broken");
    expect(out.reason).toContain("credential problem");
  });
});
