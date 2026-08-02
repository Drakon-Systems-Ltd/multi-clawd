import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { HERMES, SKIP_REASON, isolatedEnv, writeAuthStore } from "./hermes-support";

const CLI = resolve("scripts/cli.mjs");
const TOKEN = "sk-ant-oat01-fake-hermes-cli-setup-token-never-print";
const OTHER_TOKEN = "sk-ant-oat01-fake-hermes-cli-second-token-never-print";

type Fixture = {
  root: string;
  home: string;
  hermesHome: string;
  config: string;
  tokenFile: string;
};

function writeConfig(f: Fixture, pluginConfig: unknown): void {
  writeFileSync(
    f.config,
    JSON.stringify({ plugins: { entries: { "multi-clawd": { config: pluginConfig } } } }),
  );
}

function fixture(pluginConfig?: unknown): Fixture {
  const root = mkdtempSync(join(tmpdir(), "multi-clawd-hermes-cli-"));
  const home = join(root, "home");
  const hermesHome = join(root, "hermes-home");
  mkdirSync(home, { recursive: true });
  const tokenFile = join(root, "claw1.token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const f: Fixture = { root, home, hermesHome, config: join(root, "openclaw.json"), tokenFile };
  writeConfig(f, pluginConfig ?? { accounts: [{ id: "claw1", oauthTokenFile: tokenFile }] });
  return f;
}

function run(f: Fixture, args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env = isolatedEnv(f.home, f.hermesHome);
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function hermes(f: Fixture, command: "sync" | "doctor", options: string[] = []) {
  return run(f, ["hermes", command, "--config", f.config, ...options]);
}

function expectNoSecrets(output: string) {
  expect(output).not.toContain(TOKEN);
  expect(output).not.toContain(OTHER_TOKEN);
  expect(output).not.toMatch(/sha256:[a-f0-9]+/i);
}

function poolRows(f: Fixture, home = f.hermesHome): any[] {
  const path = join(home, "auth.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).credential_pool?.anthropic ?? [];
}

describe("multi-clawd hermes CLI (no Hermes required)", () => {
  test("top-level help advertises Hermes and Hermes help dispatches", () => {
    const f = fixture();
    const top = run(f, ["--help"]);
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/hermes.*sync or diagnose/i);
    const sub = run(f, ["hermes", "--help"]);
    expect(sub.status).toBe(0);
    expect(sub.stdout).toContain("multi-clawd hermes sync");
    expect(sub.stdout).toContain("multi-clawd hermes doctor");
    expect(sub.stdout).toMatch(/setup-token/);
  });

  test("rejects unsafe profile, invalid strategy, unknown/duplicate options, and missing values", () => {
    const f = fixture();
    for (const args of [
      ["hermes", "sync", "--config", f.config, "--profile", "../escape"],
      ["hermes", "sync", "--config", f.config, "--strategy", "weighted"],
      ["hermes", "sync", "--config", f.config, "--wat"],
      ["hermes", "sync", "--config", f.config, "--dry-run", "--dry-run"],
      ["hermes", "sync", "--config"],
      ["hermes", "doctor", "--config", f.config, "--strategy", "random"],
    ]) {
      const result = run(f, args);
      expect(result.status, `${args.join(" ")}\n${result.output}`).not.toBe(0);
      expectNoSecrets(result.output);
    }
  });

  test("missing and malformed OpenClaw config fail closed before any Hermes work", () => {
    const f = fixture();
    const missing = hermes(f, "sync", ["--config", join(f.root, "missing.json")]);
    expect(missing.status).not.toBe(0);

    writeFileSync(f.config, "{bad json");
    const malformed = hermes(f, "sync");
    expect(malformed.status).not.toBe(0);
    expect(malformed.output).toMatch(/malformed JSON/);
    expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
    for (const output of [missing.output, malformed.output]) expectNoSecrets(output);
  });

  test("rotating and unsupported credential sources are refused with actionable guidance", () => {
    const f = fixture();
    writeConfig(f, {
      accounts: [
        { id: "nativeacct", native: true },
        { id: "dironly", configDir: join(f.root, "account") },
        { id: "refonly", oauthTokenRef: { source: "exec", id: "ignored" } },
        { id: "Bad.Id", oauthTokenFile: f.tokenFile },
      ],
    });
    const result = hermes(f, "sync");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/nativeacct: not importable/);
    expect(result.stdout).toMatch(/dironly: not importable/);
    expect(result.stdout).toMatch(/refonly: not importable/);
    // One unsupported id must not hide the others.
    expect(result.stdout).toMatch(/bad\.id: not importable/i);
    expect(result.stdout).toMatch(/claude setup-token/);
    expect(result.stdout).toMatch(/claude_code/);
    expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
    expectNoSecrets(result.output);
  });

  test("a JSON credentials grant in a token file is refused as a rotating grant", () => {
    const f = fixture();
    writeFileSync(
      f.tokenFile,
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: OTHER_TOKEN } }),
    );
    const result = hermes(f, "sync");
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/rotating grants are single-use/);
    expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
    expectNoSecrets(result.output);
  });

  test("a missing or multi-line token file fails without partial writes", () => {
    const f = fixture();
    writeFileSync(f.tokenFile, `${TOKEN}\nsecond line\n`);
    const multiline = hermes(f, "sync");
    expect(multiline.status).not.toBe(0);
    expect(multiline.output).toMatch(/exactly one line/);

    writeConfig(f, { accounts: [{ id: "claw1", oauthTokenFile: join(f.root, "absent.token") }] });
    const missing = hermes(f, "sync");
    expect(missing.status).not.toBe(0);
    const missingDoctor = hermes(f, "doctor");
    expect(missingDoctor.status).not.toBe(0);
    expect(missingDoctor.stdout).toMatch(/claw1: oauthTokenFile .* missing/);
    expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
    for (const output of [multiline.output, missing.output, missingDoctor.output]) {
      expectNoSecrets(output);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a group/other-readable token file is rejected without partial writes",
    () => {
      const f = fixture();
      // fixture() already created f.tokenFile at 0600; writeFileSync's `mode` option only
      // applies at file creation, so an explicit chmod is required to loosen it here.
      writeFileSync(f.tokenFile, `${TOKEN}\n`);
      chmodSync(f.tokenFile, 0o644);
      const result = hermes(f, "sync");
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/chmod 600/);
      expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
      expectNoSecrets(result.output);
    },
  );
});

describe.skipIf(!HERMES)(`multi-clawd hermes CLI against Hermes (${HERMES?.version ?? SKIP_REASON})`, () => {
  test("dry-run resolves real tokens but writes no Hermes state and leaks nothing", () => {
    const f = fixture();
    const result = hermes(f, "sync", ["--dry-run", "--strategy", "round_robin"]);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toMatch(/DRY RUN: no files were written/);
    expect(result.stdout).toMatch(/add 1, update 0, noop 0/);
    expect(existsSync(join(f.hermesHome, "auth.json"))).toBe(false);
    expect(existsSync(join(f.hermesHome, "config.yaml"))).toBe(false);
    expectNoSecrets(result.output);
  });

  test("apply, healthy doctor, idempotent re-sync, and strategy change use the isolated home", () => {
    const f = fixture();
    const first = hermes(f, "sync", ["--strategy", "round_robin"]);
    expect(first.status, first.output).toBe(0);
    expect(first.stdout).toMatch(/add 1, update 0, noop 0/);
    expect(poolRows(f)).toHaveLength(1);
    const before = statSync(join(f.hermesHome, "auth.json")).mtimeMs;

    const second = hermes(f, "sync", ["--strategy", "round_robin"]);
    expect(second.status, second.output).toBe(0);
    expect(second.stdout).toMatch(/add 0, update 0, noop 1/);
    expect(second.stdout).toMatch(/already in sync/);
    expect(statSync(join(f.hermesHome, "auth.json")).mtimeMs).toBe(before);

    const doctor = hermes(f, "doctor");
    expect(doctor.status, doctor.output).toBe(0);
    expect(doctor.stdout).toMatch(/Hermes: v\d/);
    expect(doctor.stdout).toMatch(/multi-clawd:claw1: ready/);
    expect(doctor.stdout).toMatch(/integration: healthy/);

    const changed = hermes(f, "sync", ["--strategy", "least_used"]);
    expect(changed.status, changed.output).toBe(0);
    expect(changed.stdout).toMatch(/strategy least_used \(changed\)/);
    expect(readFileSync(join(f.hermesHome, "config.yaml"), "utf8")).toMatch(/least_used/);
    for (const output of [first.output, second.output, doctor.output, changed.output]) {
      expectNoSecrets(output);
    }
  });

  test("a bare sync preserves the chosen strategy instead of resetting it", () => {
    const f = fixture();
    expect(hermes(f, "sync", ["--strategy", "round_robin"]).status).toBe(0);
    writeFileSync(f.tokenFile, `${OTHER_TOKEN}\n`, { mode: 0o600 });

    const bare = hermes(f, "sync");
    expect(bare.status, bare.output).toBe(0);
    expect(bare.stdout).toMatch(/strategy round_robin \(preserved\)/);
    expect(bare.stdout).not.toMatch(/\(changed\)/);
    expect(readFileSync(join(f.hermesHome, "config.yaml"), "utf8")).toMatch(/round_robin/);
    expectNoSecrets(bare.output);
  });

  test("pool.accounts preference order becomes the Hermes priority order", () => {
    const f = fixture();
    const spareToken = join(f.root, "claw2.token");
    writeFileSync(spareToken, `${OTHER_TOKEN}\n`, { mode: 0o600 });
    writeConfig(f, {
      accounts: [
        { id: "claw2", oauthTokenFile: spareToken },
        { id: "claw1", oauthTokenFile: f.tokenFile },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
    });
    const result = hermes(f, "sync");
    expect(result.status, result.output).toBe(0);
    const rows = poolRows(f);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.priority]));
    expect(byLabel["multi-clawd:claw1"]).toBe(0);
    expect(byLabel["multi-clawd:claw2"]).toBe(1);
    expectNoSecrets(result.output);
  });

  test("an unrelated row stuffed with a token-like value never reaches CLI output", () => {
    const f = fixture();
    const secretLike = "sk-ant-oat01-should-never-print-cli";
    writeAuthStore(f.hermesHome, [
      {
        id: secretLike,
        label: secretLike,
        source: secretLike,
        auth_type: secretLike,
        priority: 0,
        last_status: secretLike,
        access_token: "fake-unrelated-cli-token",
      },
    ]);
    const doctor = hermes(f, "doctor");
    expect(doctor.status, doctor.output).toBe(0);
    expect(doctor.output).not.toContain(secretLike);

    const sync = hermes(f, "sync");
    expect(sync.status, sync.output).toBe(0);
    expect(sync.output).not.toContain(secretLike);
  });

  test("unrelated pool state is reported as a warning and does not fail doctor", () => {
    const f = fixture();
    writeAuthStore(f.hermesHome, [
      { id: "native-one", source: "claude_code", auth_type: "oauth", access_token: "fake-native-one" },
      { id: "native-two", source: "claude_code", auth_type: "oauth", access_token: "fake-native-two" },
    ]);
    expect(hermes(f, "sync").status).toBe(0);
    const doctor = hermes(f, "doctor");
    expect(doctor.status, doctor.output).toBe(0);
    expect(doctor.stdout).toMatch(/multipleClaudeCodeRows: 2 \(warning only/);
    expect(doctor.stdout).toMatch(/integration: healthy/);
    expect(poolRows(f)).toHaveLength(3);
  });

  test("a named profile must already exist and is never created", () => {
    const f = fixture();
    // f.hermesHome is a custom HERMES_HOME root (not nested under f.home), so a
    // named profile must live under that root, never under HOME/.hermes.
    const named = join(f.hermesHome, "profiles", "work");
    const result = run(f, ["hermes", "sync", "--config", f.config, "--profile", "work"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/hermes profile create work/);
    expect(existsSync(named)).toBe(false);

    mkdirSync(named, { recursive: true });
    const created = run(f, ["hermes", "sync", "--config", f.config, "--profile", "work"]);
    expect(created.status, created.output).toBe(0);
    expect(poolRows(f, named)).toHaveLength(1);
    expect(existsSync(join(f.home, ".hermes"))).toBe(false);
    expectNoSecrets(created.output);
  });

  test("syncing an empty named profile does not copy the global pool into it", () => {
    const f = fixture();
    const named = join(f.hermesHome, "profiles", "work");
    mkdirSync(named, { recursive: true });
    const globalAuth = writeAuthStore(f.hermesHome, [
      {
        id: "global-native",
        label: "global login",
        source: "claude_code",
        auth_type: "oauth",
        priority: 0,
        access_token: "fake-global-oauth-grant",
        refresh_token: "fake-global-refresh-grant",
      },
    ]);
    const globalBefore = readFileSync(globalAuth, "utf8");

    const result = run(f, ["hermes", "sync", "--config", f.config, "--profile", "work"]);
    expect(result.status, result.output).toBe(0);
    const rows = poolRows(f, named);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("multi-clawd:claw1");
    expect(readFileSync(globalAuth, "utf8")).toBe(globalBefore);
    expect(JSON.stringify(rows)).not.toContain("fake-global-oauth-grant");
    expect(JSON.stringify(rows)).not.toContain("fake-global-refresh-grant");
    expect(existsSync(join(f.home, ".hermes"))).toBe(false);
    expectNoSecrets(result.output);
  });

  test("HERMES_HOME pointed at a named profile still resolves --profile default to the root", () => {
    const f = fixture();
    // The active process HERMES_HOME is itself a named profile
    // (<root>/profiles/other) — an explicit --profile default must still
    // land on the root, never on that active profile.
    const otherProfileHome = join(f.hermesHome, "profiles", "other");
    mkdirSync(otherProfileHome, { recursive: true });

    const result = run(f, ["hermes", "sync", "--config", f.config, "--profile", "default"], {
      HERMES_HOME: otherProfileHome,
    });
    expect(result.status, result.output).toBe(0);
    expect(poolRows(f, f.hermesHome)).toHaveLength(1);
    expect(poolRows(f, otherProfileHome)).toHaveLength(0);
    expectNoSecrets(result.output);
  });
});
