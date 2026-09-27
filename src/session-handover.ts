/**
 * Resume handover across pooled accounts.
 *
 * Claude Code keeps each conversation at
 * `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<sessionId>.jsonl`, so a session is
 * only resumable by the account whose config dir holds it. OpenClaw stores ONE
 * CLI session binding per backend id, and the pool is one backend id fronting
 * several accounts. When the pool launches `--resume <id>` on an account other
 * than the one that wrote the session, the CLI answers "No conversation found
 * with session ID", the gateway classifies that as `session_expired`, and the
 * turn cascades to the next rung of the chain. Nothing re-keys the binding —
 * the pool backend never succeeds on that session again — so the same failure
 * repeats on every turn until the conversation is reset (observed 22–27 Sep
 * 2026: a claw2-written session bound to `clawd` while the pool had returned
 * home to claw1; ~10 s and one account hop lost per turn, 60–90 times a day).
 *
 * Account selection cannot follow the session: `prepareExecution` is not told
 * which session a launch resumes. The shim is — it sees the argv — so the shim
 * makes the chosen account able to resume: before spawning, it finds the
 * newest copy of the transcript across every pool member's config dir and, if
 * that copy is not already the launched account's, copies it in. The pool's
 * health-driven choice stands; the session follows the account, not the
 * reverse. Conversations are linear (the backend serializes turns), so the
 * newest file is the whole conversation; the copy it replaces is a stale
 * prefix of it.
 *
 * Best-effort by contract: any failure here leaves the launch exactly as it
 * was before this module existed (the CLI reports the missing session and the
 * gateway recovers as it always has).
 */
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Env var carrying every pool member's Claude config dir (JSON string array). Paths only — never credentials. */
export const SESSION_DIRS_ENV = "MULTI_CLAWD_SESSION_DIRS";

/**
 * Claude session ids are UUIDs. Anything else is refused outright: the id is
 * joined into a filesystem path, and `../` from argv must never reach it.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The session a launch resumes, from argv (`--resume <id>` or `--resume=<id>`). */
export function resumeSessionId(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === "--resume" || arg === "-r") value = argv[i + 1];
    else if (arg.startsWith("--resume=")) value = arg.slice("--resume=".length);
    if (value !== undefined) return SESSION_ID_RE.test(value) ? value : undefined;
  }
  return undefined;
}

/** The config dir the child actually uses: CLAUDE_CONFIG_DIR, or the CLI's default. */
export function effectiveConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? dir : join(homedir(), ".claude");
}

export function parseSessionDirs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  } catch {
    return [];
  }
}

/** The filesystem surface the planner reads — injectable so tests need no real config dirs. */
export interface HandoverFs {
  /** Subdirectory names of `dir`; [] when it does not exist. */
  listDirs(dir: string): string[];
  /** mtime of a regular file, or undefined when absent. */
  mtimeMs(path: string): number | undefined;
}

export const nodeHandoverFs: HandoverFs = {
  listDirs(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  mtimeMs(path) {
    try {
      const st = statSync(path);
      return st.isFile() ? st.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  },
};

export type HandoverPlan =
  | { action: "none"; reason: "already-local" | "not-found" }
  | { action: "copy"; from: string; to: string; fromDir: string };

/**
 * Where is the freshest copy of `sessionId`, and does the launched account
 * need it? Scans `projects/*` of the target dir and of every pool member's
 * dir, rather than re-deriving Claude Code's cwd-slug rule: the slug is the
 * CLI's private detail, and the source's own subdirectory name is by
 * definition the one the CLI uses for this workspace.
 */
export function planSessionHandover(params: {
  sessionId: string;
  targetDir: string;
  memberDirs: readonly string[];
  fs?: HandoverFs;
}): HandoverPlan {
  const fs = params.fs ?? nodeHandoverFs;
  const file = `${params.sessionId}.jsonl`;
  const dirs = [params.targetDir, ...params.memberDirs.filter((d) => d !== params.targetDir)];
  let newest: { dir: string; sub: string; path: string; mtime: number } | undefined;
  for (const dir of dirs) {
    const projects = join(dir, "projects");
    for (const sub of fs.listDirs(projects)) {
      const path = join(projects, sub, file);
      const mtime = fs.mtimeMs(path);
      if (mtime === undefined) continue;
      // Ties go to the earlier dir — the target first — so equal copies never churn.
      if (!newest || mtime > newest.mtime) newest = { dir, sub, path, mtime };
    }
  }
  if (!newest) return { action: "none", reason: "not-found" };
  if (newest.dir === params.targetDir) return { action: "none", reason: "already-local" };
  return {
    action: "copy",
    from: newest.path,
    to: join(params.targetDir, "projects", newest.sub, file),
    fromDir: newest.dir,
  };
}

/**
 * Copy via a temp file + rename, so the CLI never opens a half-written
 * transcript. Only the `.jsonl` moves: the sibling `<id>/` directory holds
 * subagent and tool-result sidecars, which the transcript references by
 * absolute path and which stay readable where they are.
 */
export function applySessionHandover(plan: Extract<HandoverPlan, { action: "copy" }>): void {
  const tmp = join(dirname(plan.to), `.${basename(plan.to)}.handover-${process.pid}`);
  mkdirSync(dirname(plan.to), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(plan.from, tmp);
    renameSync(tmp, plan.to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The shim's single entry point: plan and apply the handover for this launch.
 * Returns a line for stderr (undefined when there is nothing worth saying).
 * Never throws — a failed handover must leave the launch as it was.
 */
export function handoverForLaunch(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: { fs?: HandoverFs; apply?: typeof applySessionHandover } = {},
): string | undefined {
  const sessionId = resumeSessionId(argv);
  if (!sessionId) return undefined;
  const memberDirs = parseSessionDirs(env[SESSION_DIRS_ENV]);
  // No roster of member dirs = not a pool launch (or an older plugin build):
  // there is nowhere else the session could be.
  if (memberDirs.length === 0) return undefined;
  const targetDir = effectiveConfigDir(env);
  try {
    const plan = planSessionHandover({ sessionId, targetDir, memberDirs, fs: deps.fs });
    if (plan.action === "none") {
      return plan.reason === "not-found"
        ? `resume handover: session ${sessionId.slice(0, 8)} is in no pool account's config dir — leaving the launch as-is`
        : undefined;
    }
    (deps.apply ?? applySessionHandover)(plan);
    return `resume handover: session ${sessionId.slice(0, 8)} copied from ${plan.fromDir} into ${targetDir} (newer copy)`;
  } catch (err) {
    return `resume handover failed for session ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
