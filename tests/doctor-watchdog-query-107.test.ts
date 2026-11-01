import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const STUB_NOISE = "Failed to connect to bus: No medium found";

function runDoctor(systemctl: string | null, units: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "multi-clawd-doctor-107-"));
  const bin = join(home, "bin");
  const openclaw = join(home, ".openclaw");
  const extension = join(openclaw, "extensions", "multi-clawd");
  const stateDir = join(openclaw, "state", "multi-clawd");
  mkdirSync(bin, { recursive: true });
  mkdirSync(extension, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(resolve("openclaw.plugin.json"), join(extension, "openclaw.plugin.json"));
  writeFileSync(join(stateDir, "install-record.json"), JSON.stringify({ installDir: extension, manifestMtimeMs: statSync(join(extension, "openclaw.plugin.json")).mtimeMs, recordKey: "{}", checkedAt: Date.now(), install: { source: "path" } }));
  writeFileSync(join(stateDir, "registry-check.json"), JSON.stringify({ latest: "2.1.3", checkedAt: Date.now() }));
  writeFileSync(join(openclaw, "openclaw.json"), JSON.stringify({ plugins: { entries: { "multi-clawd": { enabled: true, config: { accounts: [], pool: { id: "clawd", accounts: [] } } } } } }));
  if (systemctl !== null) {
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\n${systemctl}\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
  }
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  for (const [name, text] of Object.entries(units)) writeFileSync(join(unitDir, name), text);
  try {
    const result = spawnSync(process.execPath, [resolve("scripts/doctor.mjs")], {
      env: { PATH: bin, HOME: home }, encoding: "utf8", timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    const section = (result.stdout.split("eviction watchdog\n")[1] ?? "").split(/\n\S/)[0];
    return { out: result.stdout + result.stderr, stderr: result.stderr, section };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const problemCount = (out: string) => Number(out.match(/doctor: (\d+) problem/)?.[1] ?? 0);

describe("doctor watchdog query (#107)", () => {
  test("failed user-timer query leaks no stderr and is reported as unknown, not absent", () => {
    const failing = runDoctor(`echo "${STUB_NOISE}" >&2\nexit 1`);
    expect(failing.out).not.toContain(STUB_NOISE);
    expect(failing.section).not.toContain("no watchdog found");
    expect(failing.section).toContain("watchdog state unknown");
    const healthy = runDoctor(`echo "NEXT LEFT LAST PASSED UNIT ACTIVATES"`);
    expect(problemCount(failing.out)).toBe(problemCount(healthy.out));
  });

  test("a successful query with no matching timer is still reported as absent", () => {
    const r = runDoctor(`echo "NEXT LEFT LAST PASSED UNIT ACTIVATES"\necho "0 timers listed."`);
    expect(r.section).toContain("no watchdog found");
    expect(r.section).not.toContain("state unknown");
    expect(r.out).not.toContain(STUB_NOISE);
  });

  test("a successful query listing the watchdog timer is found", () => {
    const r = runDoctor(`echo "Sun 2026-11-01 multi-clawd-eviction-watchdog.timer"`);
    expect(r.section).toContain("watchdog scheduled");
    expect(r.section).not.toContain("no watchdog found");
  });

  test("when the query fails, an existing unit file still counts as found", () => {
    const script = join(tmpdir(), "multi-clawd-107-present-script.mjs");
    writeFileSync(script, "");
    try {
      const r = runDoctor(`echo "${STUB_NOISE}" >&2\nexit 1`, {
        "multi-clawd-eviction-watchdog.service": `[Service]\nExecStart=node ${script.replace(/present-script\.mjs$/, "eviction-watchdog.mjs")}\n`,
      });
      expect(r.out).not.toContain(STUB_NOISE);
      expect(r.section).not.toContain("no watchdog found");
      expect(r.section).not.toContain("state unknown");
    } finally {
      rmSync(script, { force: true });
    }
  });
});
