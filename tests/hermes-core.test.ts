/**
 * The TypeScript core is deliberately NOT a planner. Planning against Hermes'
 * on-disk state happens once, in `scripts/hermes_bridge.py`, where the real
 * pool lives. What is left here — option, account, source and setup-token
 * validation, stable ids, priorities, and the bridge payload — is exactly the
 * part that runs before a single byte reaches Hermes.
 */
import { describe, expect, test } from "vitest";
import {
  HERMES_DEFAULT_STRATEGY,
  HERMES_MANAGED_ID_PREFIX,
  HERMES_MANAGED_SOURCE,
  HERMES_SUPPORTED_STRATEGIES,
  HermesAdapterError,
  buildHermesBridgeRequest,
  buildHermesManagedCredential,
  chooseHermesCredentialSource,
  collectHermesAccounts,
  describeHermesAccountSupport,
  hermesAccountPriorities,
  parseClaudeSetupToken,
  stableHermesCredentialId,
  validateHermesAccount,
  validateHermesProfileName,
  validateHermesStrategy,
} from "../src/hermes-core";

const TOKEN = "sk-ant-oat01-fake-test-value-0123456789";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof HermesAdapterError) return error.code;
    return `unexpected:${String(error)}`;
  }
  return "no-error";
}

describe("strategy and profile validation", () => {
  test("accepts exactly Hermes' four pool strategies, case-insensitively", () => {
    expect(HERMES_SUPPORTED_STRATEGIES).toEqual(["fill_first", "round_robin", "random", "least_used"]);
    expect(HERMES_DEFAULT_STRATEGY).toBe("fill_first");
    for (const strategy of HERMES_SUPPORTED_STRATEGIES) {
      expect(validateHermesStrategy(strategy.toUpperCase())).toBe(strategy);
    }
    for (const bad of ["weighted", "", "  ", null, 3, {}]) {
      expect(codeOf(() => validateHermesStrategy(bad))).toBe("invalid_strategy");
    }
  });

  test("rejects traversal, separators, and reserved profile names", () => {
    expect(validateHermesProfileName(" Work ")).toBe("work");
    expect(validateHermesProfileName("default")).toBe("default");
    for (const bad of ["../escape", "a/b", "a\\b", "-lead", "", "hermes", "root", "sudo", "x".repeat(65)]) {
      expect(codeOf(() => validateHermesProfileName(bad)), bad).toBe("invalid_profile");
    }
  });
});

describe("account inspection", () => {
  test("normalises ids and reports unusable ones instead of aborting the account set", () => {
    const { accounts, unsupported } = collectHermesAccounts([
      { id: "Claw1", oauthTokenFile: "/tmp/claw1.token" },
      { id: "work.acct", oauthTokenFile: "/tmp/work.token" },
      { id: "claw2", oauthTokenFile: "/tmp/claw2.token" },
    ]);
    expect(accounts.map((account) => account.id)).toEqual(["claw1", "claw2"]);
    expect(unsupported).toEqual([
      expect.objectContaining({ id: "work.acct", code: "unsupported_account_id" }),
    ]);
  });

  test("classifies every non-setup-token source as unsupported with actionable guidance", () => {
    const cases = [
      [{ id: "a", native: true }, "native_not_supported"],
      [{ id: "b", configDir: "/tmp/dir" }, "setup_token_file_required"],
      [{ id: "c", oauthTokenRef: { source: "exec" } }, "secret_ref_not_supported"],
      [{ id: "d" }, "setup_token_file_required"],
    ] as const;
    for (const [raw, code] of cases) {
      const support = describeHermesAccountSupport(validateHermesAccount(raw));
      expect(support.supported).toBe(false);
      if (support.supported) continue;
      expect(support.code).toBe(code);
      expect(support.reason).toMatch(/setup-token|claude_code/);
    }
  });

  test("a configDir may coexist with a setup-token file and is simply irrelevant", () => {
    const account = validateHermesAccount({
      id: "claw1",
      configDir: "/tmp/dir",
      oauthTokenFile: "/tmp/claw1.token",
    });
    expect(describeHermesAccountSupport(account)).toEqual({ supported: true });
  });

  test("reports repeated ids rather than throwing, and rejects structural garbage", () => {
    const { accounts, unsupported } = collectHermesAccounts([
      { id: "claw1", oauthTokenFile: "/tmp/a.token" },
      { id: "claw1", oauthTokenFile: "/tmp/b.token" },
    ]);
    expect(accounts).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({ id: "claw1", code: "duplicate_account" });
    expect(codeOf(() => collectHermesAccounts([]))).toBe("no_accounts");
    expect(codeOf(() => collectHermesAccounts("nope"))).toBe("no_accounts");
    expect(codeOf(() => collectHermesAccounts([{ id: 7 }]))).toBe("malformed_account");
    expect(codeOf(() => collectHermesAccounts([{ id: "a", oauthTokenRef: "nope" }]))).toBe(
      "malformed_account",
    );
  });
});

describe("priority ordering", () => {
  const accounts = collectHermesAccounts([
    { id: "spare", oauthTokenFile: "/tmp/spare.token" },
    { id: "home", oauthTokenFile: "/tmp/home.token" },
    { id: "extra", oauthTokenFile: "/tmp/extra.token" },
  ]).accounts;

  test("pool.accounts preference order wins, then accounts[] order", () => {
    const priorities = hermesAccountPriorities({ pool: { accounts: ["home", "spare"] } }, accounts);
    expect([...priorities.entries()]).toEqual([["home", 0], ["spare", 1], ["extra", 2]]);
  });

  test("falls back to accounts[] order, and ignores unknown or repeated preferences", () => {
    expect([...hermesAccountPriorities({}, accounts).entries()]).toEqual([
      ["spare", 0],
      ["home", 1],
      ["extra", 2],
    ]);
    const noisy = hermesAccountPriorities(
      { pool: { accounts: ["ghost", "HOME", "home", 7, null] } },
      accounts,
    );
    expect([...noisy.entries()]).toEqual([["home", 0], ["spare", 1], ["extra", 2]]);
  });

  test("handles a pool declared as an array of pools", () => {
    const priorities = hermesAccountPriorities({ pool: [{ accounts: ["extra"] }] }, accounts);
    expect(priorities.get("extra")).toBe(0);
  });
});

describe("credential source selection", () => {
  test("selects the setup-token file when it exists", () => {
    const account = { id: "claw1", oauthTokenFile: "/tmp/claw1.token" };
    expect(
      chooseHermesCredentialSource(account, {
        oauthTokenFilePath: "/tmp/claw1.token",
        existingPaths: ["/tmp/claw1.token"],
      }),
    ).toEqual({ kind: "oauthTokenFile", path: "/tmp/claw1.token" });
  });

  test("fails closed for a missing file, a secret ref, and a native login", () => {
    expect(
      codeOf(() =>
        chooseHermesCredentialSource(
          { id: "claw1", oauthTokenFile: "/tmp/claw1.token" },
          { oauthTokenFilePath: "/tmp/claw1.token", existingPaths: [] },
        ),
      ),
    ).toBe("setup_token_file_missing");
    expect(
      codeOf(() =>
        chooseHermesCredentialSource(
          { id: "claw1", oauthTokenRef: { source: "exec" } },
          { existingPaths: [] },
        ),
      ),
    ).toBe("secret_ref_not_supported");
    expect(
      codeOf(() => chooseHermesCredentialSource({ id: "claw1", native: true }, { existingPaths: [] })),
    ).toBe("native_not_supported");
  });
});

describe("setup-token parsing", () => {
  test("accepts one token with or without a trailing newline", () => {
    expect(parseClaudeSetupToken(TOKEN)).toBe(TOKEN);
    expect(parseClaudeSetupToken(`${TOKEN}\n`)).toBe(TOKEN);
    expect(parseClaudeSetupToken(`${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test("refuses a rotating JSON grant with an explicit reason", () => {
    const json = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "r" } });
    expect(codeOf(() => parseClaudeSetupToken(json))).toBe("rotating_grant_not_supported");
    expect(codeOf(() => parseClaudeSetupToken("[]"))).toBe("rotating_grant_not_supported");
  });

  test("refuses whitespace, control characters, several lines, empties, and stubs", () => {
    for (const bad of [
      "",
      "   ",
      `${TOKEN} extra`,
      `${TOKEN}\nsecond\n`,
      `\n${TOKEN}`,
      `${TOKEN} `,
      `${TOKEN}\u0007`,
      "short",
      42,
      undefined,
      "x".repeat(9000),
    ]) {
      expect(codeOf(() => parseClaudeSetupToken(bad)), String(bad)).toBe("malformed_setup_token");
    }
  });

  test("refuses an Anthropic API key shape with its own reason, not a generic malformed error", () => {
    const apiKey = "sk-ant-api03-fake-test-not-a-setup-token-0123456789";
    expect(codeOf(() => parseClaudeSetupToken(apiKey))).toBe("malformed_setup_token");
    try {
      parseClaudeSetupToken(apiKey);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as Error).message).toMatch(/API key/);
      expect((error as Error).message).not.toContain(apiKey);
    }
  });

  test("refuses non-ASCII and non-visible characters with no leakage", () => {
    for (const bad of [
      `${TOKEN}é`,
      "sk-ant-oat01-fake-café-token",
      "sk-ant-oat01-fake-​token",
      "sk-ant-oat01-fake-😀-token",
    ]) {
      expect(codeOf(() => parseClaudeSetupToken(bad)), JSON.stringify(bad)).toBe("malformed_setup_token");
      try {
        parseClaudeSetupToken(bad);
        throw new Error("expected a failure");
      } catch (error) {
        expect((error as Error).message).not.toContain(bad);
      }
    }
  });

  test("never echoes the token in the failure message", () => {
    try {
      parseClaudeSetupToken(`${TOKEN} trailing`);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});

describe("managed identity and bridge payload", () => {
  test("credential ids are deterministic, namespaced, and case-normalised", () => {
    const id = stableHermesCredentialId("claw1");
    expect(id).toBe(stableHermesCredentialId("Claw1"));
    expect(id.startsWith(HERMES_MANAGED_ID_PREFIX)).toBe(true);
    expect(id).toMatch(/^multi-clawd-[a-f0-9]{16}$/);
    expect(stableHermesCredentialId("claw2")).not.toBe(id);
    expect(codeOf(() => stableHermesCredentialId("work.acct"))).toBe("unsupported_account_id");
  });

  test("builds a managed credential with no rotating fields", () => {
    const credential = buildHermesManagedCredential({ id: "Claw1" }, TOKEN, 2);
    expect(credential).toEqual({
      accountId: "claw1",
      id: stableHermesCredentialId("claw1"),
      label: "multi-clawd:claw1",
      source: HERMES_MANAGED_SOURCE,
      authType: "oauth",
      accessToken: TOKEN,
      priority: 2,
    });
    expect(Object.keys(credential)).not.toContain("refreshToken");
    expect(Object.keys(credential)).not.toContain("expiresAtMs");
    for (const bad of [-1, 1.5, Number.NaN, "0"]) {
      expect(codeOf(() => buildHermesManagedCredential({ id: "claw1" }, TOKEN, bad as number))).toBe(
        "invalid_priority",
      );
    }
  });

  test("omitting the strategy omits the key so Hermes' configured value survives", () => {
    const credential = buildHermesManagedCredential({ id: "claw1" }, TOKEN, 0);
    const withoutStrategy = buildHermesBridgeRequest({
      operation: "apply",
      targetHome: "/tmp/home",
      dryRun: true,
      credentials: [credential],
    });
    expect(withoutStrategy).toEqual({
      operation: "apply",
      targetHome: "/tmp/home",
      dryRun: true,
      credentials: [credential],
    });
    expect("strategy" in withoutStrategy).toBe(false);

    const withStrategy = buildHermesBridgeRequest({
      operation: "apply",
      targetHome: "/tmp/home",
      strategy: "round_robin",
      credentials: [credential],
    });
    expect(withStrategy).toMatchObject({ strategy: "round_robin", dryRun: false });
  });

  test("read-only operations carry no credentials and bad inputs fail closed", () => {
    expect(buildHermesBridgeRequest({ operation: "doctor", targetHome: "/tmp/home" })).toEqual({
      operation: "doctor",
      targetHome: "/tmp/home",
    });
    expect(
      codeOf(() => buildHermesBridgeRequest({ operation: "wipe" as never, targetHome: "/tmp/home" })),
    ).toBe("unsupported_operation");
    expect(codeOf(() => buildHermesBridgeRequest({ operation: "probe", targetHome: "" }))).toBe(
      "invalid_target_home",
    );
  });
});
