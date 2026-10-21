import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// One coordinated build for the whole run (see vitest.config.ts, #72).
// Individual suites must NOT build; they only assert the shim exists.
export default function setup(): void {
  const root = join(__dirname, "..");
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  if (!existsSync(join(root, "dist", "shim.js"))) {
    throw new Error("global build finished but dist/shim.js is missing");
  }
}
