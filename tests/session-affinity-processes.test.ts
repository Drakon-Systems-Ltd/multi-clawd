import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_PARKED_PINS, readSessionPin, recordSessionPin } from "../src/session-affinity.js";

// Concurrent turns are separate shim processes writing one pin store. Run the
// real store module in several child processes at once and require that no
// pin is lost and no temp or lock file is left behind. A writer that waits
// out its lock budget parks its pin instead of dropping it (#178), so "kept"
// is what the next turn reads, and one more write folds every parked pin in.
const ROOT = join(__dirname, "..");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mc-affinity-procs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function transpile(name: string): void {
  const source = readFileSync(join(ROOT, "src", `${name}.ts`), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  writeFileSync(join(dir, `${name}.js`), out.outputText);
}

function runWriter(file: string, worker: number, count: number, account = `claw${worker}`): Promise<string> {
  const script = `
    import { recordSessionPin } from ${JSON.stringify(join(dir, "session-affinity.js"))};
    for (let i = 0; i < ${count}; i++) {
      recordSessionPin(${JSON.stringify(file)}, "w${worker}s" + i, ${JSON.stringify(account)}, Date.now(), 60_000);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`writer ${worker} exited ${code}: ${output}`)));
  });
}

function prepare(): string {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  transpile("session-handover");
  transpile("shim-lock");
  transpile("session-affinity");
  return join(dir, "state", "pool-clawd.sessions.json");
}

const leftovers = (stateDir: string) => readdirSync(stateDir).filter((name) =>
  name.endsWith(".lock") || name.includes(".tmp-") || name.includes(".pending-"));

test("simultaneous shim processes keep every session pin", async () => {
  const file = prepare();
  const workers = 6;
  const perWorker = 25;
  await Promise.all(Array.from({ length: workers }, (_, w) => runWriter(file, w, perWorker)));
  const now = Date.now();
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(readSessionPin(file, `w${w}s${i}`, now, 60_000)?.account).toBe(`claw${w}`);
  }
  recordSessionPin(file, "last", "claw0", now, 60_000);
  const pins = JSON.parse(readFileSync(file, "utf8"));
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(pins[`w${w}s${i}`]?.account).toBe(`claw${w}`);
  }
  expect(Object.keys(pins)).toHaveLength(workers * perWorker + 1);
  expect(leftovers(join(dir, "state"))).toEqual([]);
}, 30_000);

// The CI failure this guards (#178): a writer still waiting when its lock
// budget ran out dropped its pin and exited 0. Here every writer is made to
// wait out the budget: the lock is held for the whole of each child's run.
test("shim processes starved of the lock for their whole run lose no pin", async () => {
  const file = prepare();
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  recordSessionPin(file, "before", "claw9", Date.now(), 60_000);
  writeFileSync(`${file}.lock`, "held");
  const workers = 4;
  const perWorker = 2;
  await Promise.all(Array.from({ length: workers }, (_, w) => runWriter(file, w, perWorker)));
  // Nobody replaced the store without the lock, and the lock is untouched.
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["before"]);
  expect(readFileSync(`${file}.lock`, "utf8")).toBe("held");
  const now = Date.now();
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(readSessionPin(file, `w${w}s${i}`, now, 60_000)?.account).toBe(`claw${w}`);
  }
  rmSync(`${file}.lock`);
  recordSessionPin(file, "after", "claw9", now, 60_000);
  const pins = JSON.parse(readFileSync(file, "utf8"));
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(pins[`w${w}s${i}`]?.account).toBe(`claw${w}`);
  }
  expect(Object.keys(pins)).toHaveLength(workers * perWorker + 2);
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(leftovers(stateDir)).toEqual([]);
}, 30_000);

// The lock names this test process, which is alive for the whole test: no
// waiter may reclaim it (#151), so every child below is starved for its whole
// run. This is the live-holder starvation the reviews of #179 probed with.
const LIVE_HOLDER = "review-179-live-holder";
const holdLiveLock = (file: string) => writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()} ${LIVE_HOLDER}\n`);
const pendingIn = (stateDir: string) => readdirSync(stateDir).filter((name) => name.includes(".pending-"));

// Review of #179, finding 1: a read opened only the 64 most recently parked
// files in the pool, so a session whose pin was parked earlier read a stale
// stored pin, or none.
test.each([
  ["and no store", false],
  ["and an older stored pin for every session", true],
])("more sessions parked than one fold takes, %s: each session reads its own parked pin", async (_name, stale) => {
  const file = prepare();
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const workers = 10;
  const perWorker = 7;
  expect(workers * perWorker).toBeGreaterThan(MAX_PARKED_PINS);
  const before = Date.now() - 1000;
  if (stale) {
    const pins: Record<string, { account: string; servedAt: number }> = {};
    for (let w = 0; w < workers; w++) {
      for (let i = 0; i < perWorker; i++) pins[`w${w}s${i}`] = { account: "stale", servedAt: before };
    }
    writeFileSync(file, JSON.stringify(pins));
  }
  const storeBefore = stale ? readFileSync(file, "utf8") : undefined;
  holdLiveLock(file);
  await Promise.all(Array.from({ length: workers }, (_, w) => runWriter(file, w, perWorker)));
  // One parked file per session, the store untouched, the live lock intact.
  expect(pendingIn(stateDir)).toHaveLength(workers * perWorker);
  expect(existsSync(file) ? readFileSync(file, "utf8") : undefined).toBe(storeBefore);
  expect(readFileSync(`${file}.lock`, "utf8")).toContain(LIVE_HOLDER);
  const now = Date.now();
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(readSessionPin(file, `w${w}s${i}`, now, 60_000)?.account).toBe(`claw${w}`);
  }
  // Once the lock is free, later writes fold every parked pin into the store.
  rmSync(`${file}.lock`);
  for (let round = 0; round < 4 && pendingIn(stateDir).length > 0; round++) {
    recordSessionPin(file, `after${round}`, "claw9", now, 60_000);
    for (let w = 0; w < workers; w++) {
      for (let i = 0; i < perWorker; i++) expect(readSessionPin(file, `w${w}s${i}`, now, 60_000)?.account).toBe(`claw${w}`);
    }
  }
  const pins = JSON.parse(readFileSync(file, "utf8"));
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(pins[`w${w}s${i}`]?.account).toBe(`claw${w}`);
  }
  expect(leftovers(stateDir)).toEqual([]);
}, 60_000);

// Review of #179, finding 3: every starved write left a new file, so waves of
// turns against a lock that stayed held grew the directory without limit, and
// nothing removed a parked pin once it was past the TTL.
test("waves of shim processes starved by a live holder leave one parked file per session, holding its latest pin", async () => {
  const file = prepare();
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  holdLiveLock(file);
  const workers = 6;
  const perWorker = 3;
  const waves = 3;
  for (let wave = 0; wave < waves; wave++) {
    await Promise.all(Array.from({ length: workers }, (_, w) => runWriter(file, w, perWorker, `wave${wave}`)));
    expect(pendingIn(stateDir)).toHaveLength(workers * perWorker);
    const now = Date.now();
    for (let w = 0; w < workers; w++) {
      for (let i = 0; i < perWorker; i++) expect(readSessionPin(file, `w${w}s${i}`, now, 60_000)?.account).toBe(`wave${wave}`);
    }
  }
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(`${file}.lock`, "utf8")).toContain(LIVE_HOLDER);
  // Still starved, past the TTL of every pin above: one more parked write
  // clears the expired backlog and keeps its own pin.
  const later = Date.now() + 60_000;
  recordSessionPin(file, "late", "claw9", later, 60_000);
  expect(pendingIn(stateDir)).toHaveLength(1);
  expect(readSessionPin(file, "late", later, 60_000)).toEqual({ account: "claw9", servedAt: later });
  expect(readFileSync(`${file}.lock`, "utf8")).toContain(LIVE_HOLDER);
}, 60_000);
