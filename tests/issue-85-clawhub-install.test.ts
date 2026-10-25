import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyClawhubFailure, classifyInstallSource, exactTargetVersion, parseInstallRecord, pluginInstallAttempts } from "../src/update-core";

const PKG = "@drakon-systems/multi-clawd";
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("ClawHub install decisions", () => {
  test("versioned ClawHub is first and has no npm-only pin flag", () => {
    expect(pluginInstallAttempts(PKG, "2.4.1")).toEqual([
      ["plugins", "install", `clawhub:${PKG}@2.4.1`, "--force"],
      ["plugins", "install", `${PKG}@2.4.1`, "--pin", "--force"],
    ]);
  });

  test("only identified availability failures can use npm", () => {
    for (const message of ["Package not found on ClawHub.", "Version not found on ClawHub: pkg@2.4.1.", "package_not_found", "version_not_found", "ClawHub is temporarily unavailable", "getaddrinfo ENOTFOUND clawhub.ai", "unknown option clawhub:", "unsupported spec clawhub:pkg"]) {
      expect(classifyClawhubFailure(1, message), message).toBe("fallback");
    }
    for (const message of ["blocked by moderation", "ClawHub archive integrity mismatch", "clawhub_download_blocked", "clawhub_security_unavailable", "trust check failed: ETIMEDOUT", "install policy denied", "invalid signature", "Install cancelled.", "aborted", "unexpected failure"]) {
      expect(classifyClawhubFailure(1, message), message).toBe("stop");
    }
  });

  test("target versions require an exact semver triplet", () => {
    expect(exactTargetVersion("3.0.0")).toBe("3.0.0");
    expect(exactTargetVersion("2.5.0-rc.1")).toBe("2.5.0-rc.1");
    for (const value of [undefined, "", "latest", "2.4", "v2.4.1", "2.4.1+build", "2.4.1-01", "2.4.1 bad"]) {
      expect(exactTargetVersion(value)).toBeUndefined();
    }
  });

  test("doctor classifies every known source and stays quiet for unknown records", () => {
    const hub = classifyInstallSource({ source: "clawhub", version: "2.4.0", clawhubChannel: "community" });
    expect(hub).toMatchObject({ level: "ok" });
    expect(hub?.text).toMatch(/2\.4\.0.*community/);
    const npm = classifyInstallSource({ source: "npm" });
    expect(npm).toMatchObject({ level: "warn" });
    expect(npm?.text).toMatch(/untrusted-source caution.*multi-clawd update/);
    for (const source of ["path", "archive", "git", "marketplace"]) {
      expect(classifyInstallSource({ source })?.level).toBe("note");
    }
    expect(classifyInstallSource({ source: "other" })).toBeUndefined();
    expect(classifyInstallSource(undefined)).toBeUndefined();
  });

  test("inspect wins, config is a legacy fallback, and garbage is tolerated", () => {
    const config = { plugins: { installs: { "multi-clawd": { source: "npm", version: "1.8.3" } } } };
    expect(parseInstallRecord('{"install":{"source":"clawhub","version":"2.4.0"}}', config)?.source).toBe("clawhub");
    expect(parseInstallRecord("garbage", config)?.source).toBe("npm");
    expect(parseInstallRecord('{"install":{"source":42}}', config)?.source).toBe("npm");
    expect(parseInstallRecord("garbage", { plugins: { installs: { "multi-clawd": "garbage" } } })).toBeUndefined();
    expect(parseInstallRecord(undefined, null)).toBeUndefined();
  });
});

function fakeCli(opts: { clawhubFails: boolean; trackedSource?: string; installedVersion?: string; latestVersion?: string; failure?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "mc-85-"));
  tempDirs.push(dir);
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const plugin = join(dir, "plugin");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(app, "dist"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(plugin);
  for (const file of ["cli.mjs", "_shared.mjs"]) copyFileSync(join(ROOT, "scripts", file), join(app, "scripts", file));
  copyFileSync(join(ROOT, "dist", "update-core.js"), join(app, "dist", "update-core.js"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", version: "2.4.1" }));
  writeFileSync(join(app, "scripts", "doctor.mjs"), "process.exit(0);\n");
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ version: opts.installedVersion ?? "2.4.1" }));
  const log = join(dir, "calls.jsonl");
  const openclaw = join(bin, "openclaw");
  writeFileSync(openclaw, `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nconst a = process.argv.slice(2);\nappendFileSync(process.env.CALL_LOG, JSON.stringify(a) + '\\n');\nif (a[0] === 'plugins' && a[1] === 'inspect') { console.log(JSON.stringify({ install: ${opts.trackedSource ? JSON.stringify({ source: opts.trackedSource, version: opts.installedVersion ?? "2.4.1", installPath: plugin }) : "null"} })); process.exit(0); }\nif (a[0] === 'plugins' && a[1] === 'install' && a[2].startsWith('clawhub:') && process.env.CLAWHUB_FAIL === '1') { console.error(${JSON.stringify(opts.failure ?? "Package not found on ClawHub.")}); process.exit(1); }\nprocess.exit(0);\n`);
  chmodSync(openclaw, 0o755);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!${process.execPath}\nif (${JSON.stringify(opts.latestVersion ?? "2.4.1")} === 'missing') process.exit(1); console.log(${JSON.stringify(opts.latestVersion ?? "2.4.1")});\n`);
  chmodSync(npm, 0o755);
  const result = spawnSync(process.execPath, [join(app, "scripts", "cli.mjs"), "update"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CALL_LOG: log, CLAWHUB_FAIL: opts.clawhubFails ? "1" : "0" },
    timeout: 30000,
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  return { result, installs: calls.filter((args) => args[0] === "plugins" && args[1] === "install"), calls };
}

describe("multi-clawd update OpenClaw calls", () => {
  test("tries ClawHub first and stops after success", () => {
    const { result, installs } = fakeCli({ clawhubFails: false });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(installs).toEqual([pluginInstallAttempts(PKG, "2.4.1")[0]]);
  });

  test("uses npm only after ClawHub fails and explains the caution", () => {
    const { result, installs } = fakeCli({ clawhubFails: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(installs).toEqual(pluginInstallAttempts(PKG, "2.4.1"));
    expect(result.stdout).toMatch(/falling back to npm.*source caution/);
  });

  test("an up-to-date npm install is offered migration to ClawHub", () => {
    const { result, installs } = fakeCli({ clawhubFails: false, trackedSource: "npm" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(installs).toEqual([pluginInstallAttempts(PKG, "2.4.1")[0]]);
  });

  test("moderation rejection stops before npm and gateway restart", () => {
    const { result, installs, calls } = fakeCli({ clawhubFails: true, failure: "blocked by moderation" });
    expect(result.status).not.toBe(0);
    expect(installs).toHaveLength(1);
    expect(calls.some((a) => a[0] === "gateway" && a[1] === "restart")).toBe(false);
    expect(result.stderr).toMatch(/npm was not tried/);
  });

  test("source migration pins the installed version even when registry is older", () => {
    const { installs } = fakeCli({ clawhubFails: true, trackedSource: "npm", installedVersion: "3.0.0", latestVersion: "2.4.1" });
    expect(installs).toEqual(pluginInstallAttempts(PKG, "3.0.0"));
  });

  test("a changed registry target is pinned on both attempts", () => {
    const { installs } = fakeCli({ clawhubFails: true, trackedSource: "npm", installedVersion: "2.3.0", latestVersion: "2.5.0" });
    expect(installs).toEqual(pluginInstallAttempts(PKG, "2.5.0"));
  });

  test("missing or malformed target never starts an install", () => {
    for (const latestVersion of ["missing", "bad-version"]) {
      const { result, installs } = fakeCli({ clawhubFails: false, latestVersion });
      expect(result.status).not.toBe(0);
      expect(installs).toHaveLength(0);
      expect(result.stdout).not.toContain("vundefined");
    }
  });
});

function fakeDoctor(opts: { installed: boolean; source?: string; customPath?: boolean; omitLegacyPath?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "mc-85-doctor-"));
  tempDirs.push(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const extension = opts.customPath ? join(dir, "custom-plugin") : join(home, ".openclaw", "extensions", "multi-clawd");
  const stateDir = join(home, ".openclaw", "state", "multi-clawd");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(home, ".openclaw", "openclaw.json");
  writeFileSync(configPath, JSON.stringify({ plugins: opts.installed ? { entries: { "multi-clawd": { enabled: true, config: { accounts: [] } } }, installs: { "multi-clawd": { source: opts.source ?? "npm", version: "2.4.0", ...(opts.omitLegacyPath ? {} : { installPath: extension }) } } } : {} }));
  writeFileSync(join(stateDir, "registry-check.json"), JSON.stringify({ latest: "0.0.1", checkedAt: Date.now() }));
  if (opts.installed) {
    mkdirSync(extension, { recursive: true });
    copyFileSync(join(ROOT, "openclaw.plugin.json"), join(extension, "openclaw.plugin.json"));
  }
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  const record = JSON.stringify({ source: opts.source ?? "npm", version: "2.4.0", installPath: extension });
  const openclaw = join(bin, "openclaw");
  writeFileSync(openclaw, `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nconst a = process.argv.slice(2);\nappendFileSync(process.env.CALL_LOG, JSON.stringify(a) + '\\n');\nif (a[0] === 'plugins' && a[1] === 'inspect') { console.log(JSON.stringify({ install: ${record} })); process.exit(0); }\nprocess.exit(1);\n`);
  chmodSync(openclaw, 0o755);
  const run = () => {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CALL_LOG: log },
      timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    return result.stdout + result.stderr;
  };
  const inspects = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((a) => a[0] === "plugins" && a[1] === "inspect").length;
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { run, inspects, calls, configPath, extension };
}

describe("doctor install source", () => {
  test("an npm-tracked install is flagged once and the answer is cached", () => {
    const { run, inspects } = fakeDoctor({ installed: true, source: "npm" });
    expect(run()).toMatch(/install source: npm .*multi-clawd update/);
    expect(inspects()).toBe(1);
    expect(run()).toMatch(/install source: npm/);
    expect(inspects()).toBe(1);
  });

  test("a ClawHub-tracked install reads as healthy", () => {
    const { run } = fakeDoctor({ installed: true, source: "clawhub" });
    expect(run()).toMatch(/✅ install source: ClawHub v2\.4\.0/);
  });

  test("a custom ClawHub install path is discovered from the tracked record", () => {
    const { run } = fakeDoctor({ installed: true, source: "clawhub", customPath: true });
    const output = run();
    expect(output).toMatch(/install source: ClawHub v2\.4\.0/);
    expect(output).not.toMatch(/no installed manifest/);
  });

  test("inspect can discover a custom path missing from the legacy record", () => {
    const { run, inspects } = fakeDoctor({ installed: true, source: "clawhub", customPath: true, omitLegacyPath: true });
    const output = run();
    expect(output).toMatch(/install source: ClawHub v2\.4\.0/);
    expect(output).not.toMatch(/no installed manifest/);
    expect(inspects()).toBe(1);
  });

  test("a changed config install record invalidates the inspect cache", () => {
    const { run, inspects, configPath, extension } = fakeDoctor({ installed: true, source: "npm" });
    run();
    expect(inspects()).toBe(1);
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { "multi-clawd": { enabled: true, config: { accounts: [] } } }, installs: { "multi-clawd": { source: "clawhub", version: "2.4.1", installPath: extension } } } }));
    run();
    expect(inspects()).toBe(2);
  });

  test("the inspect cache expires after one day", () => {
    const { run, inspects, configPath } = fakeDoctor({ installed: true, source: "npm" });
    run();
    const cachePath = join(dirname(configPath), "state", "multi-clawd", "install-record.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    cached.checkedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cached));
    run();
    expect(inspects()).toBe(2);
  });

  test("nothing installed: OpenClaw is not asked", () => {
    const { run, calls } = fakeDoctor({ installed: false });
    run();
    expect(calls()).toHaveLength(0);
  });
});
