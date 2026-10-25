import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireShimLock } from "../src/shim-lock";
import { persistHealthState, readHealthStateFile } from "../src/health-journal";
import { clearAccountCredentialFailure } from "../src/credential-state";
import { RETRY_ROSTER_ENV } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";
import type { AccountHealthState } from "../src/shim-core";

const SHIM = join(__dirname, "..", "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const box = () => mkdtempSync(join(tmpdir(), "mc-82-"));
const state = (windows: AccountHealthState["windows"] = {}, credential?: AccountHealthState["credential"]): AccountHealthState => ({ accountId: "home", windows, credential });
const pending = (file: string) => `${file}.pending-${process.pid}-${randomUUID()}`;
const pendingNames = (file: string) => readdirSync(join(file, "..")).filter((name) => name.startsWith(`${file.split("/").at(-1)}.pending-`) && !name.includes(".corrupt-"));
function run(file: string, model: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, "-p", "--output-format", "stream-json", "--model", model], {
      env: {
        ...cleanShimEnv(), MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
        MULTI_CLAWD_ACCOUNT_ID: "home", MULTI_CLAWD_STATE_FILE: file,
        FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "home", [RETRY_ROSTER_ENV]: "",
      },
    });
    child.stdout.resume(); child.stderr.resume();
    child.on("error", reject); child.on("close", resolve);
    child.stdin.end("question\n");
  });
}

describe("#82 durable health journal", () => {
  test("timed-out real shims publish every distinct rejection without rewriting a held snapshot", async () => {
    const file = join(box(), "home.json");
    const original = JSON.stringify(state());
    writeFileSync(file, original);
    const release = acquireShimLock(file);
    expect(release).toBeTypeOf("function");
    const models = ["test-model-0", "test-model-1", "test-model-2", "test-model-3"];
    try {
      expect(await Promise.all(models.map((model) => run(file, model)))).toEqual(models.map(() => 1));
      expect(readFileSync(file, "utf8")).toBe(original);
      for (const model of models) expect(readHealthStateFile(file)?.windows[`model:${model}`]?.status).toBe("rejected");
      expect(pendingNames(file)).toHaveLength(models.length);
    } finally { release?.(); }
    persistHealthState(file, state());
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
    for (const model of models) expect(snapshot.windows[`model:${model}`]?.status).toBe("rejected");
    expect(pendingNames(file)).toHaveLength(0);
  });

  test("fold removes only deltas it listed", () => {
    const file = join(box(), "home.json");
    const first = pending(file), later = pending(file);
    writeFileSync(first, JSON.stringify(state({ first: { status: "allowed", seenAt: 1 } })));
    persistHealthState(file, state(), { afterList: () => writeFileSync(later, JSON.stringify(state({ later: { status: "allowed", seenAt: 2 } }))) });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(later)).toBe(true);
    expect(readHealthStateFile(file)?.windows.later).toBeDefined();
  });

  test("reader retries when a listed delta was folded and unlinked", () => {
    const file = join(box(), "home.json"), delta = pending(file);
    writeFileSync(delta, JSON.stringify(state({ folded: { status: "rejected", seenAt: 1 } })));
    let moved = false;
    const read = readHealthStateFile(file, { afterList: () => {
      if (moved) return;
      moved = true;
      renameSync(delta, file);
    } });
    expect(read?.windows.folded?.status).toBe("rejected");
  });

  test("corrupt delta is skipped by readers and moved aside by a lock holder", () => {
    const file = join(box(), "home.json"), bad = pending(file);
    writeFileSync(bad, "{broken");
    expect(readHealthStateFile(file)).toBeUndefined();
    persistHealthState(file, state());
    expect(existsSync(bad)).toBe(false);
    expect(readdirSync(join(file, "..")).some((name) => name.startsWith(bad.split("/").at(-1)! + ".corrupt-"))).toBe(true);
  });

  test("credential clears and failures obey seenAt across pending deltas", () => {
    const file = join(box(), "home.json");
    writeFileSync(file, JSON.stringify(state({}, { status: "ok", seenAt: 200 })));
    writeFileSync(pending(file), JSON.stringify(state({}, { status: "failed", seenAt: 100 })));
    expect(readHealthStateFile(file)?.credential?.status).toBe("ok");
    persistHealthState(file, state({}, { status: "ok", seenAt: 300 }));
    writeFileSync(pending(file), JSON.stringify(state({}, { status: "failed", seenAt: 400 })));
    expect(readHealthStateFile(file)?.credential?.status).toBe("failed");
    persistHealthState(file, state({}, { status: "ok", seenAt: 350 }));
    expect(readHealthStateFile(file)?.credential?.status).toBe("failed");
  });

  test("credential clear sees a failure only in a pending delta", () => {
    const file = join(box(), "home.json");
    persistHealthState(file, state());
    writeFileSync(pending(file), JSON.stringify(state({}, { status: "failed", seenAt: Date.now() - 1000 })));
    expect(clearAccountCredentialFailure("home", file)).toBe(true);
    expect(readHealthStateFile(file)?.credential?.status).toBe("ok");
    expect(clearAccountCredentialFailure("home", file)).toBe(false);
  });
});
