import { describe, expect, test } from "vitest";
import { checkAccountCredential, type CredentialIo } from "../src/login-health";

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
