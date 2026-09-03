/**
 * Where OpenClaw keeps each agent's session entries — the store the session
 * pin audit (`auditSessionOverrides`) reads.
 *
 * Up to OpenClaw 2026.7.x every agent had a flat JSON map at
 * `agents/<agent>/sessions/sessions.json`. 2026.8.x imports that map into a
 * per-agent SQLite database at `agents/<agent>/agent/openclaw-agent.sqlite`
 * (table `session_nodes`, one row per session key, the old entry object kept
 * verbatim as `entry_json`) and leaves a `sessions/` directory behind with only
 * transcripts in it. A reader that still looks for the JSON file therefore
 * finds an agent-with-sessions and no store — and reports every agent as
 * "unreadable" while real off-pool pins sit unaudited in the database.
 *
 * This module owns the WHERE and the HOW-TO-READ so doctor and `explain` can
 * never drift on it again: locate the store (SQLite preferred, JSON fallback),
 * then read it into the same `Record<sessionKey, entry>` shape the audit has
 * always taken.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { SessionOverrideEntry } from "./chain-audit.js";

/** Relative to the agent dir: the 2026.8.x per-agent database. */
export const SQLITE_STORE_RELPATH = join("agent", "openclaw-agent.sqlite");
/** Relative to the agent dir: the ≤2026.7.x flat JSON map. */
export const JSON_STORE_RELPATH = join("sessions", "sessions.json");

export type SessionStoreLocation =
  | { kind: "sqlite"; path: string }
  | { kind: "json"; path: string }
  /** The agent has a `sessions/` dir but neither store — a store is expected and missing. */
  | { kind: "missing"; path: string };

export interface SessionStoreRead {
  /** Session entries keyed by session key — the audit's input. Absent on failure. */
  entries?: Record<string, SessionOverrideEntry>;
  /** Why `entries` is absent. Callers must surface this loudly, never treat it as a pass. */
  error?: string;
  /** SQLite rows whose `entry_json` did not parse — counted, not fatal, so one bad row can't hide the rest. */
  skippedRows: number;
}

/**
 * Decide which store an agent directory carries. Returns null when the
 * directory is not an agent-with-sessions at all (no `sessions/` dir and no
 * database), so callers can skip it silently — that is the one legitimate
 * silent case; every other outcome is something the audit must report.
 */
export function locateSessionStore(
  agentDir: string,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = readdirSync,
): SessionStoreLocation | null {
  const sqlitePath = join(agentDir, SQLITE_STORE_RELPATH);
  if (exists(sqlitePath)) return { kind: "sqlite", path: sqlitePath };
  const jsonPath = join(agentDir, JSON_STORE_RELPATH);
  if (exists(jsonPath)) return { kind: "json", path: jsonPath };
  const sessionsDir = join(agentDir, "sessions");
  if (exists(sessionsDir) && holdsSessionArtifacts(sessionsDir, list)) return { kind: "missing", path: jsonPath };
  return null;
}

/**
 * A `sessions/` directory proves the agent has sessions to audit only when it
 * holds session artefacts — transcripts (`*.jsonl`), maps (`*.json`) or
 * per-session subdirectories. ACP shells and retired agents keep an empty
 * `sessions/` dir, or one with nothing but a dated `.bak`, and warning on those
 * would be a nag nobody can clear except by deleting a backup.
 */
function holdsSessionArtifacts(sessionsDir: string, list: (dir: string) => string[]): boolean {
  let names: string[];
  try {
    names = list(sessionsDir);
  } catch {
    return false;
  }
  return names.some((n) => n.endsWith(".json") || n.endsWith(".jsonl") || !n.includes("."));
}

/** Minimal surface of `node:sqlite`'s DatabaseSync we depend on — injectable for tests and for hosts without the module. */
export interface SessionDbOpener {
  (path: string): {
    prepare(sql: string): { all(): unknown[] };
    close(): void;
  };
}

/**
 * `node:sqlite` shipped unflagged in Node 22.13; older runtimes throw on
 * import. Resolve it lazily so a host without it degrades to a loud error at
 * read time instead of breaking every other doctor section at module load.
 */
async function defaultOpener(): Promise<SessionDbOpener> {
  const { DatabaseSync } = await importSqliteQuietly();
  return (path) => new DatabaseSync(path, { readOnly: true });
}

/**
 * Node prints "ExperimentalWarning: SQLite is an experimental feature" the
 * first time the module loads. In doctor output that line reads like a
 * finding, so drop that one warning for the duration of the import and
 * nothing else — every other warning still reaches the default printer.
 */
async function importSqliteQuietly(): Promise<typeof import("node:sqlite")> {
  const original = process.emitWarning;
  const quiet: typeof process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = quiet;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Read `session_nodes` out of a 2026.8.x per-agent database. Opens read-only —
 * the gateway owns that file and this must never take a write lock on it.
 */
export async function readSqliteSessionStore(
  path: string,
  open?: SessionDbOpener,
): Promise<SessionStoreRead> {
  let opener: SessionDbOpener;
  try {
    opener = open ?? (await defaultOpener());
  } catch (err) {
    return {
      error: `node:sqlite unavailable on this runtime (${describe(err)}) — Node ≥ 22.13 required to audit a SQLite session store`,
      skippedRows: 0,
    };
  }
  let db: ReturnType<SessionDbOpener> | undefined;
  try {
    db = opener(path);
    const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
    const entries: Record<string, SessionOverrideEntry> = {};
    let skippedRows = 0;
    for (const row of rows) {
      const parsed = parseRow(row);
      if (parsed === undefined) {
        skippedRows++;
        continue;
      }
      entries[parsed.key] = parsed.entry;
    }
    return { entries, skippedRows };
  } catch (err) {
    return { error: describe(err), skippedRows: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** Read the ≤2026.7.x flat JSON map. */
export function readJsonSessionStore(path: string): SessionStoreRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "store is not a JSON object", skippedRows: 0 };
    }
    return { entries: parsed as Record<string, SessionOverrideEntry>, skippedRows: 0 };
  } catch (err) {
    return { error: describe(err), skippedRows: 0 };
  }
}

/** Locate + read in one call — the shape doctor and `explain` both want. */
export async function readSessionStore(
  location: SessionStoreLocation,
  open?: SessionDbOpener,
): Promise<SessionStoreRead> {
  switch (location.kind) {
    case "sqlite":
      return readSqliteSessionStore(location.path, open);
    case "json":
      return readJsonSessionStore(location.path);
    case "missing":
      return { error: "no session store found (neither SQLite database nor sessions.json)", skippedRows: 0 };
  }
}

function parseRow(row: unknown): { key: string; entry: SessionOverrideEntry } | undefined {
  if (!row || typeof row !== "object") return undefined;
  const { session_key: key, entry_json: json } = row as { session_key?: unknown; entry_json?: unknown };
  if (typeof key !== "string" || typeof json !== "string") return undefined;
  try {
    const entry: unknown = JSON.parse(json);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return { key, entry: entry as SessionOverrideEntry };
  } catch {
    return undefined;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
