import { describe, expect, test } from "vitest";
import {
  buildMainAccount,
  buildSecondAccount,
  buildPool,
  validateSecondConfigDir,
  planFromExisting,
  mergeSetupIntoConfig,
  type SetupPlan,
} from "../src/setup-core";

describe("buildMainAccount", () => {
  test("native main account: no configDir, no token source", () => {
    expect(buildMainAccount({ id: "claw1", label: "Main Claude" })).toEqual({
      id: "claw1",
      label: "Main Claude",
      native: true,
    });
  });
});

describe("buildSecondAccount", () => {
  test("secret-ref account: configDir + oauthTokenRef, never a plaintext file", () => {
    const acc = buildSecondAccount({
      id: "claw2",
      label: "Second Claude",
      configDir: "~/.claw2",
      tokenSource: {
        kind: "ref",
        ref: { source: "exec", provider: "onepassword", id: "op://Vault/Item/field" },
      },
    });
    expect(acc).toEqual({
      id: "claw2",
      label: "Second Claude",
      configDir: "~/.claw2",
      oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://Vault/Item/field" },
    });
  });

  test("token-file account", () => {
    const acc = buildSecondAccount({
      id: "claw2",
      configDir: "~/.claw2",
      tokenSource: { kind: "file", path: "~/.claw2/oauth-token" },
    });
    expect(acc).toMatchObject({ configDir: "~/.claw2", oauthTokenFile: "~/.claw2/oauth-token" });
    expect(acc.oauthTokenRef).toBeUndefined();
  });

  test("dir-login-only account: just the isolated configDir", () => {
    const acc = buildSecondAccount({
      id: "claw2",
      configDir: "~/.claw2",
      tokenSource: { kind: "dir-login" },
    });
    expect(acc).toEqual({ id: "claw2", label: undefined, configDir: "~/.claw2" });
  });

  test("rejects a malformed secret ref", () => {
    expect(() =>
      buildSecondAccount({
        id: "claw2",
        configDir: "~/.claw2",
        tokenSource: { kind: "ref", ref: { source: "exec" } as never },
      }),
    ).toThrow(/secret ref/i);
  });

  test("rejects reserved / colliding account ids", () => {
    for (const id of ["claude-cli", "", "  "]) {
      expect(() =>
        buildSecondAccount({ id, configDir: "~/.claw2", tokenSource: { kind: "dir-login" } }),
      ).toThrow(/id/i);
    }
  });
});

describe("validateSecondConfigDir", () => {
  test("accepts an isolated dir", () => {
    expect(validateSecondConfigDir("~/.claw2")).toBeUndefined();
    expect(validateSecondConfigDir("~/.claude-second")).toBeUndefined();
  });

  test("rejects the default ~/.claude (would clobber the main login)", () => {
    expect(validateSecondConfigDir("~/.claude")).toMatch(/main/i);
    expect(validateSecondConfigDir("~/.claude/")).toMatch(/main/i);
  });

  test("rejects a dir INSIDE ~/.claude", () => {
    expect(validateSecondConfigDir("~/.claude/second")).toMatch(/inside/i);
  });

  test("rejects relative paths", () => {
    expect(validateSecondConfigDir("second-claude")).toMatch(/absolute|~\//i);
  });
});

describe("buildPool", () => {
  test("pool over the accounts in preference order", () => {
    expect(buildPool(["claw1", "claw2"])).toEqual({ id: "clawd", accounts: ["claw1", "claw2"] });
  });

  test("custom id", () => {
    expect(buildPool(["a", "b"], { id: "mypool" })).toEqual({ id: "mypool", accounts: ["a", "b"] });
  });
});

describe("planFromExisting", () => {
  test("empty config: nothing present", () => {
    expect(planFromExisting({})).toEqual({
      hasPluginEntry: false,
      accountIds: [],
      hasPool: false,
      hasAllowList: false,
      allowListed: false,
    });
  });

  test("reads existing accounts, pool, and allow state", () => {
    const cfg = {
      plugins: {
        allow: ["other-plugin", "multi-clawd"],
        entries: {
          "multi-clawd": {
            enabled: true,
            config: {
              accounts: [{ id: "claw2", configDir: "~/.claw2" }],
              pool: { id: "clawd", accounts: ["claw2"] },
            },
          },
        },
      },
    };
    expect(planFromExisting(cfg)).toEqual({
      hasPluginEntry: true,
      accountIds: ["claw2"],
      hasPool: true,
      hasAllowList: true,
      allowListed: true,
    });
  });

  test("tolerates junk shapes without throwing", () => {
    expect(() => planFromExisting({ plugins: { entries: 42 } })).not.toThrow();
    expect(planFromExisting({ plugins: null }).hasPluginEntry).toBe(false);
  });
});

describe("mergeSetupIntoConfig", () => {
  const plan: SetupPlan = {
    accounts: [
      { id: "claw1", label: "Main Claude", native: true },
      { id: "claw2", label: "Second Claude", configDir: "~/.claw2", oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://Vault/Item/field" } },
    ],
    pool: { id: "clawd", accounts: ["claw1", "claw2"] },
    modelRungs: ["clawd/claude-fable-5"],
  };

  test("scaffolds a fresh config from empty, reporting every change", () => {
    const { config, changes } = mergeSetupIntoConfig({}, plan);
    const entry = (config as any).plugins.entries["multi-clawd"];
    expect(entry.enabled).toBe(true);
    expect(entry.config.accounts).toHaveLength(2);
    expect(entry.config.pool).toEqual({ id: "clawd", accounts: ["claw1", "claw2"] });
    expect((config as any).agents.defaults.models["clawd/claude-fable-5"]).toEqual({});
    expect(changes.length).toBeGreaterThan(0);
  });

  test("preserves unrelated existing keys untouched", () => {
    const existing = {
      gateway: { port: 12345 },
      agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "sol" } } } },
      plugins: { entries: { "other-plugin": { enabled: true } } },
    };
    const { config } = mergeSetupIntoConfig(existing, plan);
    expect((config as any).gateway).toEqual({ port: 12345 });
    expect((config as any).plugins.entries["other-plugin"]).toEqual({ enabled: true });
    expect((config as any).agents.defaults.models["openai/gpt-5.6-sol"]).toEqual({ alias: "sol" });
  });

  test("does not mutate the input config object", () => {
    const existing = { plugins: { entries: {} } };
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeSetupIntoConfig(existing, plan);
    expect(existing).toEqual(snapshot);
  });

  test("merges accounts by id: existing entry is updated, not duplicated", () => {
    const existing = {
      plugins: {
        entries: {
          "multi-clawd": {
            enabled: true,
            config: { accounts: [{ id: "claw2", configDir: "~/.old-dir", note: "keep-me" }] },
          },
        },
      },
    };
    const { config } = mergeSetupIntoConfig(existing, plan);
    const accounts = (config as any).plugins.entries["multi-clawd"].config.accounts;
    expect(accounts.filter((a: any) => a.id === "claw2")).toHaveLength(1);
    const claw2 = accounts.find((a: any) => a.id === "claw2");
    expect(claw2.configDir).toBe("~/.claw2"); // updated
    expect(claw2.note).toBe("keep-me"); // unknown field preserved
  });

  test("never clobbers an existing pool — reports a skip instead", () => {
    const existing = {
      plugins: {
        entries: {
          "multi-clawd": {
            enabled: true,
            config: { accounts: [], pool: { id: "clawd", accounts: ["claw9"] } },
          },
        },
      },
    };
    const { config, changes } = mergeSetupIntoConfig(existing, plan);
    expect((config as any).plugins.entries["multi-clawd"].config.pool).toEqual({
      id: "clawd",
      accounts: ["claw9"],
    });
    expect(changes.some((c) => /pool.*(exist|skip)/i.test(c))).toBe(true);
  });

  test("appends to plugins.allow only when an allow list exists and lacks the entry", () => {
    const withAllow = { plugins: { allow: ["other"] } };
    expect((mergeSetupIntoConfig(withAllow, plan).config as any).plugins.allow).toEqual([
      "other",
      "multi-clawd",
    ]);
    const already = { plugins: { allow: ["multi-clawd"] } };
    expect((mergeSetupIntoConfig(already, plan).config as any).plugins.allow).toEqual([
      "multi-clawd",
    ]);
    const noAllow = mergeSetupIntoConfig({}, plan).config as any;
    expect(noAllow.plugins.allow).toBeUndefined();
  });

  test("idempotent: applying the same plan twice yields identical config and zero changes", () => {
    const first = mergeSetupIntoConfig({}, plan);
    const second = mergeSetupIntoConfig(first.config, plan);
    expect(second.config).toEqual(first.config);
    expect(second.changes).toEqual([]);
  });
});
