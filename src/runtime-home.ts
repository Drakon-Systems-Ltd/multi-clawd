/**
 * Stable home for the backend shim (issue #31).
 *
 * OpenClaw 2026.9.6+ loads plugins from a per-generation capture copy under
 * ~/.openclaw/tmp/plugin-captures/. Deriving the shim path from
 * import.meta.url therefore registers a CLI backend that points into a
 * temporary directory. The gateway holds no handle on shim.js (it is only
 * spawned per request), so pruning that capture kills every clawd/claw2 turn
 * for the life of the process.
 *
 * materialiseRuntime copies the plugin's dist/*.js into a content-addressed
 * directory under the multi-clawd state dir and returns the shim path there.
 * Same content -> same directory, so repeated loads are idempotent and a new
 * build never overwrites files a running shim is using.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MaterialisedRuntime {
  shimPath: string;
  dir: string;
  /** false when the copy failed and the caller must fall back to the load path. */
  stable: boolean;
  error?: string;
}

export function materialiseRuntime(srcDir: string, stateRoot: string): MaterialisedRuntime {
  const fallback = join(srcDir, "shim.js");
  try {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort();
    if (!files.includes("shim.js")) throw new Error(`shim.js missing from ${srcDir}`);
    const hash = createHash("sha256");
    for (const f of files) hash.update(f).update("\0").update(readFileSync(join(srcDir, f))).update("\0");
    const dir = join(stateRoot, "runtime", hash.digest("hex").slice(0, 16));
    const shimPath = join(dir, "shim.js");
    if (existsSync(shimPath)) return { shimPath, dir, stable: true };

    // Build in a private staging dir, then rename into place: a concurrent
    // loader either sees the complete directory or none at all.
    const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    for (const f of files) copyFileSync(join(srcDir, f), join(staging, f));
    // dist is ESM; without this Node would parse the copies as CommonJS.
    writeFileSync(join(staging, "package.json"), JSON.stringify({ type: "module" }) + "\n");
    try {
      renameSync(staging, dir);
    } catch (e) {
      // Lost the race to another loader with identical content: theirs is complete.
      if (!existsSync(shimPath)) throw e;
    }
    return { shimPath, dir, stable: true };
  } catch (e) {
    return { shimPath: fallback, dir: srcDir, stable: false, error: e instanceof Error ? e.message : String(e) };
  }
}
