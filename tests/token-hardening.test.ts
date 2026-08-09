import { describe, expect, test } from "vitest";
import { createTokenRefResolver, redactRefError } from "../src/token-resolution";
import { buildAccountChildEnv } from "../src/account-env";
import { validateAccountTokenSources } from "../src/account-env";

const REF = { source: "exec", provider: "onepassword", id: "op://SecretVault/SecretItem/field" };
const SECRET = "sk-ant-oat01-SUPERSECRETVALUE";

describe("redaction (three leak classes)", () => {
  test("redacted error carries a fixed reason code — no token, no ref metadata, no provider text", () => {
    const message = redactRefError(REF, new Error(`vault said: ${SECRET} at op://SecretVault/SecretItem`));
    expect(message).toContain("credential_resolution_failed");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("SecretVault");
    expect(message).not.toContain("SecretItem");
    expect(message).not.toContain("vault said");
    // error CLASS is allowed (aids debugging without leaking content)
    expect(message).toContain("Error");
  });

  test("resolver onError receives only pre-redacted text", async () => {
    const seen: string[] = [];
    const resolver = createTokenRefResolver({
      resolveRefs: async () => {
        throw new Error(`boom ${SECRET}`);
      },
      onError: (_ref, err) => seen.push(String(err)),
      redact: true,
    });
    await resolver.resolve(REF, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(SECRET);
    expect(seen[0]).toContain("credential_resolution_failed");
  });
});

describe("TTL rotation", () => {
  test("a rotated provider value is picked up after cache expiry", async () => {
    let value = "sk-ant-oat01-first";
    const resolver = createTokenRefResolver({
      resolveRefs: async (refs) => new Map(refs.map((r) => [r.id, value])),
      ttlMs: 1000,
    });
    expect(await resolver.resolve(REF, 0)).toBe("sk-ant-oat01-first");
    value = "sk-ant-oat01-rotated";
    expect(await resolver.resolve(REF, 500)).toBe("sk-ant-oat01-first"); // cached
    expect(await resolver.resolve(REF, 1500)).toBe("sk-ant-oat01-rotated"); // expired → new
  });
});

describe("mutual exclusivity validation", () => {
  test("ref + file on one account is flagged", () => {
    const warnings = validateAccountTokenSources({
      id: "claw2",
      oauthTokenFile: "~/.claw2/oauth-token",
      oauthTokenRef: REF,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("claw2");
    expect(warnings[0]).toContain("mutually exclusive");
  });

  test("native + any token source is flagged", () => {
    expect(validateAccountTokenSources({ id: "claw1", native: true, oauthTokenRef: REF })).toHaveLength(1);
    expect(
      validateAccountTokenSources({ id: "claw1", native: true, oauthTokenFile: "~/.x" }),
    ).toHaveLength(1);
  });

  test("single-source accounts are clean", () => {
    expect(validateAccountTokenSources({ id: "a", native: true })).toHaveLength(0);
    expect(validateAccountTokenSources({ id: "b", oauthTokenRef: REF })).toHaveLength(0);
    expect(validateAccountTokenSources({ id: "c", oauthTokenFile: "~/.t" })).toHaveLength(0);
    expect(validateAccountTokenSources({ id: "d", configDir: "~/.d" })).toHaveLength(0);
  });
});

describe("child env injection", () => {
  test("ref-resolved token lands in CLAUDE_CODE_OAUTH_TOKEN alongside shim vars", () => {
    const env = buildAccountChildEnv(
      { id: "claw2", oauthTokenRef: REF },
      SECRET,
      "/state/claw2.json",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET);
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
    expect(env.MULTI_CLAWD_STATE_FILE).toBe("/state/claw2.json");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("native accounts set neither token nor config dir", () => {
    const env = buildAccountChildEnv({ id: "claw1", native: true }, undefined, "/state/claw1.json");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
  });

  test("configDir accounts get CLAUDE_CONFIG_DIR expanded", () => {
    const env = buildAccountChildEnv(
      { id: "claw3", configDir: "/isolated/claw3" },
      undefined,
      "/state/claw3.json",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/isolated/claw3");
  });
});

/**
 * Adversarial finding (9 Aug 2026, HIGH): an account that declares a token
 * source is authenticated by that token and nothing else. When the resolver
 * hiccups — provider briefly down, empty secret, half-written token file —
 * `buildAccountChildEnv` emitted an env carrying NEITHER a token NOR a config
 * dir, so the child fell through to the box's own default login and spent a
 * DIFFERENT account's quota while telemetry still said this one. Credential
 * resolution must fail closed: no credential, no launch.
 */
describe("child env fails closed on an unresolved credential", () => {
  test("a ref account with no resolved token throws instead of falling through", () => {
    expect(() =>
      buildAccountChildEnv({ id: "claw2", oauthTokenRef: REF }, undefined, "/state/claw2.json"),
    ).toThrow(/claw2/);
  });

  test("a blank secret counts as unresolved, not as a token", () => {
    expect(() =>
      buildAccountChildEnv({ id: "claw2", oauthTokenRef: REF }, "   ", "/state/claw2.json"),
    ).toThrow(/claw2/);
  });

  test("a token-file account with nothing read back throws too", () => {
    expect(() =>
      buildAccountChildEnv({ id: "claw4", oauthTokenFile: "~/.t" }, "", "/state/claw4.json"),
    ).toThrow(/claw4/);
  });

  test("a declared configDir is that account's own login, so it stays a valid fallback", () => {
    const env = buildAccountChildEnv(
      { id: "claw2", oauthTokenRef: REF, configDir: "/isolated/claw2" },
      undefined,
      "/state/claw2.json",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/isolated/claw2");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("native accounts are unaffected — they are meant to carry no credential", () => {
    expect(() =>
      buildAccountChildEnv({ id: "claw1", native: true }, undefined, "/state/claw1.json"),
    ).not.toThrow();
  });
});
