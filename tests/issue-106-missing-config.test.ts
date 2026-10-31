/**
 * #106: every command that needs the OpenClaw config fails the same way when
 * the file is missing, unreadable or malformed: exit 1 and one stderr line
 * naming the RESOLVED path (no literal `~`) plus the next step, never a raw
 * Node error (`ENOENT: no such file or directory, open ...`). The causes stay
 * distinct — missing (with an "install OpenClaw first" hint when ~/.openclaw
 * itself is absent), permission denied, not a regular file, malformed JSON —
 * and malformed JSON never echoes file content, which may hold credentials.
 * The next step depends on the path: `multi-clawd setup` only writes the
 * default path, so a hermes `--config <path>` is told to repair that path or
 * correct the option instead.
 *
 * Every spawn uses a fixture-only HOME. PATH is an empty scratch dir (no
 * `openclaw`/`claude`/`hermes`) and the proxies point at a dead port, so
 * nothing can reach a provider. Diagnosing must not write anywhere in HOME.
 */
import { describe, expect, test } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  ["hermes", ["hermes", "sync", "--dry-run"]],
];

// The two hermes entry points that take `--config <path>`.
const HERMES: Array<[string, string[]]> = [
  ["hermes doctor", ["hermes", "doctor"]],
  ["hermes sync --dry-run", ["hermes", "sync", "--dry-run"]],
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
      const st = lstatSync(p); // lstat: a symlink (even a loop) is itself an entry
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

  test.each(HERMES)("%s --config <missing path> names that path and points at --config, not setup", (_, args) => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "openclaw.json");
      const r = run(f, [...args, "--config", custom]);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`hermes: OpenClaw config not found at ${custom}. Check the --config path`);
      expect(r.err).not.toContain("Install and start OpenClaw");
      expect(r.err).not.toMatch(RAW_NODE_ERROR);
    });
  });
});

// hermes reads the config through its own size-capped fd reader, whose
// "not a regular file" guard used to answer "unavailable or too large" before
// the shared diagnostic could; and the shared text used to send every such
// path to `multi-clawd setup`, which cannot repair a custom `--config` path.
describe("something other than a regular file at the config path (#106)", () => {
  const NOT_REGULAR = "is not a regular file";
  const SETUP_STEP = "Move whatever is at that path aside, then run `multi-clawd setup`";
  const CUSTOM_STEP = "correct the --config path";
  const OLD_HERMES_GUARD = /unavailable or too large/;

  test.each(COMMANDS)("%s: a directory at the default path → not-a-regular-file, setup step, exit 1", (prefix, args) => {
    withFixture((f) => {
      mkdirSync(f.config, { recursive: true });
      const r = run(f, args);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`${prefix}: OpenClaw config at ${f.config} ${NOT_REGULAR} (it is a directory)`);
      expect(r.err).toContain(SETUP_STEP);
      expect(r.err).not.toContain(CUSTOM_STEP);
      expect(r.err).not.toMatch(OLD_HERMES_GUARD);
      expect(r.err).not.toMatch(/not found|malformed|permission denied/);
      expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
      expect(r.after).toEqual(r.before);
    });
  });

  test("the directory diagnostic is identical across every command", () => {
    withFixture((f) => {
      mkdirSync(f.config, { recursive: true });
      const bodies = new Set(
        COMMANDS.map(([prefix, args]) => run(f, args).err.trim().replace(`${prefix}: `, "")),
      );
      expect([...bodies]).toHaveLength(1);
    });
  });

  test.each(HERMES)("%s: a symlink loop at the default path → not-a-regular-file, setup step", (_, args) => {
    withFixture((f) => {
      mkdirSync(f.configDir);
      symlinkSync(f.config, f.config);
      const r = run(f, args);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`hermes: OpenClaw config at ${f.config} ${NOT_REGULAR} (it is a symbolic-link loop)`);
      expect(r.err).toContain(SETUP_STEP);
      expect(r.err).not.toMatch(OLD_HERMES_GUARD);
      expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
    });
  });

  // Custom paths: `multi-clawd setup` writes only the default path, so the
  // next step must be to repair the named path or fix `--config`, never setup.
  const CUSTOM: Array<[string, (root: string) => string, string]> = [
    ["a directory", (root) => { const p = join(root, "cdir"); mkdirSync(p); return p; }, "it is a directory"],
    ["a symlink loop", (root) => { const p = join(root, "loop"); symlinkSync(p, p); return p; }, "it is a symbolic-link loop"],
    [
      "a parent that is a regular file",
      (root) => { writeFileSync(join(root, "afile"), "x"); return join(root, "afile", "openclaw.json"); },
      "a parent in the path is not a directory",
    ],
  ];
  for (const [what, make, why] of CUSTOM) {
    test.each(HERMES)(`%s --config <${what}> → repair that path or fix --config, never setup`, (_, args) => {
      withFixture((f) => {
        const custom = make(f.root);
        const r = run(f, [...args, "--config", custom]);
        expect(r.status).toBe(1);
        expect(r.err).toContain(`hermes: OpenClaw config at ${custom} ${NOT_REGULAR} (${why})`);
        expect(r.err).toContain(CUSTOM_STEP);
        expect(r.err).not.toContain(SETUP_STEP);
        expect(r.err).not.toMatch(/`multi-clawd setup`(?! only writes)/);
        expect(r.err).not.toMatch(OLD_HERMES_GUARD);
        expect(`${r.out}${r.err}`).not.toMatch(RAW_NODE_ERROR);
        expect(r.after).toEqual(r.before);
      });
    });
  }
});

describe("a readable, valid config is never diagnosed (#106)", () => {
  const VALID = JSON.stringify({
    plugins: { entries: { "multi-clawd": { config: { accounts: [{ id: "claw1", native: true }] } } } },
  });
  const DIAGNOSED = /OpenClaw config (not found|at)|unavailable or too large/;

  // Each command must get past the config check and do its real work: exit 0
  // with its own banner, or (hermes) exit 1 only for the later, unrelated
  // reason that no Hermes executable is on the scratch PATH. `login` is left
  // out: with a valid account it would start the sign-in flow.
  const HEALTHY: Array<[string, string[], number, RegExp, RegExp]> = [
    ["usage", ["usage"], 0, /multi-clawd — live usage[\s\S]*claw1/, /^$/],
    ["chain", ["chain"], 0, /multi-clawd — model routing/, /^$/],
    ["explain", ["explain"], 0, /ACCOUNTS[\s\S]*claw1/, /^$/],
    ["direct", ["direct"], 0, /multi-clawd — direct anthropic\/\* route/, /^$/],
    ["account", ["account", "disable", "claw1", "--dry-run"], 0, /^dry run: claw1: disabled$/m, /^$/],
    ["hermes doctor", ["hermes", "doctor"], 1, /claw1/, /^hermes: Hermes executable is not on PATH/],
    ["hermes sync --dry-run", ["hermes", "sync", "--dry-run"], 1, /claw1/, /^hermes: Hermes executable is not on PATH/],
  ];
  test.each(HEALTHY)("%s: expected status and its own output", (_, args, status, out, err) => {
    withFixture((f) => {
      mkdirSync(f.configDir);
      writeFileSync(f.config, VALID);
      const r = run(f, args);
      expect(`${r.out}${r.err}`).not.toMatch(DIAGNOSED);
      expect(r.status).toBe(status);
      expect(r.out).toMatch(out);
      expect(r.err).toMatch(err);
    });
  });
});
