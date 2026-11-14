// TEST FIXTURE ONLY (multi-clawd#155). Never shipped: `tests/` is not in the
// package's `files` list.
//
// The harness copies this file into a scratch plugin directory as `index.mjs`,
// next to a copy of the repository's built `dist/` and its real manifest. The
// gateway child then loads the REAL plugin build through this wrapper in every
// variant, so the only difference between variants is one environment
// variable:
//
//   MC155_MODEL_PROVIDER unset/""  -> M0: the plugin exactly as built.
//   MC155_MODEL_PROVIDER "own-id"  -> M1: every backend the plugin registers
//                                     also declares `modelProvider` = its own
//                                     backend id (claw1, claw2, clawd).
//
// The `anthropic` alias variant (M2 in the design note) is deliberately NOT
// implemented here.
import plugin from "./dist/index.js";

const variant = process.env.MC155_MODEL_PROVIDER ?? "";
if (variant !== "" && variant !== "own-id") {
  throw new Error(`mc155 wrapper: unsupported MC155_MODEL_PROVIDER=${JSON.stringify(variant)}`);
}

export default {
  ...plugin,
  register(api) {
    if (variant !== "own-id") return plugin.register(api);
    const wrapped = new Proxy(api, {
      get(target, prop) {
        if (prop === "registerCliBackend") {
          return (backend) => target.registerCliBackend({ ...backend, modelProvider: backend.id });
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return plugin.register(wrapped);
  },
};
