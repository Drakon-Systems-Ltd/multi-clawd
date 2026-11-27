import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_SESSION_PARKED, readSessionPin, recordSessionPin } from "../src/session-affinity.js";

let dir: string;
let file: string;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-affinity-unsettled-"));
  file = join(dir, "state", "pool-clawd.sessions.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { stderr.mockRestore(); rmSync(dir, { recursive: true, force: true }); });

const TTL = 100_000;
const K = MAX_SESSION_PARKED;
const sessionKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 32);
const pendingOf = (id: string) => readdirSync(join(dir, "state")).filter((n) => n.includes(".pending-") && n.includes(`-${sessionKey(id)}-`));
const readerFiles = () => readdirSync(join(dir, "state")).filter((n) => n.includes(".reader-"));
const holdStoreLock = () => writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()} issue-189-live-holder\n`);
const parkDirect = (id: string, account: string, servedAt: number) => {
  const f = (v: number, w: number) => String(v).padStart(w, "0");
  writeFileSync(join(dir, "state", `pool-clawd.sessions.json.pending-${f(servedAt, 13)}-${sessionKey(id)}-${f(servedAt, 13)}-0000004242-000000000-0123456789ab`),
    JSON.stringify({ [id]: { account, servedAt } }));
};
const notes = () => stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[multi-clawd shim]") && l.includes("unsettled"));

function run(schedule: number[], seedCount: number, stored?: { account: string; servedAt: number }) {
  holdStoreLock();
  if (stored) writeFileSync(file, JSON.stringify({ a: stored }));
  for (let i = 0; i < seedCount; i++) parkDirect("a", `seed${1000 + i}`, 1000 + i);
  let next = 5000, listing = 0;
  const pin = readSessionPin(file, "a", 9000, TTL, {
    afterParkedList: () => {
      const n = schedule[listing++] ?? 0;
      for (let i = 0; i < n; i++, next++) recordSessionPin(file, "a", `account${next}`, next, TTL);
    },
  });
  return { pin, listing, next };
}

/** Every note the shim wrote about an unsettled read must name no session, account, key or path. */
const expectNoIdentity = (line: string, outcome: "no pin seen" | "using the latest pin seen") => {
  expect(line).toBe(`[multi-clawd shim] session pin read unsettled after 4 listings: ${outcome}\n`);
  for (const secret of [dir, sessionKey("a"), "account", "seed", "pool-clawd"]) expect(line).not.toContain(secret);
};

// #189: a read crossing MAX_SESSION_PARKED same-session parks may end unsettled
// (the accepted #181 residual). It still returns the latest pin it saw, keeps
// storage bounded, never waits, and now says so on the shim's stderr channel.
describe("a bounded read that ends unsettled is reported (#189)", () => {
  test("1,32,31,31 parks across four listings: bounded storage, latest-seen pin, one note, marker gone", () => {
    const { pin, listing, next } = run([1, 32, 31, 31], 1);
    expect(listing).toBe(4);
    // Latest-seen: every file each pass listed was gone on opening, so no pin was seen.
    expect(pin).toBeUndefined();
    // Nothing is lost: once the race is over a read finds the newest pin.
    expect(readSessionPin(file, "a", 9000, TTL)).toEqual({ account: `account${next - 1}`, servedAt: next - 1 });
    expect(pendingOf("a").length).toBeLessThanOrEqual(K);
    expect(readerFiles()).toEqual([]);
    expect(notes()).toHaveLength(1);
    expectNoIdentity(notes()[0], "no pin seen");
  }, 180_000);

  test("a read that starts above the bound ends the same way: bounded, one anonymous note", () => {
    const { pin, listing, next } = run([1, 32, 31, 31], K + 5);
    expect(listing).toBe(4);
    expect(pin).toBeUndefined();
    expect(readSessionPin(file, "a", 9000, TTL)).toEqual({ account: `account${next - 1}`, servedAt: next - 1 });
    expect(pendingOf("a").length).toBeLessThanOrEqual(K);
    expect(readerFiles()).toEqual([]);
    expect(notes()).toHaveLength(1);
    expectNoIdentity(notes()[0], "no pin seen");
  }, 180_000);

  test("an unsettled read reports that it returned an observed pin", () => {
    const stored = { account: "stored", servedAt: 999 };
    const { pin, listing } = run([1, 32, 31, 31], 1, stored);
    expect(listing).toBe(4);
    expect(pin).toEqual(stored);
    expect(readerFiles()).toEqual([]);
    expect(notes()).toHaveLength(1);
    expectNoIdentity(notes()[0], "using the latest pin seen");
  }, 180_000);

  test("a read that settles says nothing", () => {
    parkDirect("a", "account1000", 1000);
    const pin = readSessionPin(file, "a", 9000, TTL);
    expect(pin).toEqual({ account: "account1000", servedAt: 1000 });
    expect(notes()).toEqual([]);
  });
});
