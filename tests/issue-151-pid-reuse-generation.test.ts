import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as shimLock from "../src/shim-lock";
import { persistHealthState, readHealthStateFile } from "../src/health-journal";
import { historyFile, readHistory, recordHistory } from "../src/history";
import type { AccountHealthState } from "../src/shim-core";

/*
 * #151 follow-up: PID reuse. A lock records its holder's generation (the
 * process start time, /proc/<pid>/stat field 22) next to the pid. Liveness
 * alone no longer pins a lock: a live pid whose current generation differs
 * from the recorded one is a reused pid, so the recorded holder is dead.
 *
 * Contract these tests assume:
 *  - lock bytes are `<pid> <ms> <token> <generation>\n`; legacy locks carry
 *    only `<pid> <ms>` or `<pid> <ms> <token>`.
 *  - `parseProcStatStartTime(stat)` is exported from src/shim-lock and returns
 *    field 22 (as a string or number) or undefined for unparseable input.
 *  - acquireShimLock's hooks accept `procRoot` (default "/proc"); the writer
 *    reads its own generation from `<procRoot>/self/stat` or
 *    `<procRoot>/<process.pid>/stat` and the holder's from `<procRoot>/<pid>/stat`.
 *  - a generation that cannot be read (procfs missing, entry missing,
 *    unparseable) never lets age reclaim a kill-confirmed live holder.
 *  - a legacy lock naming a live pid stays protected (identity unknown).
 */

type Hooks = NonNullable<Parameters<typeof shimLock.acquireShimLock>[2]> & { procRoot?: string };
const acquire = (file: string, waitMs: number, hooks: Hooks) => shimLock.acquireShimLock(file, waitMs, hooks as never);
const parse = (stat: string) =>
  (shimLock as unknown as { parseProcStatStartTime: (s: string) => string | number | bigint | undefined }).parseProcStatStartTime(stat);

const box = () => mkdtempSync(join(tmpdir(), "mc-151-gen-"));
const LATER_MS = 60_000;
const OWN_GEN = "424242";

/** A /proc/<pid>/stat line with distinct values in every field, so a parser that picks the wrong field is caught. */
function statLine(pid: number, comm: string, starttime: string): string {
  // Fields 3..21, then 22 = starttime, then a few trailing fields.
  const middle = ["S", "1", "7003", "7004", "0", "-1", "4194560", "1010", "1011", "1012", "1013", "1014", "1015", "1016", "1017", "20", "0", "9", "0"];
  return `${pid} (${comm}) ${middle.join(" ")} ${starttime} 123456789 4321 18446744073709551615\n`;
}

/** A fake procfs root holding the writer's own entry plus any `entries` given. */
function fakeProc(entries: Record<number, string> = {}): string {
  const root = join(box(), "proc");
  const put = (name: string, line: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "stat"), line);
  };
  put("self", statLine(process.pid, "node", OWN_GEN));
  put(String(process.pid), statLine(process.pid, "node", OWN_GEN));
  for (const [pid, gen] of Object.entries(entries)) put(pid, statLine(Number(pid), "reused proc", gen));
  return root;
}

function writeStaleLock(target: string, content: string): string {
  const lock = `${target}.lock`;
  writeFileSync(lock, content);
  const old = new Date(Date.now() - LATER_MS);
  utimesSync(lock, old, old);
  return lock;
}

function later<T>(fn: () => T): T {
  const real = Date.now;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + LATER_MS);
  try { return fn(); } finally { spy.mockRestore(); }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("parseProcStatStartTime: Linux /proc/<pid>/stat field 22", () => {
  const START = "987654321";

  test.each([
    ["plain", "node"],
    ["spaces", "Web Content"],
    ["close paren", "a) b"],
    ["decoy fields", "x) 1 2 3 (y"],
    ["only close paren", ")"],
    ["only open paren", "("],
    ["nested parens", "((a))"],
    ["reversed parens", ")("],
    ["empty", ""],
    ["trailing paren and space", "z) "],
  ])("comm with %s", (_label, comm) => {
    expect(String(parse(statLine(4242, comm, START)))).toBe(START);
  });

  test("without a trailing newline", () => {
    expect(String(parse(statLine(1, "init", START).trimEnd()))).toBe(START);
  });

  test("a stat line truncated right at field 22", () => {
    const line = statLine(1, "a) b", START);
    const cut = line.slice(0, line.indexOf(` ${START} `) + START.length + 1);
    expect(String(parse(cut))).toBe(START);
  });

  test.each([
    ["empty input", ""],
    ["no comm close paren", "42 (node S 1 2 3"],
    ["too few fields", "42 (node) S 1 2 3 4 5\n"],
    ["non-numeric starttime", statLine(42, "node", "abc")],
    ["negative starttime", statLine(42, "node", "-5")],
  ])("rejects %s", (_label, stat) => {
    expect(parse(stat)).toBeUndefined();
  });

  test.runIf(process.platform === "linux" && existsSync("/proc/self/stat"))("parses this process's real stat", () => {
    const out = parse(readFileSync("/proc/self/stat", "utf8"));
    expect(String(out)).toMatch(/^\d+$/);
  });
});

describe("generation-checked liveness with a fake procfs", () => {
  test("a reused live pid (this process) with an old generation is reclaimed", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const lock = writeStaleLock(target, `${process.pid} ${Date.now() - LATER_MS} old-token 111\n`);

    const release = acquire(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    const fields = readFileSync(lock, "utf8").trim().split(" ");
    expect(fields[0]).toBe(String(process.pid));
    expect(fields[2]).not.toBe("old-token");
    expect(fields[3]).toBe(OWN_GEN);
    release?.();
    expect(existsSync(lock)).toBe(false);
  });

  test("a reused live pid owned by another user (pid 1) with an old generation is reclaimed", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc({ 1: "1" });
    const lock = writeStaleLock(target, `1 ${Date.now() - LATER_MS} old-token 999\n`);

    const release = acquire(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    expect(readFileSync(lock, "utf8").startsWith(`${process.pid} `)).toBe(true);
    release?.();
    expect(existsSync(lock)).toBe(false);
  });

  test("a reused pid reported live via EPERM with an old generation is reclaimed", () => {
    const target = join(box(), "home.json");
    const holder = 31337;
    const procRoot = fakeProc({ [holder]: "5000" });
    const lock = writeStaleLock(target, `${holder} ${Date.now() - LATER_MS} old-token 4000\n`);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const release = acquire(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    release?.();
    expect(existsSync(lock)).toBe(false);
  });

  test("a matching generation past the lease is protected, by timestamp, mtime and clock", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const held = `${process.pid} ${Date.now() - LATER_MS} held-token ${OWN_GEN}\n`;
    const lock = writeStaleLock(target, held);

    expect(acquire(target, 20, { procRoot })).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
    expect(later(() => acquire(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a lock this writer acquired keeps protecting itself past the lease", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const release = acquire(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    const held = readFileSync(`${target}.lock`);
    expect(later(() => acquire(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(`${target}.lock`)).toEqual(held);
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("a dead pid with a generation is still reclaimed at once, even when fresh", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    writeFileSync(`${target}.lock`, `99999999 ${Date.now()} tok 123\n`);
    const release = acquire(target, 50, { procRoot });
    expect(release).toBeTypeOf("function");
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});

describe("procfs unavailable or inconclusive never age-reclaims a kill-confirmed live holder", () => {
  const missingRoot = () => join(box(), "no-proc-here");

  test.each([
    ["generation lock", (pid: number) => `${pid} ${Date.now() - LATER_MS} tok 111\n`],
    ["legacy token lock", (pid: number) => `${pid} ${Date.now() - LATER_MS} tok\n`],
    ["legacy pid/time lock", (pid: number) => `${pid} ${Date.now() - LATER_MS}\n`],
  ])("missing procfs root: %s for this live pid stays", (_label, make) => {
    const target = join(box(), "home.json");
    const held = make(process.pid);
    const lock = writeStaleLock(target, held);
    expect(acquire(target, 20, { procRoot: missingRoot() })).toBeUndefined();
    expect(later(() => acquire(target, 20, { procRoot: missingRoot() }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("procfs root present but no entry for the holder pid: protected", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const held = `1 ${Date.now() - LATER_MS} tok 111\n`;
    const lock = writeStaleLock(target, held);
    expect(later(() => acquire(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("holder stat entry unparseable: protected", () => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    mkdirSync(join(procRoot, "1"), { recursive: true });
    writeFileSync(join(procRoot, "1", "stat"), "garbage without a comm\n");
    const held = `1 ${Date.now() - LATER_MS} tok 111\n`;
    const lock = writeStaleLock(target, held);
    expect(later(() => acquire(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("missing procfs: the writer still acquires and releases a free lock", () => {
    const target = join(box(), "home.json");
    const release = acquire(target, 20, { procRoot: missingRoot() });
    expect(release).toBeTypeOf("function");
    expect(readFileSync(`${target}.lock`, "utf8").startsWith(`${process.pid} `)).toBe(true);
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("missing procfs: a dead holder is still reclaimed", () => {
    const target = join(box(), "home.json");
    writeFileSync(`${target}.lock`, `99999999 ${Date.now()} tok 111\n`);
    const release = acquire(target, 50, { procRoot: missingRoot() });
    expect(release).toBeTypeOf("function");
    release?.();
  });
});

describe("legacy lock semantics with procfs available", () => {
  test.each([
    ["pid/time", `${process.pid} ${Date.now() - LATER_MS}\n`],
    ["pid/time/token", `${process.pid} ${Date.now() - LATER_MS} tok\n`],
  ])("a %s lock naming a live pid stays protected past the lease", (_label, held) => {
    const target = join(box(), "home.json");
    const procRoot = fakeProc();
    const lock = writeStaleLock(target, held);
    expect(later(() => acquire(target, 20, { procRoot }))).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test.each([
    ["pid/time", `99999999 ${Date.now()}\n`],
    ["pid/time/token", `99999999 ${Date.now()} tok\n`],
  ])("a %s lock naming a dead pid is reclaimed at once", (_label, held) => {
    const target = join(box(), "home.json");
    writeFileSync(`${target}.lock`, held);
    const release = acquire(target, 50, { procRoot: fakeProc() });
    expect(release).toBeTypeOf("function");
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test.each(["", "garbage\n", "0x1 nope\n", `${process.pid}x ${Date.now()} tok 1\n`])(
    "malformed lock %j is recovered only after the lease",
    (content) => {
      const target = join(box(), "home.json");
      const procRoot = fakeProc();
      const lock = `${target}.lock`;
      writeFileSync(lock, content);
      expect(acquire(target, 0, { procRoot })).toBeUndefined();
      expect(readFileSync(lock, "utf8")).toBe(content);
      const old = new Date(Date.now() - LATER_MS);
      utimesSync(lock, old, old);
      const release = acquire(target, 50, { procRoot });
      expect(release).toBeTypeOf("function");
      release?.();
      expect(existsSync(lock)).toBe(false);
    },
  );
});

/*
 * Health and history call acquireShimLock without hooks, so these use the
 * real /proc. The holder is this live process; the recorded generation is
 * this process's real start time (protected) or that plus one (reused pid).
 */
const realProc = process.platform === "linux" && existsSync(`/proc/${process.pid}/stat`);

function realGeneration(): string {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}
const reusedLock = () => `${process.pid} ${Date.now() - LATER_MS} old-token ${(BigInt(realGeneration()) + 1n).toString()}\n`;
const heldLock = () => `${process.pid} ${Date.now() - LATER_MS} held-token ${realGeneration()}\n`;
const pendingOf = (file: string) => readdirSync(dirname(file)).filter((n) => n.startsWith(`${basename(file)}.pending-`));

describe.runIf(realProc)("health and history outcomes of a generation takeover (real /proc)", () => {
  const state = (windows: AccountHealthState["windows"]): AccountHealthState => ({ accountId: "home", windows });
  const seen = (status: "allowed" | "rejected" = "allowed") => ({ status, seenAt: Date.now() });
  const ev = (accountId: string) => ({ at: new Date().toISOString(), kind: "served" as const, accountId });

  test("sanity: the reference parser and the exported parser agree on this process", () => {
    expect(String(parse(readFileSync(`/proc/${process.pid}/stat`, "utf8")))).toBe(realGeneration());
  });

  test("persistHealthState takes over a reused-pid lock and commits the snapshot directly", () => {
    const file = join(box(), "home.json");
    const lock = writeStaleLock(file, reusedLock());
    persistHealthState(file, state({ "w": seen("rejected") }));

    expect(existsSync(lock)).toBe(false);
    expect(pendingOf(file)).toEqual([]);
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
    expect(snapshot.windows["w"]?.status).toBe("rejected");
  });

  test("persistHealthState fails open on a matching-generation lock: lock and snapshot untouched, delta parked", () => {
    const file = join(box(), "home.json");
    persistHealthState(file, state({ "before": seen() }));
    const snapshotBefore = readFileSync(file, "utf8");
    const held = heldLock();
    const lock = writeStaleLock(file, held);

    persistHealthState(file, state({ "during": seen("rejected") }));
    expect(readFileSync(lock, "utf8")).toBe(held);
    expect(readFileSync(file, "utf8")).toBe(snapshotBefore);
    expect(pendingOf(file).length).toBe(1);
    expect(Object.keys(readHealthStateFile(file)?.windows ?? {}).sort()).toEqual(["before", "during"]);

    unlinkSync(lock);
    persistHealthState(file, state({}));
    expect(pendingOf(file)).toEqual([]);
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
    expect(Object.keys(snapshot.windows).sort()).toEqual(["before", "during"]);
  });

  test("recordHistory takes over a reused-pid lock and appends the event", () => {
    const stateFile = join(box(), "claw1.json");
    const file = historyFile(stateFile);
    recordHistory(stateFile, ev("claw0"));
    const lock = writeStaleLock(file, reusedLock());

    recordHistory(stateFile, ev("claw1"));
    expect(existsSync(lock)).toBe(false);
    expect(readHistory(file).map((e) => e.accountId)).toEqual(["claw0", "claw1"]);
  });

  test("recordHistory fails open on a matching-generation lock: lock and journal untouched", () => {
    const stateFile = join(box(), "claw1.json");
    const file = historyFile(stateFile);
    recordHistory(stateFile, ev("claw0"));
    const journalBefore = readFileSync(file, "utf8");
    const held = heldLock();
    const lock = writeStaleLock(file, held);

    recordHistory(stateFile, ev("claw1"));
    expect(readFileSync(lock, "utf8")).toBe(held);
    expect(readFileSync(file, "utf8")).toBe(journalBefore);

    unlinkSync(lock);
    recordHistory(stateFile, ev("claw2"));
    const after = readHistory(file).map((e) => e.accountId);
    expect(after[0]).toBe("claw0");
    expect(after.at(-1)).toBe("claw2");
    expect(existsSync(lock)).toBe(false);
  });
});
