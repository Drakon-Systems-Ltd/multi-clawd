/**
 * The CLI must run without the `openclaw` peer resolvable.
 *
 * `multi-clawd` installs globally with `npm i -g`; `openclaw` is a
 * peerDependency and is only resolvable from the CLI's own directory when it
 * happens to live in the same global root. On a machine where it doesn't,
 * `multi-clawd login` died with
 * "login: built dist/ is missing — reinstall the package." The build was
 * present and complete; `dist/index.js` imports `openclaw/plugin-sdk/*`, that
 * import threw ERR_MODULE_NOT_FOUND, and a bare catch reported it as a missing
 * build. Reinstalling — the one thing the message asks for — cannot fix it.
 *
 * So: no module the CLI loads may reach `openclaw`, and the CLI must not claim
 * "dist is missing" for an import that failed for any other reason.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, existsSync, mkdtempSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

function stagedEnv(stage: string) {
  const home = join(stage, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.XDG_CONFIG_HOME;
  return env;
}

/** Every `from "..."` specifier in a source file. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
}

/** Walk the local import graph from one src module; collect bare specifiers. */
function externalsReachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const visit = (modPath: string) => {
    if (seen.has(modPath) || !existsSync(modPath)) return;
    seen.add(modPath);
    for (const spec of importsOf(modPath)) {
      if (spec.startsWith(".")) {
        visit(join(modPath, "..", spec.replace(/\.js$/, ".ts")));
      } else if (!spec.startsWith("node:")) {
        externals.add(spec);
      }
    }
  };
  visit(entry);
  return externals;
}

/**
 * The dist modules `scripts/cli.mjs` imports, per command. Kept in step with
 * the CLI by the test below, which reads the real import lines rather than
 * trusting this list.
 */
const CLI_ENTRY_MODULES = [
  "login-plan.ts",
  "hermes-core.ts",
  "explain-core.ts",
  "chain-audit.ts",
  "update-core.ts",
  "health.ts",
  "shim-core.ts",
  "credential-state.ts",
  "watchdog-schedule.ts",
];

describe("the CLI runs without the openclaw peer", () => {
  test.each(CLI_ENTRY_MODULES)("%s reaches no openclaw import", (mod) => {
    // Existence is asserted first: a missing entry walks an empty graph and
    // would pass this test while proving nothing.
    expect(existsSync(join(SRC, mod))).toBe(true);
    const externals = [...externalsReachableFrom(join(SRC, mod))];
    expect(externals.filter((e) => e === "openclaw" || e.startsWith("openclaw/"))).toEqual([]);
  });

  test("cli.mjs never imports dist/index.js — that is the module carrying the peer", () => {
    const cli = readFileSync(join(ROOT, "scripts", "cli.mjs"), "utf8");
    expect(cli).not.toMatch(/"dist",\s*"index\.js"/);
  });

  test("login runs where the openclaw peer does not resolve", () => {
    // The actual bug, end to end: copy the shipped files somewhere no
    // node_modules chain provides `openclaw`, and run the command that broke.
    const stage = mkdtempSync(join(tmpdir(), "mc-peer-"));
    try {
      const env = stagedEnv(stage);
      for (const part of ["dist", "scripts", "package.json"]) {
        cpSync(join(ROOT, part), join(stage, part), { recursive: true });
      }
      expect(existsSync(join(stage, "dist", "index.js"))).toBe(true); // build IS complete
      const peer = spawnSync(
        process.execPath,
        ["-e", "import('openclaw/plugin-sdk/plugin-entry').then(()=>console.log('RESOLVES'),()=>console.log('ABSENT'))"],
        { cwd: stage, encoding: "utf8", env },
      );
      expect(peer.stdout.trim()).toBe("ABSENT"); // the staging area is genuinely peer-free

      const run = spawnSync(process.execPath, [join(stage, "scripts", "cli.mjs"), "login"], {
        cwd: stage,
        encoding: "utf8",
        env,
      });
      const out = `${run.stdout}${run.stderr}`;
      // The bar is that login WORKS here, not merely that it fails politely:
      // it must get past module loading and reach its own argument handling.
      // (Asserting only on the wording let the bug back in during review.)
      expect(out).toMatch(/Which account\?|no multi-clawd accounts|could not read/);
      expect(out).not.toMatch(/built dist|cannot load|openclaw.*not.*resolvable/i);
      expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND[\s\S]*openclaw|openclaw[\s\S]*ERR_MODULE_NOT_FOUND/i);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("a genuinely missing module still says so, and names itself", () => {
    const stage = mkdtempSync(join(tmpdir(), "mc-nodist-"));
    try {
      const env = stagedEnv(stage);
      for (const part of ["dist", "scripts", "package.json"]) {
        cpSync(join(ROOT, part), join(stage, part), { recursive: true });
      }
      rmSync(join(stage, "dist", "chain-audit.js"));
      const run = spawnSync(process.execPath, [join(stage, "scripts", "cli.mjs"), "chain"], {
        cwd: stage,
        encoding: "utf8",
        env,
      });
      expect(`${run.stdout}${run.stderr}`).toMatch(/chain-audit\.js is missing/);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("Hermes help runs where the openclaw peer does not resolve", () => {
    const stage = mkdtempSync(join(tmpdir(), "mc-hermes-peer-"));
    try {
      const env = stagedEnv(stage);
      for (const part of ["dist", "scripts", "package.json"]) {
        cpSync(join(ROOT, part), join(stage, part), { recursive: true });
      }
      const run = spawnSync(
        process.execPath,
        [join(stage, "scripts", "cli.mjs"), "hermes", "--help"],
        { cwd: stage, encoding: "utf8", env },
      );
      const out = `${run.stdout}${run.stderr}`;
      expect(run.status, out).toBe(0);
      expect(out).toContain("multi-clawd hermes sync");
      expect(out).not.toMatch(/built dist|cannot load|openclaw.*not.*resolvable/i);
      expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND[\s\S]*openclaw|openclaw[\s\S]*ERR_MODULE_NOT_FOUND/i);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

});
