/**
 * #116: the CLI, doctor, setup and the watchdog launcher operate on the
 * OpenClaw instance the environment points at, never silently on the default
 * one. OpenClaw documents two variables for relocated or multi-instance
 * installs: `OPENCLAW_CONFIG_PATH` (the config file) and `OPENCLAW_STATE_DIR`
 * (sessions, credentials, caches, and the default config location
 * `<state>/openclaw.json`); `OPENCLAW_HOME` replaces the home directory that
 * the `~/.openclaw` default hangs off. One resolver (scripts/_shared.mjs for
 * the scripts, src/openclaw-paths.ts for the plugin and shim) owns that
 * selection, and the two must agree.
 *
 * Every spawn uses a fixture-only HOME; PATH is a scratch dir (no `openclaw`,
 * `claude` or `hermes` unless a test stubs one) and the proxies point at a
 * dead port, so nothing reaches a provider and no real config is touched.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Both resolvers, imported as the code imports them.
import * as scriptsPaths from "../scripts/_shared.mjs";
import * as srcPaths from "../src/openclaw-paths.js";
import { renderWatchdogLauncher, renderWatchdogUnit, isFragileWatchdogTarget } from "../src/watchdog-schedule.js";

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "scripts", "cli.mjs");

type Fixture = { root: string; home: string; bin: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mc-116-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(root, "hermes-home"));
  return { root, home, bin };
}

function withFixture(fn: (f: Fixture) => void) {
  const f = fixture();
  try {
    fn(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      out.push(`${p}:${st.isDirectory() ? "d" : `${st.size}:${readFileSync(p).toString("base64")}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function run(f: Fixture, args: string[], env: Record<string, string> = {}, script = CLI, input = "") {
  const before = snapshot(f.home);
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30000,
    input,
    env: {
      PATH: f.bin,
      HOME: f.home,
      USERPROFILE: f.home,
      HERMES_HOME: join(f.root, "hermes-home"),
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ...env,
    },
  });
  const after = snapshot(f.home);
  return { status: r.status, out: r.stdout, err: r.stderr, before, after };
}

const config = (accounts: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    plugins: { entries: { "multi-clawd": { enabled: true, config: {
      accounts: accounts.map((id) => ({ id, native: true })),
      pool: { id: "clawd", accounts },
    } } } },
    agents: { defaults: { model: { primary: "clawd/claude-fable-5" } } },
    ...extra,
  }, null, 2) + "\n";

const writeConfig = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

// A stub executable on the scratch PATH (fixture only).
const stub = (f: Fixture, name: string, body: string) => {
  writeFileSync(join(f.bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(f.bin, name), 0o755);
};

// Every command that reads the OpenClaw config, with what its healthy output
// looks like once it has the config the environment points at.
const READERS: Array<[string, string[], RegExp]> = [
  ["explain", ["explain"], /ACCOUNTS[\s\S]*claw1/],
  ["chain", ["chain"], /multi-clawd — model routing/],
  ["usage", ["usage"], /multi-clawd — live usage[\s\S]*claw1/],
  ["direct", ["direct"], /multi-clawd — direct anthropic\/\* route/],
  ["account --dry-run", ["account", "disable", "claw1", "--dry-run"], /^dry run: claw1: disabled$/m],
  ["hermes doctor", ["hermes", "doctor"], /claw1/],
];

describe("one resolver for the OpenClaw config and state location (#116)", () => {
  const HOME = "/fixture/home";
  const CASES: Array<[string, Record<string, string>, { stateDir: string; configPath: string; stateSource: string; configSource: string }]> = [
    ["nothing set: ~/.openclaw and ~/.openclaw/openclaw.json", {},
      { stateDir: "/fixture/home/.openclaw", configPath: "/fixture/home/.openclaw/openclaw.json", stateSource: "default", configSource: "default" }],
    ["OPENCLAW_STATE_DIR moves state AND the default config under it", { OPENCLAW_STATE_DIR: "/inst/a" },
      { stateDir: "/inst/a", configPath: "/inst/a/openclaw.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_STATE_DIR" }],
    ["OPENCLAW_CONFIG_PATH moves only the config", { OPENCLAW_CONFIG_PATH: "/etc/oc/b.json" },
      { stateDir: "/fixture/home/.openclaw", configPath: "/etc/oc/b.json", stateSource: "default", configSource: "OPENCLAW_CONFIG_PATH" }],
    ["both: the config path wins over <state>/openclaw.json", { OPENCLAW_STATE_DIR: "/inst/a", OPENCLAW_CONFIG_PATH: "/etc/oc/b.json" },
      { stateDir: "/inst/a", configPath: "/etc/oc/b.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_CONFIG_PATH" }],
    ["OPENCLAW_HOME replaces the home the default hangs off", { OPENCLAW_HOME: "/srv/ochome" },
      { stateDir: "/srv/ochome/.openclaw", configPath: "/srv/ochome/.openclaw/openclaw.json", stateSource: "OPENCLAW_HOME", configSource: "OPENCLAW_HOME" }],
    ["OPENCLAW_STATE_DIR beats OPENCLAW_HOME", { OPENCLAW_HOME: "/srv/ochome", OPENCLAW_STATE_DIR: "/inst/a" },
      { stateDir: "/inst/a", configPath: "/inst/a/openclaw.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_STATE_DIR" }],
    ["a leading ~ expands against the effective home", { OPENCLAW_STATE_DIR: "~/.openclaw-a", OPENCLAW_CONFIG_PATH: "~/.openclaw/a.json" },
      { stateDir: "/fixture/home/.openclaw-a", configPath: "/fixture/home/.openclaw/a.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_CONFIG_PATH" }],
    ["~ expands against OPENCLAW_HOME when that is set", { OPENCLAW_HOME: "/srv/ochome", OPENCLAW_STATE_DIR: "~/.openclaw-a" },
      { stateDir: "/srv/ochome/.openclaw-a", configPath: "/srv/ochome/.openclaw-a/openclaw.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_STATE_DIR" }],
    ["blank values are not set", { OPENCLAW_STATE_DIR: "   ", OPENCLAW_CONFIG_PATH: "", OPENCLAW_HOME: " " },
      { stateDir: "/fixture/home/.openclaw", configPath: "/fixture/home/.openclaw/openclaw.json", stateSource: "default", configSource: "default" }],
    ["surrounding whitespace is trimmed", { OPENCLAW_STATE_DIR: " /inst/a " },
      { stateDir: "/inst/a", configPath: "/inst/a/openclaw.json", stateSource: "OPENCLAW_STATE_DIR", configSource: "OPENCLAW_STATE_DIR" }],
  ];

  test.each(CASES)("%s", (_, env, expected) => {
    for (const impl of [scriptsPaths, srcPaths]) {
      const p = impl.resolveOpenclawPaths(env, HOME);
      expect(p).toMatchObject(expected);
      expect(p.multiClawdStateDir).toBe(join(expected.stateDir, "state", "multi-clawd"));
      expect(p.agentsDir).toBe(join(expected.stateDir, "agents"));
      expect(p.extensionsDir).toBe(join(expected.stateDir, "extensions"));
      expect(p.npmProjectsDir).toBe(join(expected.stateDir, "npm", "projects"));
    }
  });

  test("a relative value resolves against the working directory, like OpenClaw", () => {
    for (const impl of [scriptsPaths, srcPaths]) {
      expect(impl.resolveOpenclawPaths({ OPENCLAW_STATE_DIR: "rel/state" }, HOME).stateDir).toBe(resolve("rel/state"));
    }
  });

  test("the scripts and plugin resolvers agree on every case (same code, two homes)", () => {
    for (const [, env] of CASES) {
      expect(srcPaths.resolveOpenclawPaths(env, HOME)).toEqual(scriptsPaths.resolveOpenclawPaths(env, HOME));
      expect(srcPaths.openclawInstanceEnv(env, HOME)).toEqual(scriptsPaths.openclawInstanceEnv(env, HOME));
    }
  });

  test("the variables pinned into a unit are the set ones, resolved (no ~, no blanks)", () => {
    for (const impl of [scriptsPaths, srcPaths]) {
      expect(impl.openclawInstanceEnv({}, HOME)).toEqual({});
      expect(impl.openclawInstanceEnv({ OPENCLAW_STATE_DIR: "  ", OPENCLAW_CONFIG_PATH: "" }, HOME)).toEqual({});
      expect(impl.openclawInstanceEnv({ OPENCLAW_STATE_DIR: "~/.openclaw-a" }, HOME)).toEqual({ OPENCLAW_STATE_DIR: "/fixture/home/.openclaw-a" });
      expect(impl.openclawInstanceEnv({ OPENCLAW_HOME: "/srv/ochome", OPENCLAW_CONFIG_PATH: "~/a.json" }, HOME))
        .toEqual({ OPENCLAW_HOME: "/srv/ochome", OPENCLAW_CONFIG_PATH: "/srv/ochome/a.json" });
    }
  });

  // The guard that keeps this fixed: no other source file may build an
  // OpenClaw path from the home directory itself. (Comments mention
  // `~/.openclaw/...` as prose; the literal with quotes is what code uses.)
  test("no source outside the resolvers hard-codes the .openclaw directory", () => {
    // watchdog-schedule.ts renders the self-contained launcher, which embeds
    // the resolver by design (no package imports may survive an install move).
    const allowed = new Set(["scripts/_shared.mjs", "src/openclaw-paths.ts", "src/watchdog-schedule.ts"]);
    const offenders: string[] = [];
    for (const dir of ["scripts", "src"]) {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (!/\.(ts|mjs)$/.test(name)) continue;
        const rel = `${dir}/${name}`;
        if (allowed.has(rel)) continue;
        const src = readFileSync(join(ROOT, rel), "utf8");
        if (/["'`]\.openclaw["'`]/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("CLI commands read the config the environment points at (#116)", () => {
  test.each(READERS)("%s: OPENCLAW_CONFIG_PATH → that file, with no default config present", (_, args, healthy) => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "other.json");
      writeConfig(custom, config(["claw1"]));
      const r = run(f, args, { OPENCLAW_CONFIG_PATH: custom });
      expect(`${r.out}${r.err}`).not.toMatch(/OpenClaw config not found/);
      expect(r.out).toMatch(healthy);
      expect(r.after).toEqual(r.before); // reading never writes into HOME
    });
  });

  test.each(READERS)("%s: OPENCLAW_STATE_DIR → <state>/openclaw.json, not the default config", (_, args, healthy) => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      writeConfig(join(state, "openclaw.json"), config(["claw1"]));
      // A DIFFERENT default config exists: it must not be the one read.
      writeConfig(join(f.home, ".openclaw", "openclaw.json"), config(["decoy"]));
      const r = run(f, args, { OPENCLAW_STATE_DIR: state });
      expect(r.out).toMatch(healthy);
      expect(`${r.out}${r.err}`).not.toContain("decoy");
      expect(r.after).toEqual(r.before);
    });
  });

  test("not found under OPENCLAW_CONFIG_PATH names that path and the variable, never the default path", () => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "other.json");
      for (const [prefix, args] of [["explain", ["explain"]], ["account", ["account", "disable", "claw1"]]] as Array<[string, string[]]>) {
        const r = run(f, args, { OPENCLAW_CONFIG_PATH: custom });
        expect(r.status).toBe(1);
        expect(r.err).toContain(`${prefix}: OpenClaw config not found at ${custom} (OPENCLAW_CONFIG_PATH is set).`);
        expect(r.err).not.toContain(join(f.home, ".openclaw"));
        expect(r.err).not.toContain("Install and start OpenClaw first");
        expect(r.after).toEqual(r.before);
      }
    });
  });

  test("not found under OPENCLAW_STATE_DIR names <state>/openclaw.json and the variable", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      const r = run(f, ["chain"], { OPENCLAW_STATE_DIR: state });
      expect(r.status).toBe(1);
      expect(r.err).toContain(`chain: OpenClaw config not found at ${join(state, "openclaw.json")} (OPENCLAW_STATE_DIR is set).`);
      expect(r.err).not.toContain(join(f.home, ".openclaw"));
      expect(r.after).toEqual(r.before);
    });
  });

  test("the default diagnostic is unchanged when neither variable is set", () => {
    withFixture((f) => {
      const r = run(f, ["explain"]);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`explain: OpenClaw config not found at ${join(f.home, ".openclaw", "openclaw.json")} (no ${join(f.home, ".openclaw")} directory). Install and start OpenClaw first, then run \`multi-clawd setup\`.`);
      expect(r.err).not.toContain("OPENCLAW_");
    });
  });
});

describe("writes land on the pointed-at instance only (#116)", () => {
  test("account disable edits the OPENCLAW_CONFIG_PATH file; the default config is byte-identical afterwards", () => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "other.json");
      const dflt = join(f.home, ".openclaw", "openclaw.json");
      writeConfig(custom, config(["claw1", "claw2"]));
      writeConfig(dflt, config(["claw1", "claw2"]));
      const r = run(f, ["account", "disable", "claw1"], { OPENCLAW_CONFIG_PATH: custom });
      expect(r.status).toBe(0);
      expect(r.out).toContain("claw1: disabled");
      const edited = JSON.parse(readFileSync(custom, "utf8"));
      expect(edited.plugins.entries["multi-clawd"].config.accounts[0]).toMatchObject({ id: "claw1", disabled: true });
      expect(readFileSync(dflt, "utf8")).toBe(config(["claw1", "claw2"]));
      expect(r.after).toEqual(r.before); // not even a backup appears under HOME
      const backups = readdirSync(join(f.root, "elsewhere")).filter((n) => n.startsWith("other.json.backup-"));
      expect(backups).toHaveLength(1);
      expect(r.out).toContain(join(f.root, "elsewhere", backups[0]));
    });
  });

  test("account disable under OPENCLAW_STATE_DIR edits <state>/openclaw.json and nothing in HOME", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      writeConfig(join(state, "openclaw.json"), config(["claw1"]));
      const r = run(f, ["account", "disable", "claw1"], { OPENCLAW_STATE_DIR: state });
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(join(state, "openclaw.json"), "utf8")).plugins.entries["multi-clawd"].config.accounts[0].disabled).toBe(true);
      expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
    });
  });
});

describe("pool state is read from the pointed-at state dir (#116)", () => {
  // explain reports the pool's sticky rotation from
  // <state>/state/multi-clawd/pool-<id>.sticky.json. Plant a rotation in one
  // state dir only and check explain sees exactly that one.
  const sticky = JSON.stringify({ account: "claw2", since: Date.now() - 60000 });
  const ROTATED = /pool is (on|rotated onto) claw2/;

  test("OPENCLAW_STATE_DIR: the instance's sticky file is shown, the default one is ignored", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      writeConfig(join(state, "openclaw.json"), config(["claw1", "claw2"]));
      writeConfig(join(state, "state", "multi-clawd", "pool-clawd.sticky.json"), sticky);
      const seen = run(f, ["explain"], { OPENCLAW_STATE_DIR: state });
      expect(seen.status).toBe(0);
      expect(seen.out).toMatch(ROTATED);

      rmSync(join(state, "state"), { recursive: true });
      writeConfig(join(f.home, ".openclaw", "state", "multi-clawd", "pool-clawd.sticky.json"), sticky);
      const ignored = run(f, ["explain"], { OPENCLAW_STATE_DIR: state });
      expect(ignored.status).toBe(0);
      expect(ignored.out).not.toMatch(ROTATED);
    });
  });

  test("OPENCLAW_CONFIG_PATH alone leaves state at the default location", () => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "other.json");
      writeConfig(custom, config(["claw1", "claw2"]));
      writeConfig(join(f.home, ".openclaw", "state", "multi-clawd", "pool-clawd.sticky.json"), sticky);
      const r = run(f, ["explain"], { OPENCLAW_CONFIG_PATH: custom });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(ROTATED);
    });
  });
});

describe("doctor and setup follow the environment (#116)", () => {
  function instance(f: Fixture, state: string, configPath = join(state, "openclaw.json")) {
    const extension = join(state, "extensions", "multi-clawd");
    const mcState = join(state, "state", "multi-clawd");
    mkdirSync(extension, { recursive: true });
    mkdirSync(mcState, { recursive: true });
    copyFileSync(join(ROOT, "openclaw.plugin.json"), join(extension, "openclaw.plugin.json"));
    writeFileSync(join(mcState, "registry-check.json"), JSON.stringify({ latest: "0.0.1", checkedAt: Date.now() }));
    writeConfig(configPath, config(["claw1"]));
    // A healthy scheduler query, so the watchdog section has nothing to ask.
    stub(f, "systemctl", 'echo "NEXT LEFT LAST PASSED UNIT ACTIVATES"');
    return extension;
  }

  test("doctor: OPENCLAW_STATE_DIR selects the install, config and state of that instance and writes nothing under HOME", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      const extension = instance(f, state);
      const r = run(f, [], { OPENCLAW_STATE_DIR: state }, join(ROOT, "scripts", "doctor.mjs"));
      expect(r.out).toContain(`installed at ${extension}`);
      expect(r.out).toContain(`config ${join(state, "openclaw.json")} (OPENCLAW_STATE_DIR is set)`);
      expect(r.out).toContain("plugin entry enabled");
      expect(r.out).not.toContain(join(f.home, ".openclaw"));
      expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
    });
  });

  test("doctor: OPENCLAW_CONFIG_PATH is read instead of <state>/openclaw.json and reported", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      const custom = join(f.root, "elsewhere", "other.json");
      instance(f, state, custom);
      const r = run(f, [], { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: custom }, join(ROOT, "scripts", "doctor.mjs"));
      expect(r.out).toContain(`config ${custom} (OPENCLAW_CONFIG_PATH is set)`);
      expect(r.out).toContain("plugin entry enabled");
    });
  });

  test("doctor without either variable reports the default path without a source note", () => {
    withFixture((f) => {
      const state = join(f.home, ".openclaw");
      instance(f, state);
      const r = run(f, [], {}, join(ROOT, "scripts", "doctor.mjs"));
      expect(r.out).toContain(`config ${join(state, "openclaw.json")}\n`);
      expect(r.out).not.toContain("is set)");
    });
  });

  test("setup --dry-run names the instance config and the instance launcher, and writes nothing", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      const custom = join(f.root, "elsewhere", "other.json");
      writeConfig(custom, config(["claw1"]));
      stub(f, "claude", "echo 1.0.0");
      const r = run(f, ["--dry-run"], { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: custom }, join(ROOT, "scripts", "setup.mjs"), "n\nn\n");
      expect(r.status).toBe(0);
      expect(r.out).toContain(`This wizard edits ${custom} (OPENCLAW_CONFIG_PATH is set)`);
      expect(r.out).toContain(join(state, "state", "multi-clawd", "watchdog-launcher.mjs"));
      expect(r.out).not.toContain(join(f.home, ".openclaw"));
      expect(r.after).toEqual(r.before);
      expect(existsSync(join(state, "state"))).toBe(false);
    });
  });

  test("setup preflight on a malformed instance config names that path", () => {
    withFixture((f) => {
      const custom = join(f.root, "elsewhere", "other.json");
      writeConfig(custom, "{ not json");
      stub(f, "claude", "echo 1.0.0");
      const r = run(f, ["--dry-run"], { OPENCLAW_CONFIG_PATH: custom }, join(ROOT, "scripts", "setup.mjs"), "n\nn\n");
      expect(r.status).toBe(1);
      expect(r.err).toContain(`preflight: ${custom} exists but is not valid JSON`);
    });
  });
});

describe("the watchdog launcher and units carry the instance (#116)", () => {
  test("the rendered launcher finds the install under OPENCLAW_STATE_DIR and runs its watchdog", () => {
    withFixture((f) => {
      const state = join(f.root, "instance-a");
      const scripts = join(state, "extensions", "multi-clawd", "scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(state, "extensions", "multi-clawd", "openclaw.plugin.json"), "{}");
      writeFileSync(join(scripts, "eviction-watchdog.mjs"), 'console.log("WATCHDOG_RAN " + process.env.OPENCLAW_STATE_DIR);\n');
      const launcher = join(f.root, "watchdog-launcher.mjs");
      writeFileSync(launcher, renderWatchdogLauncher());
      const found = run(f, [], { OPENCLAW_STATE_DIR: state }, launcher);
      expect(found.status).toBe(0);
      expect(found.out).toContain(`WATCHDOG_RAN ${state}`);
      // Same launcher, no variable: the default (empty) instance has no install.
      const none = run(f, [], {}, launcher);
      expect(none.status).toBe(0);
      expect(none.out).not.toContain("WATCHDOG_RAN");
      expect(none.err).toContain("no multi-clawd install found");
      expect(none.err).toContain(join(f.home, ".openclaw"));
    });
  });

  test("the rendered launcher honours OPENCLAW_HOME for the default location", () => {
    withFixture((f) => {
      const ochome = join(f.root, "ochome");
      const scripts = join(ochome, ".openclaw", "extensions", "multi-clawd", "scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(ochome, ".openclaw", "extensions", "multi-clawd", "openclaw.plugin.json"), "{}");
      writeFileSync(join(scripts, "eviction-watchdog.mjs"), 'console.log("WATCHDOG_RAN");\n');
      const launcher = join(f.root, "watchdog-launcher.mjs");
      writeFileSync(launcher, renderWatchdogLauncher());
      const r = run(f, [], { OPENCLAW_HOME: ochome }, launcher);
      expect(r.out).toContain("WATCHDOG_RAN");
    });
  });

  test("units rendered for a non-default instance pin its variables; default units are unchanged", () => {
    const base = { nodePath: "/usr/bin/node", scriptPath: "/inst/a/state/multi-clawd/watchdog-launcher.mjs" };
    const env = { OPENCLAW_STATE_DIR: "/inst/a", OPENCLAW_CONFIG_PATH: "/etc/oc/a.json" };
    const [service] = renderWatchdogUnit({ platform: "linux", ...base, env });
    expect(service.content).toContain('Environment="OPENCLAW_STATE_DIR=/inst/a"');
    expect(service.content).toContain('Environment="OPENCLAW_CONFIG_PATH=/etc/oc/a.json"');
    expect(service.content.indexOf("Environment=")).toBeLessThan(service.content.indexOf("ExecStart="));
    const [plist] = renderWatchdogUnit({ platform: "darwin", ...base, env });
    expect(plist.content).toContain("<key>EnvironmentVariables</key>");
    expect(plist.content).toContain("<key>OPENCLAW_STATE_DIR</key>\n    <string>/inst/a</string>");
    expect(plist.content).toContain("<key>OPENCLAW_CONFIG_PATH</key>\n    <string>/etc/oc/a.json</string>");
    for (const platform of ["linux", "darwin"]) {
      const plain = renderWatchdogUnit({ platform, ...base });
      expect(plain[0].content).not.toMatch(/Environment|OPENCLAW_/);
      expect(renderWatchdogUnit({ platform, ...base, env: {} })).toEqual(plain);
    }
  });

  test("an npm-project path under a relocated state dir is still fragile", () => {
    expect(isFragileWatchdogTarget("/inst/a/npm/projects/drakon-systems-multi-clawd-x/node_modules/@drakon-systems/multi-clawd/scripts/eviction-watchdog.mjs")).toBe(true);
    expect(isFragileWatchdogTarget("/inst/a/extensions/multi-clawd/scripts/eviction-watchdog.mjs")).toBe(false);
    expect(isFragileWatchdogTarget("/inst/a/state/multi-clawd/watchdog-launcher.mjs")).toBe(false);
  });
});

describe("docs name the variables (#116)", () => {
  test("README documents OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR and OPENCLAW_HOME", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const v of ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME"]) expect(readme).toContain(`\`${v}\``);
    expect(readme).toMatch(/OPENCLAW_PROFILE/);
  });
});
