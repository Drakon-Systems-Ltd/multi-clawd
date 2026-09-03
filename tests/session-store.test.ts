import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import { auditSessionOverrides } from "../src/chain-audit";
import {
  JSON_STORE_RELPATH,
  SQLITE_STORE_RELPATH,
  locateSessionStore,
  readJsonSessionStore,
  readSessionStore,
  readSqliteSessionStore,
} from "../src/session-store";

// The 2026.8.x schema, trimmed to the columns the reader touches plus the
// constraints that matter (session_key is the primary key; entry_json is the
// old sessions.json entry, verbatim).
const SESSION_NODES_DDL = `CREATE TABLE session_nodes (
  session_key TEXT NOT NULL PRIMARY KEY,
  current_session_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  entry_valid INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-session-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeDb(path: string, rows: Array<[string, string]>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SESSION_NODES_DDL);
  const ins = db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const [key, json] of rows) ins.run(key, "sid", json, 1);
  db.close();
}

describe("locateSessionStore", () => {
  test("prefers the 2026.8.x SQLite database when both stores exist", () => {
    const agent = scratch();
    writeDb(join(agent, SQLITE_STORE_RELPATH), []);
    mkdirSync(join(agent, "sessions"));
    writeFileSync(join(agent, JSON_STORE_RELPATH), "{}");
    expect(locateSessionStore(agent)).toEqual({ kind: "sqlite", path: join(agent, SQLITE_STORE_RELPATH) });
  });

  test("falls back to sessions.json on a ≤2026.7.x layout", () => {
    const agent = scratch();
    mkdirSync(join(agent, "sessions"));
    writeFileSync(join(agent, JSON_STORE_RELPATH), "{}");
    expect(locateSessionStore(agent)).toEqual({ kind: "json", path: join(agent, JSON_STORE_RELPATH) });
  });

  test("a sessions/ dir holding transcripts but neither store is MISSING, not skipped — the audit must say so", () => {
    // Exactly the post-import shape: transcripts left in sessions/, map gone,
    // database elsewhere or absent. Silence here is how a pin goes unaudited.
    const agent = scratch();
    mkdirSync(join(agent, "sessions"));
    writeFileSync(join(agent, "sessions", "3bb75180-57fb-46ae-b2db-4030f1d27891.jsonl"), "");
    expect(locateSessionStore(agent)?.kind).toBe("missing");
  });

  test("an empty sessions/ dir, or one holding only a dated .bak, is not a store to audit", () => {
    // ACP shells (claude-code, codex) keep a sessions/ dir with nothing in it
    // or a months-old sessions.json.bak-<date>; warning there is a nag nobody
    // can clear without deleting a backup.
    const empty = scratch();
    mkdirSync(join(empty, "sessions"));
    expect(locateSessionStore(empty)).toBeNull();
    const bakOnly = scratch();
    mkdirSync(join(bakOnly, "sessions"));
    writeFileSync(join(bakOnly, "sessions", "sessions.json.bak-20260427-acp-prune"), "{}");
    expect(locateSessionStore(bakOnly)).toBeNull();
  });

  test("a directory that never held sessions is not a store at all", () => {
    const agent = scratch();
    mkdirSync(join(agent, "agent"));
    expect(locateSessionStore(agent)).toBeNull();
  });
});

describe("readSqliteSessionStore", () => {
  test("returns the entry objects keyed by session key — the audit's input shape", async () => {
    const agent = scratch();
    const dbPath = join(agent, SQLITE_STORE_RELPATH);
    writeDb(dbPath, [
      [
        "agent:main:main",
        JSON.stringify({ providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" }),
      ],
      ["agent:main:cron:x", JSON.stringify({ label: "Cron: nightly", updatedAt: 1 })],
    ]);
    const read = await readSqliteSessionStore(dbPath);
    expect(read.error).toBeUndefined();
    expect(read.skippedRows).toBe(0);
    expect(Object.keys(read.entries ?? {})).toEqual(["agent:main:main", "agent:main:cron:x"]);
    expect(read.entries?.["agent:main:main"]?.modelOverrideSource).toBe("user");
  });

  test("feeds auditSessionOverrides exactly like the JSON map did", async () => {
    // Regression guard for the reason this module exists: an off-pool user
    // pin that lived in the database went unreported while the reader looked
    // for sessions.json.
    const agent = scratch();
    const dbPath = join(agent, SQLITE_STORE_RELPATH);
    writeDb(dbPath, [
      [
        "agent:main:telegram:group:1",
        JSON.stringify({ providerOverride: "anthropic", modelOverride: "claude-opus-4-8", modelOverrideSource: "user" }),
      ],
    ]);
    const read = await readSqliteSessionStore(dbPath);
    const findings = auditSessionOverrides(read.entries, true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ref).toBe("anthropic/claude-opus-4-8");
  });

  test("one unparseable row is counted and skipped, never fatal for the rest", async () => {
    const agent = scratch();
    const dbPath = join(agent, SQLITE_STORE_RELPATH);
    writeDb(dbPath, [
      ["agent:main:bad", "{not json"],
      ["agent:main:array", "[1,2]"],
      ["agent:main:good", JSON.stringify({ modelOverrideSource: "auto" })],
    ]);
    const read = await readSqliteSessionStore(dbPath);
    expect(read.error).toBeUndefined();
    expect(read.skippedRows).toBe(2);
    expect(Object.keys(read.entries ?? {})).toEqual(["agent:main:good"]);
  });

  test("a database without session_nodes is an error, not an empty pass", async () => {
    const agent = scratch();
    const dbPath = join(agent, SQLITE_STORE_RELPATH);
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    const read = await readSqliteSessionStore(dbPath);
    expect(read.entries).toBeUndefined();
    expect(read.error).toMatch(/session_nodes/);
  });

  test("opens read-only: the gateway owns the file and we must never take a write lock", async () => {
    const agent = scratch();
    const dbPath = join(agent, SQLITE_STORE_RELPATH);
    writeDb(dbPath, []);
    const seen: Array<{ path: string; readOnly: boolean | undefined }> = [];
    const opener = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      seen.push({ path, readOnly: true });
      return db;
    };
    // Also prove the default opener itself is read-only by attempting a write through it.
    const read = await readSqliteSessionStore(dbPath, opener);
    expect(read.error).toBeUndefined();
    expect(seen).toEqual([{ path: dbPath, readOnly: true }]);
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    expect(() => ro.exec("INSERT INTO session_nodes VALUES ('k','s','{}',0,1)")).toThrow(/readonly/i);
    ro.close();
  });

  test("a runtime without node:sqlite reports that loudly instead of passing", async () => {
    const read = await readSqliteSessionStore("/nonexistent.sqlite", () => {
      throw new Error("Cannot find module 'node:sqlite'");
    });
    expect(read.entries).toBeUndefined();
    expect(read.error).toMatch(/node:sqlite/);
  });
});

describe("readJsonSessionStore / readSessionStore", () => {
  test("JSON map reads as before", () => {
    const agent = scratch();
    mkdirSync(join(agent, "sessions"));
    const p = join(agent, JSON_STORE_RELPATH);
    writeFileSync(p, JSON.stringify({ "agent:main:x": { modelOverrideSource: "user", providerOverride: "claw2" } }));
    const read = readJsonSessionStore(p);
    expect(read.entries?.["agent:main:x"]?.providerOverride).toBe("claw2");
  });

  test("a JSON array or scalar is an error", () => {
    const agent = scratch();
    const p = join(agent, "sessions.json");
    writeFileSync(p, "[]");
    expect(readJsonSessionStore(p).error).toMatch(/not a JSON object/);
  });

  test("readSessionStore dispatches on location kind and never returns silently for MISSING", async () => {
    const agent = scratch();
    mkdirSync(join(agent, "sessions"));
    writeFileSync(join(agent, "sessions", "orphan-transcript.jsonl"), "");
    const location = locateSessionStore(agent);
    expect(location?.kind).toBe("missing");
    const read = await readSessionStore(location!);
    expect(read.entries).toBeUndefined();
    expect(read.error).toMatch(/no session store/);
  });
});
