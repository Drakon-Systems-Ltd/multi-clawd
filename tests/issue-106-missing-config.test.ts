/**
 * #106: every command that needs the OpenClaw config fails the same way when
 * the file is missing, unreadable or malformed: exit 1 and one stderr line
 * naming the RESOLVED path (no literal `~`) plus the next step, never a raw
 * Node error (`ENOENT: no such file or directory, open ...`). The causes stay
 * distinct — missing (with an "install OpenClaw first" hint when ~/.openclaw
 * itself is absent), permission denied, malformed JSON — and malformed JSON
 * never echoes file content, which may hold credentials.
 *
 * Every spawn uses a fixture-only HOME. PATH is an empty scratch dir (no
 * `openclaw`/`claude`/`hermes`) and the proxies point at a dead port, so
 * nothing can reach a provider. Diagnosing must not write anywhere in HOME.
 */
import { describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "scripts", "cli.mjs");

// [stderr prefix, argv]. `account disable` is the one that leaked a raw ENOENT.
const COMMANDS: Array<[string, string[]]> = [
  ["usage", ["usage"]],
  ["chain", ["chain"]],
  ["explain", ["explain"]],
  ["direct", ["direct"]],
  ["account", ["account", "disable", "claw1"]],
  ["account", ["account", "disable", "claw1", "--dry-run"]],
  ["login", ["login", "claw1"]],
  ["hermes", ["hermes", "doctor"]],
];

type Fixture = { root: string; home: string; configDir: string; config: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mc-106-"));
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "hermes-home"));
  const configDir = join(home, ".openclaw");
  return { root, home, configDir, config: join(configDir, "openclaw.json") };
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      out.push(`${p}:${st.isDirectory() ? "d" : `${st.size}:${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function run(f: Fixture, args: string[]) {
  const before = snapshot(f.home);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 20000,
    input: "",
    env: {
      PATH: join(f.root, "bin"),
      HOME: f.home,
      USERPROFILE: f.home,
      HERMES_HOME: join(f.root, "hermes-home"),
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
    },
  });
  const after = snapshot(f.home);
  return { status: r.status, out: r.stdout, err: r.stderr, before, after };
}

function withFixture(fn: (f: Fixture) => void) {
  const f = fixture();
  try {
    fn(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

const RAW_NODE_ERROR = /ENOENT|EACCES|no such file or directory|Unexpected token|~\/\.openclaw/;

describe("missing OpenClaw config (#106)", () => {
  test.each(COMMANDS)(
    "%s: no ~/.openclaw at all → resolved path, install hint, setup step, exit 1, no raw ENOENT",
    (prefix, args) => {
      withFixture((f) => {
        const r = run(f, args);
        expect(r.status).toBe(1);
        expect(r.err).toContain(`${prefix}: OpenClaw config not found at ${f.config}`);
        expect(r.err).toContain(`(no ${f.configDir} directory)`);
        expect(r.err).toContain("Install and start OpenClaw first");
        expect(r.err).toContain("multi-clawd setup");
        expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
        expect(r.after).toEqual(r.before); // diagnosing never writes
      });
    },
  );

  test("every command prints the identical diagnostic after its own prefix", () => {
    withFixture((f) => {
      const bodies = new Set(
        COMMANDS.map(([prefix, args]) => run(f, args).err.trim().replace(`${prefix}: `, "")),
      );
      expect([...bodies]).toHaveLength(1);
    });
  });

  test.each(COMMANDS)("%s: ~/.openclaw exists but holds no config → setup step, no install hint", (prefix, args) => {
    withFixture((f) => {
      mkdirSync(f.configDir);
      const r = run(f, args);
      expect(r.status).toBe(1);
      expect(r.err).toContain(
        `${prefix}: OpenClaw config not found at ${f.config}. Run \`multi-clawd setup\` to create it.`,
      );
      expect(r.err).not.toContain("Install and start OpenClaw");
      expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
      expect(r.after).toEqual(r.before);
    });
  });
});

describe("malformed and unreadable OpenClaw config stay distinct from missing (#106)", () => {
  test.each(COMMANDS)("%s: malformed JSON is named as such, with the path, and never echoed", (prefix, args) => {
    withFixture((f) => {
      mkdirSync(f.configDir);
      writeFileSync(f.config, '{ "token": "SENTINEL-SECRET-106-NEVER-PRINT", bad json');
      const r = run(f, args);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`${prefix}: OpenClaw config at ${f.config} is malformed JSON`);
      expect(r.err).not.toMatch(/not found|multi-clawd setup` to create/);
      expect(`${r.out}${r.err}`).not.toContain("SENTINEL-SECRET-106");
      expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
      expect(r.after).toEqual(r.before);
    });
  });

  // root reads a mode-000 file, and Windows has no equivalent bit layout.
  const cannotDropRead = process.platform === "win32" || process.getuid?.() === 0;
  test.skipIf(cannotDropRead).each(COMMANDS)(
    "%s: unreadable config is a permission problem, not a missing or malformed one",
    (prefix, args) => {
      withFixture((f) => {
        mkdirSync(f.configDir);
        writeFileSync(f.config, "{}");
        chmodSync(f.config, 0o000);
        try {
          const r = run(f, args);
          expect(r.status).toBe(1);
          expect(r.err).toContain(`${prefix}: OpenClaw config at ${f.config} is not readable: permission denied`);
          expect(r.err).not.toMatch(/not found|malformed/);
          expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
          expect(r.after).toEqual(r.before);
        } finally {
          chmodSync(f.config, 0o600);
        }
      });
    },
  );

  test("hermes doctor --config <missing path> names that path and points at --config, not setup", () => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "openclaw.json");
      const r = run(f, ["hermes", "doctor", "--config", custom]);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`hermes: OpenClaw config not found at ${custom}. Check the --config path`);
      expect(r.err).not.toContain("Install and start OpenClaw");
      expect(r.err).not.toMatch(RAW_NODE_ERROR);
    });
  });

  test("a readable, valid config is never diagnosed", () => {
    withFixture((f) => {
      mkdirSync(f.configDir);
      writeFileSync(
        f.config,
        JSON.stringify({
          plugins: { entries: { "multi-clawd": { config: { accounts: [{ id: "claw1", native: true }] } } } },
        }),
      );
      // login is left out: with a valid account it would start the sign-in flow.
      for (const args of [["usage"], ["chain"], ["explain"], ["direct"], ["account", "disable", "claw1", "--dry-run"], ["hermes", "doctor"]]) {
        const r = run(f, args);
        expect(`${r.out}${r.err}`).not.toMatch(/OpenClaw config (not found|at)/);
      }
    });
  });
});
