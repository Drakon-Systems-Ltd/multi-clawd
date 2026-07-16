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
});
