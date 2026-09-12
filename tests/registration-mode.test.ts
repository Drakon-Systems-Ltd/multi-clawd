import { describe, expect, test } from "vitest";
import plugin, { isRuntimelessRegistration } from "../src/index.js";

/**
 * Mirrors OpenClaw's `createUnavailableRuntime()`: in "cli-metadata" and
 * "setup-only" registration the runtime is a Proxy whose every non-symbol
 * property read throws. Optional chaining does not save a plugin here —
 * `api.runtime?.config` already throws on `.config`.
 */
function throwingRuntime(mode: string): unknown {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key !== "symbol") {
        throw new Error(
          `Plugin "multi-clawd" runtime is intentionally unavailable during "${mode}" registration.`,
        );
      }
      return undefined;
    },
  });
}

function makeApi(mode: string | undefined, runtime: unknown) {
  const backends: unknown[] = [];
  const providers: unknown[] = [];
  const api = {
    ...(mode === undefined ? {} : { registrationMode: mode }),
    config: {},
    pluginConfig: { accounts: [{ id: "claw1", native: true }] },
    runtime,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerCliBackend: (b: unknown) => backends.push(b),
    registerProvider: (p: unknown) => providers.push(p),
    on: () => {},
  };
  return { api, backends, providers };
}

describe("registration modes without a runtime", () => {
  test.each(["cli-metadata", "setup-only"])(
    "%s: register() returns without touching the runtime and registers nothing",
    (mode) => {
      const { api, backends, providers } = makeApi(mode, throwingRuntime(mode));
      expect(() => plugin.register(api as never)).not.toThrow();
      expect(backends).toHaveLength(0);
      expect(providers).toHaveLength(0);
    },
  );

  test.each(["full", "discovery", "tool-discovery", "setup-runtime", undefined])(
    "%s: registration proceeds and the backend registers",
    (mode) => {
      const live = { config: { current: () => ({ plugins: { entries: {} } }) } };
      const { api, backends, providers } = makeApi(mode, live);
      expect(() => plugin.register(api as never)).not.toThrow();
      expect(backends).toHaveLength(1);
      expect(providers).toHaveLength(1);
    },
  );

  test("the guard is a pure predicate on registrationMode", () => {
    expect(isRuntimelessRegistration({ registrationMode: "cli-metadata" })).toBe(true);
    expect(isRuntimelessRegistration({ registrationMode: "setup-only" })).toBe(true);
    expect(isRuntimelessRegistration({ registrationMode: "full" })).toBe(false);
    expect(isRuntimelessRegistration({})).toBe(false);
    expect(isRuntimelessRegistration(null)).toBe(false);
  });
});
