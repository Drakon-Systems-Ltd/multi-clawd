import { describe, expect, test } from "vitest";
import { describeAccount, annotateChainRef, renderExplanation } from "../src/explain-core";

describe("describeAccount", () => {
  test("native account in plain english", () => {
    const d = describeAccount({ id: "claw1", label: "Main Claude", native: true });
    expect(d).toMatch(/main .?claude.? login/i);
    expect(d).toMatch(/default config dir/i);
  });

  test("isolated dir + secret ref: names the provider, never prints the ref id", () => {
    const d = describeAccount({
      id: "claw2",
      configDir: "~/.claw2",
      oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://Secret/Item/field" },
    });
    expect(d).toMatch(/isolated login dir.*~\/.claw2/i);
    expect(d).toMatch(/onepassword/);
    expect(d).toMatch(/secret reference/i);
    expect(d).not.toContain("op://Secret");
  });

  test("token file account", () => {
    const d = describeAccount({ id: "claw2", configDir: "~/.claw2", oauthTokenFile: "~/.claw2/oauth-token" });
    expect(d).toMatch(/token file/i);
  });

  test("dir-login-only account", () => {
    const d = describeAccount({ id: "claw2", configDir: "~/.claw2" });
    expect(d).toMatch(/login stored (in|inside)/i);
  });
});

describe("annotateChainRef", () => {
  const pool = { id: "clawd", accounts: ["claw1", "claw2"] };

  test("pool rung: expands the account order", () => {
    const a = annotateChainRef("clawd/claude-fable-5", pool);
    expect(a).toMatch(/pool/i);
    expect(a).toMatch(/claw1.*then.*claw2/i);
  });

  test("single-account pin: warns no cross-account failover", () => {
    expect(annotateChainRef("claw2/claude-opus-4-8", pool)).toMatch(/only claw2.*no cross-account/i);
  });

  test("non-Claude provider: leaves Claude", () => {
    expect(annotateChainRef("openai/gpt-5.6-sol", pool)).toMatch(/leaves claude/i);
    expect(annotateChainRef("xai/grok-4.5", pool)).toMatch(/leaves claude/i);
  });

  test("direct anthropic: bypasses the pool", () => {
    expect(annotateChainRef("anthropic/claude-opus-4-8", pool)).toMatch(/bypass/i);
  });

  test("no pool configured: pool refs reported plainly", () => {
    expect(annotateChainRef("clawd/claude-fable-5", undefined)).toMatch(/no pool/i);
  });
});

describe("renderExplanation", () => {
  test("full picture: accounts, pool, numbered chain, live state", () => {
    const out = renderExplanation({
      accounts: [
        { id: "claw1", label: "Main Claude", native: true },
        { id: "claw2", label: "Second Claude", configDir: "~/.claw2", oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://X/Y/z" } },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"], utilizationThreshold: 0.85 },
      chain: { primary: "clawd/claude-fable-5", fallbacks: ["clawd/claude-opus-4-8", "openai/gpt-5.6-sol"] },
      health: [
        { id: "claw1", verdict: "ok", detail: undefined },
        { id: "claw2", verdict: "exhausted", detail: "weekly window rejected — resets in ~6h" },
      ],
      stickyAccount: undefined,
    });
    expect(out).toContain("claw1");
    expect(out).toMatch(/1\..*clawd\/claude-fable-5/);
    expect(out).toMatch(/2\..*clawd\/claude-opus-4-8/);
    expect(out).toMatch(/3\..*openai\/gpt-5.6-sol/);
    expect(out).toMatch(/85%/);
    expect(out).toMatch(/resets in ~6h/);
    expect(out).not.toContain("op://X");
  });

  test("no pool, no chain: still renders accounts without throwing", () => {
    const out = renderExplanation({
      accounts: [{ id: "claw2", configDir: "~/.claw2" }],
      pool: undefined,
      chain: undefined,
      health: [],
      stickyAccount: undefined,
    });
    expect(out).toContain("claw2");
    expect(out).toMatch(/no pool configured/i);
  });
});
