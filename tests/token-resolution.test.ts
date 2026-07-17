import { describe, expect, test } from "vitest";
import { createTokenRefResolver, isSecretRefShape } from "../src/token-resolution";

const REF = { source: "exec", provider: "onepassword", id: "op://vault/item/field" };

function makeResolver(overrides?: {
  value?: unknown;
  fail?: boolean;
  onError?: (ref: unknown, err: unknown) => void;
}) {
  let calls = 0;
  const resolver = createTokenRefResolver({
    resolveRefs: async (refs) => {
      calls++;
      if (overrides?.fail) throw new Error("provider unavailable");
      const map = new Map<string, unknown>();
      for (const r of refs) map.set(r.id, overrides && "value" in overrides ? overrides.value : "sk-ant-oat01-resolved");
      return map;
    },
    ttlMs: 1000,
    onError: overrides?.onError,
  });
  return { resolver, callCount: () => calls };
}

describe("isSecretRefShape", () => {
  test("accepts the OpenClaw SecretRef shape", () => {
    expect(isSecretRefShape(REF)).toBe(true);
  });
  test("rejects junk", () => {
    expect(isSecretRefShape({ ref: "op://x" })).toBe(false);
    expect(isSecretRefShape("op://x")).toBe(false);
    expect(isSecretRefShape(null)).toBe(false);
    expect(isSecretRefShape({ source: "exec", provider: "p" })).toBe(false);
  });
});

describe("createTokenRefResolver", () => {
  test("resolves a ref to its secret value", async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve(REF, 0)).toBe("sk-ant-oat01-resolved");
  });

  test("caches within TTL and re-resolves after expiry", async () => {
    const { resolver, callCount } = makeResolver();
    await resolver.resolve(REF, 0);
    await resolver.resolve(REF, 500);
    expect(callCount()).toBe(1);
    await resolver.resolve(REF, 1500);
    expect(callCount()).toBe(2);
  });

  test("peek returns the cached value without resolving", async () => {
    const { resolver, callCount } = makeResolver();
    expect(resolver.peek(REF, 0)).toBeUndefined();
    await resolver.resolve(REF, 0);
    expect(resolver.peek(REF, 500)).toBe("sk-ant-oat01-resolved");
    expect(resolver.peek(REF, 1500)).toBeUndefined();
    expect(callCount()).toBe(1);
  });

  test("provider failure reports the error and returns undefined without throwing", async () => {
    const errors: unknown[] = [];
    const { resolver } = makeResolver({ fail: true, onError: (_r, e) => errors.push(e) });
    expect(await resolver.resolve(REF, 0)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test("failure is not cached — next call retries", async () => {
    let fail = true;
    const resolver = createTokenRefResolver({
      resolveRefs: async (refs) => {
        if (fail) throw new Error("down");
        return new Map(refs.map((r) => [r.id, "sk-recovered"]));
      },
      ttlMs: 1000,
    });
    expect(await resolver.resolve(REF, 0)).toBeUndefined();
    fail = false;
    expect(await resolver.resolve(REF, 10)).toBe("sk-recovered");
  });

  test("non-string resolved values are rejected", async () => {
    const { resolver } = makeResolver({ value: 12345 });
    expect(await resolver.resolve(REF, 0)).toBeUndefined();
  });

  test("whitespace is trimmed from resolved tokens", async () => {
    const { resolver } = makeResolver({ value: "  sk-ant-oat01-x \n" });
    expect(await resolver.resolve(REF, 0)).toBe("sk-ant-oat01-x");
  });

  test("accepts OpenClaw's composite result key (source:provider:id)", async () => {
    const resolver = createTokenRefResolver({
      resolveRefs: async (refs) =>
        new Map(refs.map((r) => [`${r.source}:${r.provider}:${r.id}`, "sk-ant-oat01-composite"])),
      ttlMs: 1000,
    });
    expect(await resolver.resolve(REF, 0)).toBe("sk-ant-oat01-composite");
  });
});

describe("resolveDetailed", () => {
  test("success returns the value with no failure and caches it", async () => {
    const { resolver, callCount } = makeResolver();
    expect(await resolver.resolveDetailed(REF, 0)).toEqual({ value: "sk-ant-oat01-resolved" });
    // Cache hit within TTL: value returned, provider not called again.
    expect(await resolver.resolveDetailed(REF, 500)).toEqual({ value: "sk-ant-oat01-resolved" });
    expect(callCount()).toBe(1);
  });

  test("provider error (resolveRefs threw) is classified provider_error, no value", async () => {
    const { resolver } = makeResolver({ fail: true });
    const result = await resolver.resolveDetailed(REF, 0);
    expect(result.failure).toBe("provider_error");
    expect(result.value).toBeUndefined();
  });

  test("resolver ran but returned nothing is classified empty_result", async () => {
    const { resolver } = makeResolver({ value: undefined });
    expect(await resolver.resolveDetailed(REF, 0)).toEqual({ failure: "empty_result" });
  });

  test("resolver ran but returned a non-string is classified empty_result", async () => {
    const { resolver } = makeResolver({ value: 12345 });
    expect(await resolver.resolveDetailed(REF, 0)).toEqual({ failure: "empty_result" });
  });

  test("redaction is preserved: onError never sees token, ref metadata, or provider text", async () => {
    const SECRET = "sk-ant-oat01-SUPERSECRET";
    const seen: string[] = [];
    const resolver = createTokenRefResolver({
      resolveRefs: async () => {
        throw new Error(`vault at op://Vault/Item said ${SECRET}`);
      },
      onError: (_r, err) => seen.push(String(err)),
      redact: true,
    });
    const result = await resolver.resolveDetailed(REF, 0);
    expect(result.failure).toBe("provider_error");
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(SECRET);
    expect(seen[0]).not.toContain("Vault");
    expect(seen[0]).not.toContain("vault at");
    expect(seen[0]).toContain("credential_resolution_failed");
  });

  test("resolve() delegates to resolveDetailed and yields the same value", async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve(REF, 0)).toBe((await resolver.resolveDetailed(REF, 1)).value);
  });
});
