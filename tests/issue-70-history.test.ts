import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_FOLD_MAX, HISTORY_MAX_BYTES, HISTORY_MAX_EVENTS, historyFile, parseHistorySince, readHistory, recordHistory, renderHistory } from "../src/history.js";
import { acquireShimLock, shimLockFile } from "../src/shim-lock.js";
import { cleanShimEnv } from "./shim-env.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const shim = join(root, "dist", "shim.js");
const fake = join(root, "tests", "fixtures", "fake-claude.mjs");
const at = () => new Date().toISOString();
const event = (accountId = "claw1") => ({ at: at(), kind: "served" as const, accountId });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pendingIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("history.jsonl.pending-")).sort();
const pendingId = (name: string) => name.slice(-36);
const waitFor = async (path: string) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return existsSync(path);
};
/**
 * A pending file exactly as a writer that lost the lock race publishes it:
 * `<13-digit park time>-<10-digit pid>-<9-digit sequence>-<id>`, one event
 * line. Writing it directly gives a test many parked events, or a chosen
 * park order, without waiting out the 150 ms lock budget once per event.
 */
const park = (dir: string, parkedAtMs: number, sequence: number, line: Record<string, unknown>, id = randomUUID()) => {
  const name = `history.jsonl.pending-${String(parkedAtMs).padStart(13, "0")}-0000004242-${String(sequence).padStart(9, "0")}-${id}`;
  writeFileSync(join(dir, name), JSON.stringify(line) + "\n", { mode: 0o600 });
  return { name, id };
};
/** The journal file as written: its event lines and the ids its fold receipt names. */
const journalOf = (file: string) => {
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((text) => JSON.parse(text) as Record<string, unknown>);
  return {
    events: lines.filter((l) => "at" in l),
    folded: lines.filter((l) => "folded" in l).flatMap((l) => l.folded as string[]),
    receipts: lines.filter((l) => "folded" in l).length,
  };
};
/**
 * A real writer that is stopped, or held, at a chosen point of its locked
 * write. The patch sits on node:fs before the module under test loads, so the
 * production code runs unmodified up to that point.
 */
const interruptedWriter = (dir: string) => {
  const script = join(dir, "interrupted-writer.mjs");
  writeFileSync(script, [
    `import fs from "node:fs";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `const [state, mode, journal] = process.argv.slice(2);`,
    `const real = { unlinkSync: fs.unlinkSync, writeFileSync: fs.writeFileSync, readFileSync: fs.readFileSync, statSync: fs.statSync };`,
    `const idle = new Int32Array(new SharedArrayBuffer(4));`,
    `const die = () => { process.kill(process.pid, "SIGKILL"); Atomics.wait(idle, 0, 0); };`,
    `const isPending = (path) => /history\\.jsonl\\.pending-[^/]*$/.test(String(path)) && !String(path).includes(".tmp-");`,
    `const lock = journal + ".lock";`,
    `const holdsJournal = mode === "hold-after-journal-read" || mode === "hold-at-lock-and-journal";`,
    `const holdsLock = mode === "hold-at-lock-and-journal";`,
    `let removals = 0;`,
    `let stage = 0;`,
    `let heldAtJournal = false;`,
    `let heldAtLock = false;`,
    `const hold = () => {`,
    `  stage += 1;`,
    `  real.writeFileSync(journal + ".held-" + stage, "");`,
    `  const until = Date.now() + 10000;`,
    `  while (!fs.existsSync(journal + ".resume-" + stage) && Date.now() < until) Atomics.wait(idle, 0, 0, 10);`,
    `};`,
    `const holdAtLock = (path) => { if (holdsLock && String(path) === lock && !heldAtLock) { heldAtLock = true; hold(); } };`,
    `fs.unlinkSync = (path) => {`,
    `  if (isPending(path)) {`,
    `    removals += 1;`,
    `    if ((mode === "kill-at-first-removal" && removals === 1) || (mode === "kill-at-second-removal" && removals === 2)) die();`,
    `  }`,
    `  return real.unlinkSync(path);`,
    `};`,
    `fs.writeFileSync = (path, ...rest) => {`,
    `  if (mode === "kill-before-replace" && String(path).startsWith(journal + ".tmp-")) die();`,
    `  return real.writeFileSync(path, ...rest);`,
    `};`,
    `fs.statSync = (path, ...rest) => { holdAtLock(path); return real.statSync(path, ...rest); };`,
    `fs.readFileSync = (path, ...rest) => {`,
    `  holdAtLock(path);`,
    `  const out = real.readFileSync(path, ...rest);`,
    `  if (holdsJournal && String(path) === journal && !heldAtJournal) { heldAtJournal = true; hold(); }`,
    `  return out;`,
    `};`,
    `syncBuiltinESMExports();`,
    `const { recordHistory } = await import(${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)});`,
    `recordHistory(state, { at: new Date().toISOString(), kind: "served", accountId: "claw3" });`,
    ``,
  ].join("\n"));
  return (state: string, mode: string) => {
    const child = spawn(process.execPath, [script, state, mode, historyFile(state)]);
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
  };
};
const asRoot = process.getuid?.() === 0;

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
    // A write that folds nothing leaves a journal of event lines only.
    recordHistory(state, event("claw1"));
    expect(journalOf(file)).toMatchObject({ receipts: 0, folded: [] });
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw1", "claw2", "claw1", "claw1"]);
  });

  // The parked path writes a file of its own, so it needs its own proof that
  // only allowlisted fields reach disk. The event handed in carries the
  // fields a careless caller could leak; the assertions are on exact keys,
  // so they fail if the allowlist stops rebuilding the event.
  test("a parked event, its folded line and the fold receipt carry only allowlisted content", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-allowlist-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const leaky = { ...event("claw2"), modelId: "claude-fable-5-1", id: "caller-chosen-id", folded: ["caller-chosen-id"],
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
    expect(Object.keys(JSON.parse(parkedRaw) as object).sort()).toEqual(["accountId", "at", "kind", "modelId"]);
    // The file's id is the writer's own random one, never a caller's value.
    expect(pendingId(name)).toMatch(UUID);
    const secrets = /private prompt|secret token|secret credential|sensitive env|PRIVATE_ENV_VALUE|caller-chosen-id|12\.5/;
    expect(parkedRaw).not.toMatch(secrets);
    expect(name).not.toMatch(secrets);
    expect(readHistory(file)).toEqual([{ at: leaky.at, kind: "served", accountId: "claw2", modelId: "claude-fable-5-1" }]);

    // A pending file from any other source goes through the same allowlist when it is folded.
    const foreign = park(dir, Date.now() + 1, 0, { ...event("claw3"), id: "foreign-id", prompt: "private prompt", token: "secret token", env: "sensitive env" });
    recordHistory(state, leaky);
    expect(pendingIn(dir)).toEqual([]);
    const journalRaw = readFileSync(file, "utf8");
    expect(journalRaw).not.toMatch(secrets);
    expect(journalRaw).not.toContain("foreign-id");
    const journal = journalOf(file);
    expect(journal.events.map((l) => Object.keys(l).sort())).toEqual([
      ["accountId", "at", "kind", "modelId"],
      ["accountId", "at", "kind"],
      ["accountId", "at", "kind", "modelId"],
    ]);
    // The receipt names the two files this write consumed, by their random ids, and nothing else.
    expect(journal.receipts).toBe(1);
    expect(journal.folded).toEqual([pendingId(name), foreign.id]);
    expect(journal.folded.every((id) => UUID.test(id))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const view = readHistory(file);
    expect(view).toHaveLength(3);
    expect(view.every((e) => Object.keys(e).every((key) => ["accountId", "at", "kind", "modelId"].includes(key)))).toBe(true);
  });

  // Validation used to compare String(value), then store the value itself.
  // An object that prints as an allowed value passed the check and was
  // serialized whole; a date string can carry free text and still parse.
  test("values that only print as allowed ones are rejected, and a timestamp is stored in canonical form", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-hostile-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const printsAs = (text: string) => ({ toString: () => text, toJSON: () => ({ leaked: "private prompt" }) });
    const hostile = [
      { ...event(), kind: printsAs("served") },
      { ...event(), kind: "retry", reason: printsAs("billing") },
      { ...event(), kind: ["served"] },
      { ...event(), at: "Mon Nov 09 2026 12:00:00 GMT+0000 (private prompt)" },
    ] as unknown as Array<Parameters<typeof recordHistory>[1]>;
    const onDisk = () => readdirSync(dir).filter((name) => name.startsWith("history.jsonl")).map((name) => readFileSync(join(dir, name), "utf8")).join("");

    for (const e of hostile) recordHistory(state, e);
    expect(onDisk()).not.toMatch(/private prompt|leaked/);
    // Only the last one is an event at all, and it is stored as a plain ISO timestamp.
    expect(readHistory(file)).toEqual([{ at: "2026-11-09T12:00:00.000Z", kind: "served", accountId: "claw1" }]);

    // The parked path applies the same check before anything is written.
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      for (const e of hostile) recordHistory(state, e);
    } finally { release?.(); }
    expect(pendingIn(dir)).toHaveLength(1);
    expect(onDisk()).not.toMatch(/private prompt|leaked/);
    expect(readHistory(file)).toEqual([
      { at: "2026-11-09T12:00:00.000Z", kind: "served", accountId: "claw1" },
      { at: "2026-11-09T12:00:00.000Z", kind: "served", accountId: "claw1" },
    ]);
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
    expect(journalOf(file).folded).toEqual(left.map(({ name }) => pendingId(name)));
    // The on-disk state of a holder that stopped right after its replace:
    // the journal holds both events and both pending files are still there.
    const stoppedBeforeRemoval = () => { for (const { name, content } of left) writeFileSync(join(dir, name), content, { mode: 0o600 }); };
    stoppedBeforeRemoval();
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
    expect(journalOf(file).events).toHaveLength(5);
    // ...and it stays that way when one holder after another stops at the same point.
    for (let holder = 0; holder < 3; holder++) {
      stoppedBeforeRemoval();
      recordHistory(state, event("claw1"));
      expect(models()).toEqual(["parked-one", "parked-two"]);
      expect(journalOf(file).events).toHaveLength(6 + holder);
    }
    expect(pendingIn(dir)).toEqual([]);
  });

  // The receipt has to outlive the folded lines. Here every holder stops
  // before removing the pending files, for long enough that the cap trims
  // the folded events out of the journal. A receipt tied to the retained
  // lines would then take the files for new, bring the old events back and
  // push committed ones out.
  test("pending files left behind stay consumed after the cap has trimmed their events", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-trimmed-replay-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 600_000;
    const wide = (label: string) => `${label}-${"a".repeat(98 - label.length)}`;
    const big = (i: number, label: string) => ({ at: new Date(base + i).toISOString(), kind: "retry" as const, accountId: wide(label), toAccountId: wide(label), reason: "model_limit" as const });
    const left = [0, 1, 2].map((i) => park(dir, base + i, 0, big(i, `parked${i}`)))
      .map(({ name }) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
    const stoppedBeforeRemoval = () => { for (const { name, content } of left) writeFileSync(join(dir, name), content, { mode: 0o600 }); };
    const parkedSeen = () => readHistory(file).filter((e) => e.accountId.startsWith("parked")).length;

    recordHistory(state, big(10, "own0000"));
    expect(parkedSeen()).toBe(3);
    let last = 3;
    let trimmedAt = -1;
    for (let i = 1; i <= 400; i++) {
      stoppedBeforeRemoval();
      // A reader in the window sees no more than the journal holds...
      expect(parkedSeen()).toBe(last);
      recordHistory(state, big(10 + i, `own${String(i).padStart(4, "0")}`));
      const seen = parkedSeen();
      // ...and a write never doubles one or brings a trimmed one back.
      expect(seen).toBeLessThanOrEqual(last);
      last = seen;
      if (trimmedAt < 0 && seen === 0) trimmedAt = i;
      expect(pendingIn(dir)).toEqual([]);
    }
    expect(last).toBe(0);
    // The byte cap did trim them part-way through, with the files still coming back.
    expect(trimmedAt).toBeGreaterThan(0);
    expect(trimmedAt).toBeLessThan(400);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    // What is left is exactly the newest committed events, in order.
    const kept = readHistory(file).map((e) => e.accountId);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, k) => wide(`own${String(400 - kept.length + 1 + k).padStart(4, "0")}`)));
  }, 30_000);

  // The same windows with a real process, stopped outright at a chosen point
  // of its locked write. Each leaves its own lock behind as well.
  test.each([
    { mode: "kill-at-first-removal", journalHasFold: true, pendingLeft: 2 },
    { mode: "kill-at-second-removal", journalHasFold: true, pendingLeft: 1 },
    { mode: "kill-before-replace", journalHasFold: false, pendingLeft: 2 },
  ])("a writer killed mid-write ($mode) loses nothing and doubles nothing", async ({ mode, journalHasFold, pendingLeft }) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-killed-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    const before = readFileSync(file, "utf8");
    const release = acquireShimLock(file);
    expect(release).toBeDefined();
    try {
      recordHistory(state, { ...event("claw2"), modelId: "parked-one" });
      recordHistory(state, { ...event("claw2"), modelId: "parked-two" });
    } finally { release?.(); }
    const parked = pendingIn(dir);
    expect(parked).toHaveLength(2);

    expect(await interruptedWriter(dir)(state, mode)).toEqual({ code: null, signal: "SIGKILL" });
    expect(pendingIn(dir)).toHaveLength(pendingLeft);
    expect(existsSync(shimLockFile(file))).toBe(true);
    if (journalHasFold) {
      // Killed after its replace: the journal holds everything it folded and
      // names both files, including the one it did get to remove.
      expect(journalOf(file).events.map((l) => l.accountId)).toEqual(["claw1", "claw2", "claw2", "claw3"]);
      expect(journalOf(file).folded).toEqual(parked.map(pendingId));
    } else {
      // Killed before its replace: journal untouched, its own event never recorded.
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    const expected = journalHasFold ? ["claw1", "claw2", "claw2", "claw3"] : ["claw1", "claw2", "claw2"];
    const accounts = () => readHistory(file).map((e) => e.accountId);
    expect(accounts()).toEqual(expected);
    // The next writer takes over the dead holder's lock, adds its own event
    // once, and clears the leftovers without applying them again.
    recordHistory(state, event("claw1"));
    expect(accounts()).toEqual([...expected, "claw1"]);
    expect(journalOf(file).events).toHaveLength(expected.length + 1);
    expect(readHistory(file).filter((e) => e.accountId === "claw2").map((e) => e.modelId)).toEqual(["parked-one", "parked-two"]);
    expect(pendingIn(dir)).toEqual([]);
    expect(existsSync(shimLockFile(file))).toBe(false);
    recordHistory(state, event("claw1"));
    expect(accounts()).toEqual([...expected, "claw1", "claw1"]);
  }, 15_000);

  // External replacement can remove a live holder's lock; the holder must
  // not write a stale journal from before the replacement's commit.
  test("a holder that lost its lock while paused does not replace the journal with its stale snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-stale-holder-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    park(dir, Date.now() - 1000, 0, { ...event("claw2"), modelId: "parked" });
    const exit = interruptedWriter(dir)(state, "hold-after-journal-read");
    // The child now holds the lock, has read the journal and is held there.
    expect(await waitFor(`${file}.held-1`)).toBe(true);
    expect(existsSync(shimLockFile(file))).toBe(true);
    // Simulate external replacement (a live holder is never reclaimed by age).
    unlinkSync(shimLockFile(file));
    recordHistory(state, event("claw4"));
    expect(journalOf(file).events.map((l) => l.accountId)).toEqual(["claw1", "claw2", "claw4"]);
    expect(pendingIn(dir)).toEqual([]);
    const committed = readFileSync(file, "utf8");
    writeFileSync(`${file}.resume-1`, "");
    expect(await exit).toEqual({ code: 0, signal: null });
    // The paused holder backed off: the journal is the other writer's, byte
    // for byte, and its own event is parked instead of lost.
    expect(readFileSync(file, "utf8")).toBe(committed);
    expect(pendingIn(dir)).toHaveLength(1);
    expect(readHistory(file).map((e) => e.accountId).sort()).toEqual(["claw1", "claw2", "claw3", "claw4"]);
    recordHistory(state, event("claw1"));
    expect(readHistory(file).map((e) => e.accountId).sort()).toEqual(["claw1", "claw1", "claw2", "claw3", "claw4"]);
    expect(journalOf(file).events).toHaveLength(5);
    expect(pendingIn(dir)).toEqual([]);
  }, 20_000);

  // Ownership has to be what the acquisition itself established. A holder
  // that learns "its" lock by reading the lock file back can be paused before
  // that read, lose the lock, and then take the new holder's lock for its
  // own: every later check passes while the other writer is still inside.
  test("a holder replaced right after it took the lock does not mistake the new holder's lock for its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-adopted-lock-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, event("claw1"));
    // The child is held twice: at its first look at the lock file and after
    // its journal read, in whichever order its code reaches them.
    const exit = interruptedWriter(dir)(state, "hold-at-lock-and-journal");
    expect(await waitFor(`${file}.held-1`)).toBe(true);
    // Simulate external replacement while the original holder is still live.
    unlinkSync(shimLockFile(file));
    const other = acquireShimLock(file);
    expect(other).toBeDefined();
    writeFileSync(`${file}.resume-1`, "");
    expect(await waitFor(`${file}.held-2`)).toBe(true);
    // That writer commits while the child is paused again, and is still inside its own write.
    const committed = `${readFileSync(file, "utf8")}${JSON.stringify({ ...event("claw4"), modelId: "committed" })}\n`;
    writeFileSync(file, committed, { mode: 0o600 });
    writeFileSync(`${file}.resume-2`, "");
    expect(await exit).toEqual({ code: 0, signal: null });
    try {
      // The child neither replaced that commit nor released a lock that is not its own.
      expect(readFileSync(file, "utf8")).toBe(committed);
      expect(other?.held()).toBe(true);
      expect(pendingIn(dir)).toHaveLength(1);
    } finally { other?.(); }
    expect(readHistory(file).map((e) => e.accountId).sort()).toEqual(["claw1", "claw3", "claw4"]);
    recordHistory(state, event("claw1"));
    expect(pendingIn(dir)).toEqual([]);
    expect(readHistory(file).map((e) => e.accountId).sort()).toEqual(["claw1", "claw1", "claw3", "claw4"]);
  }, 30_000);

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

  // A reader takes no lock. One that has read the pending files and then
  // meets a journal that a fold has just replaced must not count the folded
  // events from both places, and must not put back what that fold trimmed.
  test("a reader that overlaps a fold returns each event once and nothing the fold trimmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-reader-overlap-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 600_000;
    const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    // A full journal, so the fold has to trim to make room.
    for (let i = 0; i < HISTORY_MAX_EVENTS; i++) recordHistory(state, { at: stamp(i), kind: "served", accountId: "claw1", modelId: `j${i}` });
    for (let i = 0; i < 3; i++) park(dir, base + 1000 + i, 0, { at: stamp(1000 + i), kind: "served", accountId: "claw2", modelId: `p${i}` });
    const expectedBefore = [...Array.from({ length: HISTORY_MAX_EVENTS - 3 }, (_, i) => `j${i + 3}`), "p0", "p1", "p2"];
    expect(readHistory(file).map((e) => e.modelId)).toEqual(expectedBefore);

    // Two writes land after the reader has read the pending files. The first
    // folds them and names them in its receipt; the second finds nothing
    // pending, so its journal carries no receipt. Taken together with the
    // files it already read, that journal would count each folded event
    // twice. The journal changed under the reader, so it reads again.
    let overlaps = 0;
    const view = readHistory(file, { afterPending: () => {
      if (overlaps++ > 0) return;
      recordHistory(state, { at: stamp(2000), kind: "served", accountId: "claw1", modelId: "own-a" });
      recordHistory(state, { at: stamp(2001), kind: "served", accountId: "claw1", modelId: "own-b" });
    } });
    expect(overlaps).toBe(2);
    expect(pendingIn(dir)).toEqual([]);
    expect(journalOf(file).receipts).toBe(0);
    const expectedAfter = [...Array.from({ length: HISTORY_MAX_EVENTS - 5 }, (_, i) => `j${i + 5}`), "p0", "p1", "p2", "own-a", "own-b"];
    expect(view.map((e) => e.modelId)).toEqual(expectedAfter);
    expect(readHistory(file).map((e) => e.modelId)).toEqual(expectedAfter);

    // One write lands in the same place and stops before removing the files
    // it folded: the reader holds their contents and meets a journal whose
    // receipt names them.
    const again = [0, 1].map((i) => park(dir, base + 2500 + i, 0, { at: stamp(2500 + i), kind: "served", accountId: "claw2", modelId: `q${i}` }))
      .map(({ name }) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
    let once = 0;
    const during = readHistory(file, { afterPending: () => {
      if (once++ > 0) return;
      recordHistory(state, { at: stamp(2600), kind: "served", accountId: "claw1", modelId: "own-c" });
      for (const { name, content } of again) writeFileSync(join(dir, name), content, { mode: 0o600 });
    } });
    const expectedDuring = [...expectedAfter.slice(3), "q0", "q1", "own-c"];
    expect(during.map((e) => e.modelId)).toEqual(expectedDuring);
    recordHistory(state, { at: stamp(2700), kind: "served", accountId: "claw1", modelId: "own-d" });
    expect(pendingIn(dir)).toEqual([]);
    expect(readHistory(file).map((e) => e.modelId)).toEqual([...expectedDuring.slice(1), "own-d"]);

    // Writers that never let up: the journal changes under every attempt, and
    // on the last one a parked event the reader has already read is folded
    // and then loses its receipt to a second write. Combined with that
    // journal the reader's copy would count the event twice, so the reader
    // returns the journal alone.
    let attempts = 0;
    const busy = readHistory(file, { afterPending: () => {
      attempts += 1;
      if (attempts === 2) {
        recordHistory(state, { at: stamp(3000), kind: "served", accountId: "claw1", modelId: "busy-a" });
        // Parked after that write, so the third attempt reads it as pending.
        park(dir, base + 3100, 0, { at: stamp(3100), kind: "served", accountId: "claw2", modelId: "late" });
        return;
      }
      recordHistory(state, { at: stamp(3200 + attempts), kind: "served", accountId: "claw1", modelId: `busy-b${attempts}` });
      recordHistory(state, { at: stamp(3300 + attempts), kind: "served", accountId: "claw1", modelId: `busy-c${attempts}` });
    } });
    expect(attempts).toBe(3);
    expect(pendingIn(dir)).toEqual([]);
    expect(journalOf(file).receipts).toBe(0);
    expect(busy).toHaveLength(HISTORY_MAX_EVENTS);
    expect(busy.filter((e) => e.modelId === "late")).toHaveLength(1);
    expect(new Set(busy.map((e) => e.modelId)).size).toBe(HISTORY_MAX_EVENTS);
    // It is the journal as last committed, which a settled read returns too.
    expect(busy).toEqual(readHistory(file));
  }, 30_000);

  // Equal bytes are not an unchanged journal. With a full journal of
  // identical events, a fold of a parked event followed by enough identical
  // writes trims that event out again and leaves the journal byte for byte
  // as the reader first saw it. The reader's cached copy of the parked file
  // must not be added to it: that would bring back what the cap trimmed.
  test("a reader does not take a journal replaced with the same bytes for one that did not change", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-same-bytes-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const same = { at: new Date(Date.now() - 60_000).toISOString(), kind: "served" as const, accountId: "claw1", modelId: "same" };
    for (let i = 0; i < HISTORY_MAX_EVENTS; i++) recordHistory(state, same);
    const full = readFileSync(file, "utf8");
    park(dir, Date.now() - 1000, 0, { ...same, accountId: "claw2", modelId: "parked" });
    expect(readHistory(file).filter((e) => e.modelId === "parked")).toHaveLength(1);

    let attempts = 0;
    const view = readHistory(file, { afterPending: () => {
      if (attempts++ > 0) return;
      // The first write folds the parked event; the rest push it out.
      for (let i = 0; i < HISTORY_MAX_EVENTS; i++) recordHistory(state, same);
      expect(readFileSync(file, "utf8")).toBe(full);
      expect(pendingIn(dir)).toEqual([]);
    } });
    expect(attempts).toBe(2);
    expect(view.filter((e) => e.modelId === "parked")).toEqual([]);
    expect(view).toEqual(readHistory(file));
    expect(view).toHaveLength(HISTORY_MAX_EVENTS);
  }, 30_000);

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
    expect(journalOf(file).events.map((l) => l.modelId)).toEqual([...order, "own"]);
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
  // events too, and a long lock hold can park any number of them. A locked
  // write folds a bounded share, oldest first, and removes only files that a
  // committed receipt names: the ones it read and folded, and leftovers an
  // earlier write named, which it does not read again.
  test("the read view stays inside the journal bound however many events are parked, and a backlog drains without loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-cap-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 120_000;
    const stamp = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    for (let i = 0; i < 10; i++) recordHistory(state, { at: stamp(i), kind: "served", accountId: "claw1", modelId: `j${i}` });
    const parkedCount = HISTORY_MAX_EVENTS + 20;
    for (let i = 0; i < parkedCount; i++) park(dir, base + 1000 + i, 0, { at: stamp(1000 + i), kind: "served", accountId: "claw2", modelId: `m${i}` });
    expect(pendingIn(dir)).toHaveLength(parkedCount);
    const m = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);

    const view = readHistory(file);
    expect(view).toHaveLength(HISTORY_MAX_EVENTS);
    // Exactly the 500 most recently parked events, oldest first.
    expect(view.map((e) => e.modelId)).toEqual(m(20, 519));
    // Reading never folds or removes anything.
    expect(pendingIn(dir)).toHaveLength(parkedCount);

    // One locked write folds the oldest HISTORY_FOLD_MAX and removes exactly those.
    recordHistory(state, { at: stamp(5000), kind: "served", accountId: "claw1", modelId: "own0" });
    expect(pendingIn(dir)).toHaveLength(parkedCount - HISTORY_FOLD_MAX);
    expect(journalOf(file).events.map((l) => l.modelId)).toEqual([...Array.from({ length: 10 }, (_, i) => `j${i}`), ...m(0, 99), "own0"]);
    expect(journalOf(file).folded).toHaveLength(HISTORY_FOLD_MAX);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(readHistory(file).map((e) => e.modelId)).toEqual([...m(21, 519), "own0"]);

    // Later writes take the rest in turn; nothing is removed before it is folded.
    let writes = 1;
    while (pendingIn(dir).length) {
      const before = pendingIn(dir).length;
      recordHistory(state, { at: stamp(5000 + writes), kind: "served", accountId: "claw1", modelId: `own${writes}` });
      expect(pendingIn(dir)).toHaveLength(Math.max(0, before - HISTORY_FOLD_MAX));
      expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
      expect(readHistory(file)).toHaveLength(HISTORY_MAX_EVENTS);
      writes += 1;
    }
    expect(writes).toBe(6);
    const drained = readHistory(file).map((e) => e.modelId);
    expect(drained).toEqual([...m(26, 519), "own0", "own1", "own2", "own3", "own4", "own5"]);
    expect(journalOf(file).events).toHaveLength(HISTORY_MAX_EVENTS);
  });

  test("the read view and the journal file honour the byte bound when parked events are large", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-parked-bytes-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 120_000;
    const wide = (i: number) => `${String(i).padStart(4, "0")}-${"a".repeat(95)}`;
    const big = (i: number) => ({ at: new Date(base + i).toISOString(), kind: "retry" as const, accountId: wide(i), toAccountId: wide(i), reason: "model_limit" as const });
    for (let i = 0; i < 400; i++) park(dir, base + i, 0, big(i));
    const bytes = (events: ReturnType<typeof readHistory>) => events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e) + "\n"), 0);
    const view = readHistory(file);
    expect(view.length).toBeGreaterThan(0);
    expect(view.length).toBeLessThan(400);
    expect(bytes(view)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    // One more event would not have fitted: the view is full, not merely small.
    expect(bytes(view) + Buffer.byteLength(JSON.stringify(big(0)) + "\n")).toBeGreaterThan(HISTORY_MAX_BYTES);
    expect(view.at(-1)?.accountId).toBe(wide(399));
    // The journal file, receipt line included, stays inside the same bound through the drain.
    for (let write = 0; pendingIn(dir).length; write++) {
      recordHistory(state, big(1000 + write));
      expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
      expect(journalOf(file).folded.length).toBeGreaterThan(0);
    }
    const after = readHistory(file);
    expect(bytes(after)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(after.at(-1)?.accountId).toBe(wide(1003));
    expect(after.filter((e) => e.accountId < wide(1000)).at(-1)?.accountId).toBe(wide(399));
  });

  // A read that fails is not an empty file. Treating it as one let a fold
  // remove a pending file it never read, or replace a journal it never read.
  test.skipIf(asRoot)("a pending file that cannot be read is left in place and folded once it can be", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-unreadable-pending-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    const base = Date.now() - 60_000;
    const stamped = (offsetMs: number, modelId: string) => ({ at: new Date(base + offsetMs).toISOString(), kind: "served" as const, accountId: "claw2", modelId });
    recordHistory(state, stamped(0, "first"));
    const locked = park(dir, base + 100, 0, stamped(100, "unreadable"));
    const open = park(dir, base + 200, 0, stamped(200, "readable"));
    chmodSync(join(dir, locked.name), 0o000);
    try {
      recordHistory(state, stamped(300, "second"));
      // The readable one was folded and removed; the other was neither consumed nor removed.
      expect(pendingIn(dir)).toEqual([locked.name]);
      expect(journalOf(file).folded).toEqual([open.id]);
      expect(readHistory(file).map((e) => e.modelId)).toEqual(["first", "readable", "second"]);
    } finally { chmodSync(join(dir, locked.name), 0o600); }
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["first", "unreadable", "readable", "second"]);
    recordHistory(state, stamped(400, "third"));
    expect(pendingIn(dir)).toEqual([]);
    expect(journalOf(file).folded).toEqual([locked.id]);
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["first", "unreadable", "readable", "second", "third"]);
  });

  test.skipIf(asRoot)("a journal that cannot be read is not replaced; the event is parked until it can be", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-unreadable-journal-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    for (let i = 0; i < 3; i++) recordHistory(state, { ...event("claw1"), modelId: `kept${i}` });
    const before = readFileSync(file, "utf8");
    chmodSync(file, 0o000);
    try {
      recordHistory(state, { ...event("claw2"), modelId: "during" });
    } finally { chmodSync(file, 0o600); }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(pendingIn(dir)).toHaveLength(1);
    expect(existsSync(shimLockFile(file))).toBe(false);
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["kept0", "kept1", "kept2", "during"]);
    recordHistory(state, { ...event("claw1"), modelId: "after" });
    expect(pendingIn(dir)).toEqual([]);
    expect(readHistory(file).map((e) => e.modelId)).toEqual(["kept0", "kept1", "kept2", "during", "after"]);
  });

  test.skipIf(asRoot)("a directory that cannot be listed stops the write from replacing the journal or dropping a receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-unlistable-"));
    const state = join(dir, "claw1.json");
    const file = historyFile(state);
    recordHistory(state, { ...event("claw1"), modelId: "first" });
    // A fold that committed and stopped before removing the file it folded.
    const left = park(dir, Date.now() - 1000, 0, { ...event("claw2"), modelId: "folded" });
    const content = readFileSync(join(dir, left.name), "utf8");
    recordHistory(state, { ...event("claw1"), modelId: "second" });
    writeFileSync(join(dir, left.name), content, { mode: 0o600 });
    const before = readFileSync(file, "utf8");
    expect(journalOf(file).folded).toEqual([left.id]);

    // Files can still be created and opened by name, but not listed. A write
    // that took "cannot list" for "nothing pending" would replace the journal
    // without the receipt, and the leftover file would later count twice.
    chmodSync(dir, 0o300);
    try {
      recordHistory(state, { ...event("claw1"), modelId: "during" });
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally { chmodSync(dir, 0o700); }
    expect(pendingIn(dir)).toHaveLength(2);
    const models = () => readHistory(file).map((e) => e.modelId).sort();
    expect(models()).toEqual(["during", "first", "folded", "second"]);
    recordHistory(state, { ...event("claw1"), modelId: "after" });
    expect(pendingIn(dir)).toEqual([]);
    expect(models()).toEqual(["after", "during", "first", "folded", "second"]);
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
