import { describe, expect, test } from "vitest";
import {
  describeIdentity,
  findDuplicateLogins,
  formatPlan,
  identityFilePath,
  maskEmail,
  parseIdentityFile,
  resolveAccountIdentity,
  type IdentityIo,
} from "../src/account-identity";

const DEFAULT_DIR = "/home/u/.claude";

function io(files: Record<string, string>): IdentityIo {
  return {
    readFile: (path) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`ENOENT ${path}`);
      return hit;
    },
    expandHome: (p) => (p.startsWith("~/") ? `/home/u/${p.slice(2)}` : p),
    defaultConfigDir: DEFAULT_DIR,
  };
}

function claudeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    userID: "abc",
    oauthAccount: {
      accountUuid: "uuid-1",
      emailAddress: "someone@example.com",
      organizationName: "someone@example.com's Organization",
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
      ...overrides,
    },
  });
}

describe("identityFilePath", () => {
  test("native accounts read the default config dir", () => {
    expect(identityFilePath({ id: "claw1", native: true }, io({}))).toBe(`${DEFAULT_DIR}/.claude.json`);
  });

  test("configDir accounts read their own dir, with ~ expanded", () => {
    expect(identityFilePath({ id: "claw2", configDir: "~/.claude-second" }, io({}))).toBe(
      "/home/u/.claude-second/.claude.json",
    );
  });

  test("token-sourced accounts have no on-disk identity", () => {
    // The token, not the config dir, decides who the child authenticates as —
    // reading the dir would report a login that is not the one being used.
    expect(
      identityFilePath({ id: "claw3", configDir: "~/.claude-second", oauthTokenFile: "~/t" }, io({})),
    ).toBeUndefined();
    expect(identityFilePath({ id: "claw4", oauthTokenRef: { provider: "x" } }, io({}))).toBeUndefined();
  });
});

describe("parseIdentityFile", () => {
  test("extracts uuid, email, org and plan", () => {
    expect(parseIdentityFile(claudeJson())).toEqual({
      accountUuid: "uuid-1",
      email: "someone@example.com",
      organizationName: "someone@example.com's Organization",
      plan: "Max 20x",
    });
  });

  test("unparseable or identity-free files yield undefined", () => {
    expect(parseIdentityFile("{not json")).toBeUndefined();
    expect(parseIdentityFile(JSON.stringify({ userID: "abc" }))).toBeUndefined();
    expect(parseIdentityFile(JSON.stringify({ oauthAccount: { displayName: "X" } }))).toBeUndefined();
  });
});

describe("formatPlan", () => {
  test("maps known tiers and passes unknown ones through", () => {
    expect(formatPlan({ organizationRateLimitTier: "default_claude_max_5x" })).toBe("Max 5x");
    expect(formatPlan({ organizationRateLimitTier: "default_claude_pro" })).toBe("Pro");
    expect(formatPlan({ organizationType: "claude_max" })).toBe("Max");
    expect(formatPlan({ organizationRateLimitTier: "tier_from_the_future" })).toBe(
      "tier_from_the_future",
    );
    expect(formatPlan({})).toBeUndefined();
  });
});

describe("resolveAccountIdentity", () => {
  test("resolves a configDir account", () => {
    const identity = resolveAccountIdentity(
      { id: "claw2", configDir: "~/.claude-second" },
      io({ "/home/u/.claude-second/.claude.json": claudeJson({ accountUuid: "uuid-2" }) }),
    );
    expect(identity.status).toBe("resolved");
    expect(identity.accountUuid).toBe("uuid-2");
    expect(identity.source).toBe("/home/u/.claude-second/.claude.json");
  });

  test("a missing file is unknown, never a guess", () => {
    const identity = resolveAccountIdentity({ id: "claw2", configDir: "~/.gone" }, io({}));
    expect(identity.status).toBe("unknown");
    expect(identity.reason).toContain("never completed a login");
  });

  test("token accounts explain why they cannot be read", () => {
    const identity = resolveAccountIdentity({ id: "claw3", oauthTokenFile: "~/t" }, io({}));
    expect(identity.status).toBe("unknown");
    expect(identity.reason).toContain("inside the token");
  });
});

describe("maskEmail / describeIdentity", () => {
  test("masks the local part but keeps enough to tell logins apart", () => {
    expect(maskEmail("someone@example.com")).toBe("s…e@example.com");
    expect(maskEmail("ab@example.com")).toBe("a…@example.com");
    expect(maskEmail("nonsense")).toBe("…");
  });

  test("default display is masked; raw opts in to the full record", () => {
    const identity = resolveAccountIdentity(
      { id: "claw1", native: true },
      io({ [`${DEFAULT_DIR}/.claude.json`]: claudeJson() }),
    );
    expect(describeIdentity(identity)).toBe("s…e@example.com · Max 20x");
    expect(describeIdentity(identity, { raw: true })).toContain("someone@example.com");
    expect(describeIdentity(identity)).not.toContain("someone@example.com");
    // The org name is identifying on a company domain — raw-only.
    expect(describeIdentity(identity)).not.toContain("Organization");
  });

  test("unknown identities describe the reason, not a fake login", () => {
    expect(describeIdentity({ accountId: "claw3", status: "unknown", reason: "no login yet" })).toBe(
      "no login yet",
    );
  });
});

describe("findDuplicateLogins", () => {
  const base = { status: "resolved" as const, plan: "Max 20x" };

  test("flags two ids sharing one login", () => {
    const dupes = findDuplicateLogins([
      { accountId: "claw1", accountUuid: "uuid-1", email: "a@example.com", ...base },
      { accountId: "claw2", accountUuid: "uuid-1", email: "a@example.com", ...base },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].accountIds).toEqual(["claw1", "claw2"]);
  });

  test("distinct logins and unresolved identities are not duplicates", () => {
    expect(
      findDuplicateLogins([
        { accountId: "claw1", accountUuid: "uuid-1", ...base },
        { accountId: "claw2", accountUuid: "uuid-2", ...base },
        { accountId: "claw3", status: "unknown", reason: "no login yet" },
        { accountId: "claw4", status: "unknown", reason: "no login yet" },
      ]),
    ).toEqual([]);
  });

  test("falls back to email when a uuid is absent", () => {
    const dupes = findDuplicateLogins([
      { accountId: "claw1", email: "a@example.com", ...base },
      { accountId: "claw2", email: "a@example.com", ...base },
    ]);
    expect(dupes[0].accountIds).toEqual(["claw1", "claw2"]);
  });
});
