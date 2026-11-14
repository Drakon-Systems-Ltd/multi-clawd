import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSessionPin, recordSessionPin } from "../src/session-affinity.js";

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

function runWriter(file: string, worker: number, count: number): Promise<string> {
  const script = `
    import { recordSessionPin } from ${JSON.stringify(join(dir, "session-affinity.js"))};
    for (let i = 0; i < ${count}; i++) {
      recordSessionPin(${JSON.stringify(file)}, "w${worker}s" + i, "claw${worker}", Date.now(), 60_000);
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
