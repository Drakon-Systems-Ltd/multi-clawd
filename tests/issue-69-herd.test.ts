import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireShimLock } from "../src/shim-lock";
import { RETRY_ROSTER_ENV } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";

const SHIM = join(__dirname, "..", "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const ARGS = [SHIM, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

function box() {
  const dir = mkdtempSync(join(tmpdir(), "mc-69-"));
  const file = (id: string) => join(dir, `${id}.json`);
  const env = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_ACCOUNT_ID: "home",
    MULTI_CLAWD_STATE_FILE: file("home"),
    FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "home",
    [RETRY_ROSTER_ENV]: JSON.stringify([
      { id: "first", stateFile: file("first"), env: {} },
      { id: "second", stateFile: file("second"), env: {} },
    ]),
  };
  return { dir, file, env };
}

function run(env: NodeJS.ProcessEnv, args = ARGS): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end("question\n");
  });
}

describe("#69 cross-process shim guards", () => {
  test("concurrent writers preserve distinct window observations", async () => {
    const b = box();
    const names = Array.from({ length: 8 }, (_, i) => `period_${i}`);
    const results = await Promise.all(names.map((name) => run({
      ...b.env,
      [RETRY_ROSTER_ENV]: "",
      FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "",
      FAKE_CLAUDE_RATE_LIMIT_INFO: JSON.stringify({ status: "allowed", rateLimitType: name, utilization: 0.1 }),
    })));
    expect(results.map((r) => r.code)).toEqual(names.map(() => 0));
    const state = JSON.parse(readFileSync(b.file("home"), "utf8"));
    expect(Object.keys(state.windows).sort()).toEqual(names.sort());
    expect(existsSync(`${b.file("home")}.lock`)).toBe(false);
  });

  test("concurrent refusals on one account preserve every model rejection", async () => {
    const b = box();
    const models = Array.from({ length: 8 }, (_, i) => `test-model-${i}`);
    const results = await Promise.all(models.map((model) => run(
      { ...b.env, [RETRY_ROSTER_ENV]: "" },
      [...ARGS.slice(0, -1), model],
    )));
    expect(results.map((r) => r.code)).toEqual(models.map(() => 1));
    const windows = JSON.parse(readFileSync(b.file("home"), "utf8")).windows;
    for (const model of models) expect(windows[`model:${model}`]?.status).toBe("rejected");
    expect(existsSync(`${b.file("home")}.lock`)).toBe(false);
  });

  test("a later retry sees a sibling's recorded refusal", () => {
    const b = box();
    const first = spawnSync(process.execPath, ARGS, {
      env: { ...b.env, FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "home,first" },
      input: "question\n", encoding: "utf8",
    });
    expect(first.status).toBe(1);
    expect(JSON.parse(readFileSync(b.file("first"), "utf8")).windows["model:claude-fable-5-1"].status).toBe("rejected");
    const later = spawnSync(process.execPath, ARGS, { env: b.env, input: "question\n", encoding: "utf8" });
    expect(later.status).toBe(0);
    expect(later.stdout).toContain('"served_by":"second"');
    for (const id of ["home", "first", "second"]) {
      expect(existsSync(`${b.file(id)}.lock`)).toBe(false);
    }
    expect(existsSync(`${b.file("home")}.retry.lock`)).toBe(false);
  });

  test("stale dead and expired locks are taken over and cleaned up", () => {
    const b = box();
    const target = b.file("home");
    writeFileSync(`${target}.lock`, `99999999 ${Date.now()}\n`);
    const dead = acquireShimLock(target);
    expect(dead).toBeTypeOf("function");
    dead?.();
    writeFileSync(`${target}.lock`, `${process.pid} ${Date.now() - 60_000}\n`);
    const expired = acquireShimLock(target);
    expect(expired).toBeTypeOf("function");
    expired?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("relative and empty targets create no lock or directory", () => {
    const b = box();
    const cwd = process.cwd();
    try {
      process.chdir(b.dir);
      expect(acquireShimLock("nested/state.json")).toBeUndefined();
      expect(acquireShimLock("nested/state.json.retry")).toBeUndefined();
      expect(acquireShimLock("")).toBeUndefined();
      expect(existsSync("nested")).toBe(false);
      expect(existsSync(".lock")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  test("stale takeover leaves a replacement live lock in place", () => {
    const b = box();
    const target = b.file("home");
    writeFileSync(`${target}.lock`, `99999999 ${Date.now()}\n`);
    let releaseFresh: (() => void) | undefined;
    const acquired = acquireShimLock(target, 0, {
      beforeStaleUnlink: () => {
        unlinkSync(`${target}.lock`);
        releaseFresh = acquireShimLock(target);
      },
    });
    expect(releaseFresh).toBeTypeOf("function");
    expect(acquired).toBeUndefined();
    expect(existsSync(`${target}.lock`)).toBe(true);
    releaseFresh?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("stale snapshot reads the opened lock after a replacement", () => {
    const b = box();
    const target = b.file("home");
    const lock = `${target}.lock`;
    writeFileSync(lock, `99999999 ${Date.now() - 60_000}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let releaseFresh: (() => void) | undefined;
    let freshBytes: Buffer | undefined;
    const acquired = acquireShimLock(target, 0, {
      beforeStaleSnapshot: () => {
        unlinkSync(lock);
        releaseFresh = acquireShimLock(target);
        freshBytes = readFileSync(lock);
      },
    });
    expect(releaseFresh).toBeTypeOf("function");
    expect(acquired).toBeUndefined();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock)).toEqual(freshBytes);
    releaseFresh?.();
    expect(existsSync(lock)).toBe(false);
  });

  test("fresh empty lock is not removed during a holder's write", () => {
    const b = box();
    const lock = `${b.file("home")}.lock`;
    writeFileSync(lock, "");
    expect(acquireShimLock(b.file("home"), 0)).toBeUndefined();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock)).toEqual(Buffer.alloc(0));
    unlinkSync(lock);
  });

  test("release keeps a replacement lock even when its inode is unchanged", () => {
    const b = box();
    const target = b.file("home");
    const release = acquireShimLock(target);
    expect(release).toBeTypeOf("function");
    const replacement = `${process.pid} ${Date.now()} replacement-token\n`;
    writeFileSync(`${target}.lock`, replacement);
    release?.();
    expect(readFileSync(`${target}.lock`, "utf8")).toBe(replacement);
    unlinkSync(`${target}.lock`);
  });

  test("close failure still returns a release function", () => {
    const b = box();
    const target = b.file("home");
    const release = acquireShimLock(target, 0, { close: () => { throw new Error("close failed"); } });
    expect(release).toBeTypeOf("function");
    expect(existsSync(`${target}.lock`)).toBe(true);
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("lock timeout fails open without removing a live holder's lock", () => {
    const b = box();
    const target = b.file("home");
    const release = acquireShimLock(target);
    expect(release).toBeTypeOf("function");
    const start = Date.now();
    expect(acquireShimLock(target, 40)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(500);
    expect(existsSync(`${target}.lock`)).toBe(true);
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("a shim turn completes when its state lock stays busy", () => {
    const b = box();
    const release = acquireShimLock(b.file("home"));
    expect(release).toBeTypeOf("function");
    try {
      const result = spawnSync(process.execPath, ARGS, {
        env: { ...b.env, FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "", [RETRY_ROSTER_ENV]: "" },
        input: "question\n", encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"served_by":"home"');
    } finally {
      release?.();
    }
    expect(existsSync(`${b.file("home")}.lock`)).toBe(false);
  });
});
