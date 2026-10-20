import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vitest";

// Concurrent turns are separate shim processes writing one pin store. Run the
// real store module in several child processes at once and require that no
// pin is lost and no temp or lock file is left behind.
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

test("simultaneous shim processes keep every session pin", async () => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  transpile("session-handover");
  transpile("session-affinity");
  const stateDir = join(dir, "state");
  const file = join(stateDir, "pool-clawd.sessions.json");
  const workers = 6;
  const perWorker = 25;
  await Promise.all(Array.from({ length: workers }, (_, w) => runWriter(file, w, perWorker)));
  const pins = JSON.parse(readFileSync(file, "utf8"));
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) expect(pins[`w${w}s${i}`]?.account).toBe(`claw${w}`);
  }
  expect(Object.keys(pins)).toHaveLength(workers * perWorker);
  expect(readdirSync(stateDir).filter((name) => name.endsWith(".lock") || name.includes(".tmp-"))).toEqual([]);
}, 30_000);
