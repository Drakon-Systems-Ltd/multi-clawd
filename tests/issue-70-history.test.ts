import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_MAX_BYTES, HISTORY_MAX_EVENTS, historyFile, parseHistorySince, readHistory, recordHistory, renderHistory } from "../src/history.js";
import { acquireShimLock } from "../src/shim-lock.js";
import { cleanShimEnv } from "./shim-env.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const shim = join(root, "dist", "shim.js");
const fake = join(root, "tests", "fixtures", "fake-claude.mjs");
const at = () => new Date().toISOString();
const event = (accountId = "claw1") => ({ at: at(), kind: "served" as const, accountId });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pendingIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("history.jsonl.pending-")).sort();
/**
 * A pending file exactly as a writer that lost the lock race publishes it:
 * `<13-digit park time>-<pid>-<9-digit sequence>-<event id>`, one line.
 * Writing it directly gives a test many parked events, or a chosen park
 * order, without waiting out the 150 ms lock budget once per event.
 */
const park = (dir: string, parkedAtMs: number, sequence: number, line: Record<string, unknown>, id = randomUUID()) => {
  const name = `history.jsonl.pending-${String(parkedAtMs).padStart(13, "0")}-4242-${String(sequence).padStart(9, "0")}-${id}`;
  writeFileSync(join(dir, name), JSON.stringify({ ...line, id }) + "\n", { mode: 0o600 });
  return { name, id };
};

describe("issue #70 account history", () => {
  test("records each account launch, retry hop, and classified rotation at the shim call sites", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-shim-"));
    const state = join(dir, "claw1.json");
    const result = spawnSync(process.execPath, [shim, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"], {
      encoding: "utf8", input: "private prompt\n",
      env: { ...cleanShimEnv(), MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, fake]),
        MULTI_CLAWD_STATE_FILE: state, MULTI_CLAWD_ACCOUNT_ID: "claw1",
        CLAUDE_CODE_OAUTH_TOKEN: "private-credential-value", PRIVATE_ENV_VALUE: "private-env-value",
        FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
        MULTI_CLAWD_RETRY_ACCOUNTS: JSON.stringify([{ id: "claw2", stateFile: join(dir, "claw2.json"), env: { CLAUDE_CONFIG_DIR: join(dir, "claw2") } }]) },
    });
    expect(result.status).toBe(0);
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.kind === "served").map((e) => e.accountId)).toEqual(["claw1", "claw2"]);
    expect(rows.filter((e) => e.kind === "retry")).toEqual([
      expect.objectContaining({ accountId: "claw1", toAccountId: "claw2", reason: "model_limit" }),
    ]);
    expect(rows.filter((e) => e.kind === "rotation")).toEqual([
      expect.objectContaining({ accountId: "claw1", toAccountId: "claw2", reason: "model_limit" }),
    ]);
    const raw = readFileSync(historyFile(state), "utf8");
    expect(raw).not.toContain("private prompt");
    expect(raw).not.toContain("private-credential-value");
    expect(raw).not.toContain("private-env-value");
    expect(raw).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test.each([
    ["model limit", { FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1" }],
    ["auth failure", { FAKE_CLAUDE_EMIT_AUTH_FAIL: "1" }],
  ])("records no rotation for a single-account %s", (_cause, fakeEnv) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-single-"));
    const state = join(dir, "claw1.json");
    const result = spawnSync(process.execPath, [shim, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"], {
      encoding: "utf8", input: "private prompt\n",
      env: { ...cleanShimEnv(), MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, fake]),
        MULTI_CLAWD_STATE_FILE: state, MULTI_CLAWD_ACCOUNT_ID: "claw1", ...fakeEnv },
    });
    expect(result.error).toBeUndefined();
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.kind === "served")).toHaveLength(1);
    expect(rows.filter((e) => e.kind === "rotation")).toEqual([]);
  });

  test("bounds the file, skips corrupt lines, and drops sensitive unknown fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-cap-"));
    const state = join(dir, "claw1.json");
    for (let i = 0; i < 650; i++) recordHistory(state, { ...event(), modelId: "claude-fable-5-1",
      prompt: "private prompt", credential: "secret token", env: "sensitive" } as Parameters<typeof recordHistory>[1]);
    const file = historyFile(state);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(readHistory(file).length).toBeLessThanOrEqual(500);
    expect(readFileSync(file, "utf8")).not.toMatch(/private prompt|secret token|sensitive/);
    writeFileSync(file, `${readFileSync(file, "utf8")}not-json\n{"at":`, "utf8");
    expect(readHistory(file).length).toBeGreaterThan(0);
    recordHistory(state, event());
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  // 651 locked read/trim/replace cycles: ~0.25 s locally, but over 5 s on the
  // Linux Node 22 CI runner under the full parallel suite. Explicit budget.
  }, 30_000);

  test("two concurrent writers keep valid, bounded events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-writers-"));
    const script = join(dir, "writer.mjs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, `import { recordHistory } from ${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)};\nfor (let i = 0; i < 20; i++) recordHistory(process.argv[2], { at: new Date().toISOString(), kind: "served", accountId: process.argv[3] });\n`);
    const state = join(dir, "claw1.json");
    const run = (id: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [script, state, id]);
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(await Promise.all([run("claw1"), run("claw2")])).toEqual([0, 0]);
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.accountId === "claw1")).toHaveLength(20);
    expect(rows.filter((e) => e.accountId === "claw2")).toHaveLength(20);
    expect(statSync(historyFile(state)).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  });

  // #145: CI (Node 24, run 42518656819) saw 19 of 20 events from one of two
  // writers that both exited 0. A writer that cannot take the advisory lock
  // within its 150 ms budget used to drop the event silently; a sibling in a
  // tight record loop re-takes the lock within microseconds while the waiter
  // polls every 10 ms, so a slow runner starves the waiter past the budget.
  test("parks an event it cannot lock in time, reads it back, and folds it on the next locked write", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, event("claw2"));
    } finally { release?.(); }
    // The journal itself was never replaced under a foreign lock...
    expect(readHistory(file).filter((e) => e.accountId === "claw2")).toHaveLength(1);
    expect(readFileSync(file, "utf8")).not.toContain("claw2");
    expect(pendingIn(dir)).toHaveLength(1);
    // ...and the next lock holder folds the parked event into it.
    recordHistory(state, event("claw1"));
    expect(pendingIn(dir)).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("claw2");
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw1", "claw2", "claw1"]);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  });

  // The parked path writes a file of its own, so it needs its own proof that
  // only allowlisted fields reach disk. The event handed in carries the
  // fields a careless caller could leak; the assertions are on exact keys,
  // so they fail if the allowlist stops rebuilding the event.
  test("a parked event and its folded line carry only allowlisted fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-allowlist-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const leaky = { ...event("claw2"), modelId: "claude-fable-5-1", id: "caller-chosen-id",
      prompt: "private prompt", token: "secret token", credential: "secret credential",
      env: { PRIVATE_ENV_VALUE: "sensitive env" }, cost: 12.5 } as Parameters<typeof recordHistory>[1];
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, leaky);
    } finally { release?.(); }
    const [name] = pendingIn(dir);
    expect(pendingIn(dir)).toHaveLength(1);
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    const parkedRaw = readFileSync(join(dir, name), "utf8");
    const parked = JSON.parse(parkedRaw) as Record<string, unknown>;
    expect(Object.keys(parked).sort()).toEqual(["accountId", "at", "id", "kind", "modelId"]);
    // The id is the writer's own random one, never a caller's value.
    expect(parked.id).toMatch(UUID);
    expect(name.endsWith(`-${String(parked.id)}`)).toBe(true);
    const secrets = /private prompt|secret token|secret credential|sensitive env|PRIVATE_ENV_VALUE|caller-chosen-id|12\.5/;
    expect(parkedRaw).not.toMatch(secrets);
    // Readers get the public event, without the storage id.
    expect(readHistory(file)).toEqual([{ at: leaky.at, kind: "served", accountId: "claw2", modelId: "claude-fable-5-1" }]);

    // A pending file from any other source goes through the same allowlist when it is folded.
    const foreign = park(dir, Date.now() + 1, 0, { ...event("claw3"), prompt: "private prompt", token: "secret token", env: "sensitive env" });
    recordHistory(state, leaky);
    expect(pendingIn(dir)).toEqual([]);
    const journalRaw = readFileSync(file, "utf8");
    expect(journalRaw).not.toMatch(secrets);
    const lines = journalRaw.trim().split("\n").map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(lines.map((l) => Object.keys(l).sort())).toEqual([
      ["accountId", "at", "id", "kind", "modelId"],
      ["accountId", "at", "id", "kind"],
      ["accountId", "at", "kind", "modelId"],
    ]);
    expect(lines.map((l) => l.id)).toEqual([parked.id, foreign.id, undefined]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readHistory(file).every((e) => !("id" in e))).toBe(true);
  });

  // A lock holder replaces the journal and only then removes the pending
  // files it folded. If it stops in between, the next holder finds a pending
  // file whose event the journal already holds. Folding it again would count
  // one launch twice until the line aged out of the journal.
  test("a fold interrupted between the journal replace and the pending-file removal is not applied twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-replay-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, { ...event("claw2"), modelId: "parked-one" });
      recordHistory(state, { ...event("claw2"), modelId: "parked-two" });
    } finally { release?.(); }
    const left = pendingIn(dir).map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
    expect(left).toHaveLength(2);
    recordHistory(state, event("claw1"));
    expect(pendingIn(dir)).toEqual([]);
    const folded = readFileSync(file, "utf8");
    // The on-disk state of a holder that stopped right after its replace:
    // the journal holds both events and both pending files are still there.
    for (const { name, content } of left) writeFileSync(join(dir, name), content, { mode: 0o600 });
    expect(readFileSync(file, "utf8")).toBe(folded);

    const models = () => readHistory(file).filter((e) => e.accountId === "claw2").map((e) => e.modelId);
    // A reader that overlaps that state still sees each event once...
    expect(models()).toEqual(["parked-one", "parked-two"]);
    expect(readHistory(file)).toHaveLength(4);
    // ...the next locked write adds only its own event and clears the files...
    recordHistory(state, event("claw1"));
    expect(pendingIn(dir)).toEqual([]);
    expect(models()).toEqual(["parked-one", "parked-two"]);
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw1", "claw2", "claw2", "claw1", "claw1"]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(5);
    // ...and it stays that way however often the same leftovers come back.
    for (const { name, content } of left) writeFileSync(join(dir, name), content, { mode: 0o600 });
    recordHistory(state, event("claw1"));
    expect(models()).toEqual(["parked-one", "parked-two"]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(6);
    expect(pendingIn(dir)).toEqual([]);
  });

  // The same window with a real process: a writer that takes the lock, folds,
  // replaces the journal and is killed outright at its first pending-file
  // removal. It leaves the journal, both pending files and its own lock.
  test("a writer killed between its journal replace and its pending-file removal causes no duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-killed-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const script = join(dir, "killed-writer.mjs");
    writeFileSync(script, [
      `import fs from "node:fs";`,
      `import { syncBuiltinESMExports } from "node:module";`,
      `const unlink = fs.unlinkSync;`,
      `fs.unlinkSync = (path) => {`,
      `  if (/history\\.jsonl\\.pending-[^/]*$/.test(String(path)) && !String(path).includes(".tmp-")) {`,
      `    process.kill(process.pid, "SIGKILL");`,
      `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
      `  }`,
      `  return unlink(path);`,
      `};`,
      `syncBuiltinESMExports();`,
      `const { recordHistory } = await import(${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)});`,
      `recordHistory(process.argv[2], { at: new Date().toISOString(), kind: "served", accountId: "claw3" });`,
      ``,
    ].join("\n"));
    recordHistory(state, event("claw1"));
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, { ...event("claw2"), modelId: "parked-one" });
      recordHistory(state, { ...event("claw2"), modelId: "parked-two" });
    } finally { release?.(); }
    expect(pendingIn(dir)).toHaveLength(2);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, state]);
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    // It died inside the window: the journal already holds everything it
    // folded, and nothing it was about to remove is gone.
    const journalAfterKill = readFileSync(file, "utf8");
    expect(journalAfterKill.trim().split("\n")).toHaveLength(4);
    expect(journalAfterKill).toContain("parked-one");
    expect(journalAfterKill).toContain("parked-two");
    expect(journalAfterKill).toContain("claw3");
    expect(pendingIn(dir)).toHaveLength(2);
    expect(readdirSync(dir)).toContain("history.jsonl.lock");

    const accounts = () => readHistory(file).map((e) => e.accountId);
    expect(accounts()).toEqual(["claw1", "claw2", "claw2", "claw3"]);
    // The next writer takes over the dead holder's lock, adds its own event
    // once, and clears the leftovers without applying them again.
    recordHistory(state, event("claw1"));
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(5);
    expect(accounts()).toEqual(["claw1", "claw2", "claw2", "claw3", "claw1"]);
    expect(pendingIn(dir)).toEqual([]);
    expect(readdirSync(dir)).not.toContain("history.jsonl.lock");
  }, 15_000);

  test("a holder that stops before its journal replace leaves parked events to be folded once by the next holder", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-unfolded-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    const before = readFileSync(file, "utf8");
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, event("claw2"));
    } finally { release?.(); }
    // Nothing was folded: same journal bytes, the event exists only as a pending file.
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw1", "claw2"]);
    recordHistory(state, event("claw1"));
    recordHistory(state, event("claw1"));
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw1", "claw2", "claw1", "claw1"]);
    expect(pendingIn(dir)).toEqual([]);
  });

  // Pending names sort by park time, which is not event time: a writer that
  // stamped its event first can lose a longer race and park later. Readers
  // and the fold order parked events by their own timestamp; events with the
  // same timestamp keep the order their writer parked them in.
  test("parked events are read and folded in event order, with park order breaking ties", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-order-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 60_000;
    const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    recordHistory(state, { at: stamp(0), kind: "served", accountId: "claw1", modelId: "journal" });
    // Parked latest-event-first: name order is the reverse of event order.
    park(dir, base + 1000, 0, { at: stamp(400), kind: "served", accountId: "claw2", modelId: "e4" });
    park(dir, base + 1001, 0, { at: stamp(300), kind: "served", accountId: "claw2", modelId: "e3" });
    // One writer, one millisecond, three events: only the sequence tells them apart.
    park(dir, base + 1002, 0, { at: stamp(200), kind: "served", accountId: "claw2", modelId: "tie-a" });
    park(dir, base + 1002, 1, { at: stamp(200), kind: "served", accountId: "claw2", modelId: "tie-b" });
    park(dir, base + 1002, 2, { at: stamp(200), kind: "served", accountId: "claw2", modelId: "tie-c" });
    park(dir, base + 1003, 0, { at: stamp(100), kind: "served", accountId: "claw2", modelId: "e1" });
    const order = ["journal", "e1", "tie-a", "tie-b", "tie-c", "e3", "e4"];
    expect(readHistory(file).map((e) => e.modelId)).toEqual(order);
    recordHistory(state, { at: stamp(500), kind: "served", accountId: "claw1", modelId: "own" });
    expect(pendingIn(dir)).toEqual([]);
    expect(readHistory(file).map((e) => e.modelId)).toEqual([...order, "own"]);
    // The journal itself holds the folded batch in event order too.
    expect(readFileSync(file, "utf8").trim().split("\n").map((text) => (JSON.parse(text) as { modelId: string }).modelId))
      .toEqual([...order, "own"]);
  });

  test("a reader orders a late-folded event by its timestamp, not by where the fold appended it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-late-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 60_000;
    const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    recordHistory(state, { at: stamp(0), kind: "served", accountId: "claw1", modelId: "first" });
    recordHistory(state, { at: stamp(200), kind: "served", accountId: "claw1", modelId: "third" });
    // Stamped between the two, but its writer lost the race and parked it afterwards.
    park(dir, base + 400, 0, { at: stamp(100), kind: "served", accountId: "claw2", modelId: "second" });
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["first", "second", "third"]);
    recordHistory(state, { at: stamp(500), kind: "served", accountId: "claw1", modelId: "fourth" });
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["first", "second", "third", "fourth"]);
    expect(readHistory(file).at(-1)).toEqual({ at: stamp(500), kind: "served", accountId: "claw1", modelId: "fourth" });
  });

  // The 500-event / 64 KiB bound has to hold for what a reader gets back, not
  // only for the journal file: placement and `explain --history` read parked
  // events too, and a long lock hold can park any number of them.
  test("the read view and the fold stay inside the journal bound however many events are parked", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-cap-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 120_000;
    const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    for (let i = 0; i < 10; i++) recordHistory(state, { at: stamp(i), kind: "served", accountId: "claw1" });
    const parkedCount = HISTORY_MAX_EVENTS + 20;
    for (let i = 0; i < parkedCount; i++) park(dir, base + 1000 + i, 0, { at: stamp(1000 + i), kind: "served", accountId: "claw2", modelId: `m${i}` });
    expect(pendingIn(dir)).toHaveLength(parkedCount);

    const view = readHistory(file);
    expect(view).toHaveLength(HISTORY_MAX_EVENTS);
    // Exactly the newest 500 parked events, oldest first: the ten journal
    // lines and the twenty oldest parked events are outside the bound.
    expect(view.map((e) => e.modelId)).toEqual(Array.from({ length: HISTORY_MAX_EVENTS }, (_, i) => `m${i + 20}`));
    // Reading never folds or removes anything.
    expect(pendingIn(dir)).toHaveLength(parkedCount);

    recordHistory(state, { at: stamp(5000), kind: "served", accountId: "claw1", modelId: "own" });
    expect(pendingIn(dir)).toEqual([]);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    const after = readHistory(file);
    expect(after).toHaveLength(HISTORY_MAX_EVENTS);
    expect(after.map((e) => e.modelId)).toEqual([...Array.from({ length: HISTORY_MAX_EVENTS - 1 }, (_, i) => `m${i + 21}`), "own"]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(HISTORY_MAX_EVENTS);
  });

  test("the read view honours the byte bound when parked events are large", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-bytes-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 120_000;
    const wide = (i: number) => `${String(i).padStart(4, "0")}-${"a".repeat(95)}`;
    for (let i = 0; i < 400; i++) {
      park(dir, base + i, 0, { at: new Date(base + i).toISOString(), kind: "retry", accountId: wide(i), toAccountId: wide(i), reason: "model_limit" });
    }
    const stored = (events: ReturnType<typeof readHistory>) => events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e) + "\n"), 0);
    const view = readHistory(file);
    expect(view.length).toBeGreaterThan(0);
    expect(view.length).toBeLessThan(400);
    expect(stored(view)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    // The newest survive, and the reader keeps exactly what the next fold will keep.
    expect(view.at(-1)?.accountId).toBe(wide(399));
    recordHistory(state, { at: new Date(base + 1000).toISOString(), kind: "retry", accountId: wide(1000), toAccountId: wide(1000), reason: "model_limit" });
    expect(pendingIn(dir)).toEqual([]);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    const after = readHistory(file);
    expect(after.at(-1)?.accountId).toBe(wide(1000));
    expect(after.slice(0, -1).map((e) => e.accountId)).toEqual(view.slice(-(after.length - 1)).map((e) => e.accountId));
  });

  test("a child writer starved of the lock for its whole run loses no events once the holder releases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-starved-"));
    const script = join(dir, "writer.mjs");
    writeFileSync(script, `import { recordHistory } from ${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)};\nfor (let i = 0; i < 5; i++) recordHistory(process.argv[2], { at: process.argv[4] ?? new Date().toISOString(), kind: "served", accountId: process.argv[3], modelId: "write-" + i });\n`);
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    const run = (id: string, ...fixedAt: string[]) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [script, state, id, ...fixedAt]);
      child.on("error", reject);
      child.on("close", resolve);
    });
    const sameInstant = new Date().toISOString();
    let codes: Array<number | null>;
    try {
      // claw2 stamps each event as it goes; claw3 stamps all five with one
      // instant, so only its own park sequence can keep them in call order.
      codes = [await run("claw2"), await run("claw3", sameInstant)];
    } finally { release?.(); }
    expect(codes).toEqual([0, 0]);
    const written = ["write-0", "write-1", "write-2", "write-3", "write-4"];
    const writes = (id: string) => readHistory(file).filter((e) => e.accountId === id).map((e) => e.modelId);
    expect(readFileSync(file, "utf8")).not.toMatch(/claw2|claw3/);
    expect(pendingIn(dir)).toHaveLength(10);
    expect(writes("claw2")).toEqual(written);
    expect(writes("claw3")).toEqual(written);
    recordHistory(state, event("claw1"));
    expect(readdirSync(dir).filter((name) => name.includes(".pending-"))).toEqual([]);
    expect(writes("claw2")).toEqual(written);
    expect(writes("claw3")).toEqual(written);
    expect(readHistory(file).filter((e) => e.accountId === "claw1")).toHaveLength(2);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  }, 20_000);

  test("parses since and renders per-account counts and last served", () => {
    expect(parseHistorySince("7d")).toBe(604800000);
    expect(parseHistorySince("24h")).toBe(86400000);
    expect(() => parseHistorySince("banana")).toThrow(/--since/);
    expect(() => parseHistorySince("0d")).toThrow(/--since/);
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const rows = [
      { at: "2026-10-24T12:00:00.000Z", kind: "served" as const, accountId: "claw1" },
      { at: "2026-10-24T13:00:00.000Z", kind: "retry" as const, accountId: "claw1", toAccountId: "claw2" },
      { at: "2026-10-24T14:00:00.000Z", kind: "rotation" as const, accountId: "claw1", reason: "model_limit" as const },
      { at: "2026-10-24T15:00:00.000Z", kind: "served" as const, accountId: "claw2" },
      { at: "2026-10-15T12:00:00.000Z", kind: "served" as const, accountId: "claw1" },
    ];
    const rendered = renderHistory(rows, ["claw1", "claw2", "claw3"], "7d", now);
    expect(rendered).toContain("claw1: 1 served launch, 1 retry, 1 rotation; last served 2026-10-24T12:00:00.000Z");
    expect(rendered).toContain("claw2: 1 served launch,");
    expect(rendered).toContain("claw3: 0 served launches, 0 retries, 0 rotations; last served never");
  });

  test("last served uses the latest timestamp when events are appended out of order", () => {
    const rows = [
      { at: "2026-10-24T10:00:00.000Z", kind: "served" as const, accountId: "claw1" },
      { at: "2026-10-24T09:00:00.000Z", kind: "served" as const, accountId: "claw1" },
    ];
    expect(renderHistory(rows, ["claw1"], "7d", Date.parse("2026-10-25T12:00:00.000Z")))
      .toContain("claw1: 2 served launches, 0 retries, 0 rotations; last served 2026-10-24T10:00:00.000Z");
  });

  test("explain --history renders counts, invalid --since exits non-zero, plain explain stays unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-history-cli-"));
    const openclaw = join(home, ".openclaw");
    mkdirSync(openclaw, { recursive: true });
    writeFileSync(join(openclaw, "openclaw.json"), JSON.stringify({ plugins: { entries: {
      "multi-clawd": { config: { accounts: [{ id: "claw1", label: "First" }] } },
    } } }));
    recordHistory(join(openclaw, "state", "multi-clawd", "claw1.json"), event());
    const cli = join(root, "scripts", "cli.mjs");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "explain", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    });
    const plain = run();
    const history = run("--history", "--since", "24h");
    const invalid = run("--history", "--since", "yesterday");
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain("Account history");
    expect(history.status).toBe(0);
    expect(history.stdout).toContain("Account history (last 24h):");
    expect(history.stdout).toContain("claw1: 1 served launch,");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("--since must be a positive duration");
  });
});
