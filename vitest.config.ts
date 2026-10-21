import { defineConfig } from "vitest/config";

// Build dist/ exactly once, before any test file starts (#72). Suites that
// spawn the compiled shim used to each run `npm run build` in beforeAll;
// vitest runs files in parallel, so concurrent tsc processes rewrote dist/
// under suites that were already importing it.
export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
  },
});
