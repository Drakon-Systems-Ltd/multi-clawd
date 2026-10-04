/**
 * Live usage polling (v1.10): ask the provider what is left instead of waiting
 * to be told it has run out.
 *
 * Everything the pool knew about an account's quota used to arrive as a side
 * effect of a launch — the `rate_limit_event` records the Claude CLI emits at
 * the top of each turn. That telemetry has two gaps the pool could not close
 * from the inside:
 *
 *   1. The 5-hour session window never carries a utilization number, only a
 *      status, so the threshold rule ("hand over at 85%") could not fire on
 *      the one window that actually runs out mid-afternoon. The v1.7.2 rule
 *      rotates on the bare `allowed_warning`, but that warning arrives late
 *      and gives no notice of how late.
 *   2. Nothing is observed between launches. An account that was fine at the
 *      last turn is assumed fine at the next, and the first turn to learn
 *      otherwise is the one that pays for it.
 *
 * The same OAuth session the CLI is already signed in with can read the
 * account's live usage (`/api/oauth/usage` — what the CLI's own `/usage`
 * command shows). Both windows come back as percentages with reset times.
 * Polling it on a timer turns the pool's health state from "what the last
 * launch happened to see" into "what the provider says right now", and the
 * existing selection rules do the rest: near-limit rotation now fires on the
 * 5-hour window with a real number behind it, and a window at 100% is
 * `exhausted` with the provider's own reset time, before a single turn is
 * refused.
 *
 * On top of selection, the poll raises an operator alert when any window
 * passes the WARN threshold (default 95%), naming the account, the window,
 * the reset time, and whether the pool has already moved. That is the
 * "something is about to run out" notice an operator cannot get from a
 * selector that acts silently, and the whole-pool version of it is the one
 * that matters: every account above the line means the next stop is the
 * degrade ladder or the host's chain.
 *
 * Boundaries, each deliberate:
 * - READ-ONLY. The poll reads the access token the CLI already stores and
 *   never refreshes, rewrites, or copies it anywhere. An expired token is a
 *   skipped tick — the next CLI launch refreshes it, as it always has.
 * - BEST-EFFORT. A failed poll changes nothing: the health file keeps what the
 *   shim wrote, selection keeps working from it, and the failure is logged
 *   once per transition, not per tick.
 * - OWN KEYS. Polled windows are written under `usage:<window>` so they never
 *   race the shim's `five_hour`/`seven_day` records for the same key: the
 *   shim's next bare `allowed` must not erase the number the poll just wrote,
 *   and the provenance of every record stays legible in the file. The window
 *   predicates in health.ts match on the key's unit segment, so `usage:five_hour`
 *   is short, period-scoped, and account-wide exactly like `five_hour`.
 */
import type { Alert } from "./alerts.js";
import { classifyAccountHealth, type HealthOptions, type HealthVerdict } from "./health.js";
import { mergeHealthStates, type AccountHealthState, type WindowHealth } from "./shim-core.js";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_WINDOW_PREFIX = "usage:";
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 2 * 60 * 1000;
export const MIN_USAGE_POLL_INTERVAL_MS = 60 * 1000;
/**
 * Ceiling on the interval. A polled `rejected` record is asserted on the
 * strength of its last observation for REJECTION_REVALIDATE_AFTER_MS (one
 * hour, health.ts); a poll slower than that would let a genuine 100% window
 * lapse into "unknown" between ticks and re-elect the exhausted account.
 */
export const MAX_USAGE_POLL_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_USAGE_WARN_THRESHOLD = 0.95;
export const USAGE_FETCH_TIMEOUT_MS = 15_000;

/** One usage window as the provider reports it: a fraction, and a reset (epoch s). */
export interface UsageWindow {
  utilization: number;
  resetsAt?: number;
}

/** A limit scoped narrower than the account — one model family, typically. */
export interface UsageScopedLimit {
  label: string;
  utilization: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  windows: Record<string, UsageWindow>;
  scoped: UsageScopedLimit[];
}

export interface UsagePollConfig {
  /** Default true. `false` turns the poll off entirely — no reads, no requests. */
  enabled?: boolean;
  /** Tick interval. Default 120000; minimum 60000. */
  intervalMs?: number;
  /** Raise an operator alert when any window reaches this fraction. Default 0.95. */
  warnThreshold?: number;
}

export function effectiveUsagePollInterval(cfg: UsagePollConfig | undefined): number {
  const requested = cfg?.intervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
  if (!Number.isFinite(requested)) return DEFAULT_USAGE_POLL_INTERVAL_MS;
  return Math.min(MAX_USAGE_POLL_INTERVAL_MS, Math.max(MIN_USAGE_POLL_INTERVAL_MS, requested));
}

export function effectiveUsageWarnThreshold(cfg: UsagePollConfig | undefined): number {
  const t = cfg?.warnThreshold;
  return typeof t === "number" && t > 0 && t <= 1 ? t : DEFAULT_USAGE_WARN_THRESHOLD;
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function parsePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value / 100;
}

const WINDOW_KEY_RE = /^(five_hour|seven_day(_[a-z0-9_]+)?)$/;

/**
 * Parse the usage endpoint's body into a snapshot. Tolerant by design — the
 * endpoint is CLI-internal: unknown keys are ignored, windows that are null
 * (not on this plan) or malformed are skipped, and a body with no usable
 * window at all is reported as unparseable rather than as "0% everywhere".
 */
export function parseUsageResponse(body: unknown): UsageSnapshot | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const windows: Record<string, UsageWindow> = {};
  for (const [key, value] of Object.entries(b)) {
    if (!WINDOW_KEY_RE.test(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const w = value as Record<string, unknown>;
    const utilization = parsePercent(w.utilization);
    if (utilization === undefined) continue;
    windows[key] = { utilization, resetsAt: parseResetsAt(w.resets_at) };
  }
  const scoped: UsageScopedLimit[] = [];
  if (Array.isArray(b.limits)) {
    for (const entry of b.limits) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const scope = e.scope as Record<string, unknown> | null | undefined;
      const model = scope?.model as Record<string, unknown> | null | undefined;
      const label = model?.display_name;
      const utilization = parsePercent(e.percent);
      if (typeof label !== "string" || !label.trim() || utilization === undefined) continue;
      scoped.push({ label: label.trim(), utilization, resetsAt: parseResetsAt(e.resets_at) });
    }
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { windows, scoped };
}

/**
 * The provider windows that measure the ACCOUNT's allowance. Only these become
 * health records: the reader treats any period window as account-wide (a
 * `rejected` on it benches the account for every model), and a per-model
 * weekly window (`seven_day_opus`, `seven_day_sonnet`) says nothing about the
 * other models. Those stay in the snapshot for alerts and `usage` output only.
 */
export const ACCOUNT_USAGE_WINDOWS: readonly string[] = ["five_hour", "seven_day"];

/**
 * The health-file records a snapshot becomes. A window at or past 100% is a
 * `rejected` record with the provider's own reset — the same shape the shim
 * writes for a refused launch, so the reader treats it identically. Below
 * that it is `allowed` with a number, which is all the threshold rule needs.
 */
export function usageHealthWindows(
  snapshot: UsageSnapshot,
  nowMs: number,
): Record<string, WindowHealth> {
  const out: Record<string, WindowHealth> = {};
  for (const [key, w] of Object.entries(snapshot.windows)) {
    if (!ACCOUNT_USAGE_WINDOWS.includes(key)) continue;
    out[`${USAGE_WINDOW_PREFIX}${key}`] = {
      status: w.utilization >= 1 ? "rejected" : "allowed",
      utilization: w.utilization,
      resetsAt: w.resetsAt,
      seenAt: nowMs,
    };
  }
  return out;
}

export type OAuthTokenRead = { token: string } | { skip: string };

/**
 * The CLI's stored OAuth access token, from the raw text of its
 * `.credentials.json`. Read-only: an expired token is reported as a skip, not
 * refreshed — token lifecycle belongs to the CLI. Never logs or returns
 * anything but the token itself on success.
 */
export function readOAuthAccessToken(raw: string | undefined, nowMs: number): OAuthTokenRead {
  if (raw === undefined) return { skip: "no .credentials.json (not signed in, or credentials held elsewhere)" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { skip: ".credentials.json is not valid JSON" };
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return { skip: ".credentials.json has no OAuth session" };
  const o = oauth as { accessToken?: unknown; expiresAt?: unknown };
  if (typeof o.accessToken !== "string" || o.accessToken.trim() === "") {
    return { skip: ".credentials.json has no access token" };
  }
  if (typeof o.expiresAt === "number" && o.expiresAt <= nowMs) {
    return { skip: "access token expired — the next CLI launch refreshes it" };
  }
  return { token: o.accessToken };
}

export type UsageFetchFailure = "auth" | "throttled" | "transient" | "parse";

export type UsageFetchResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; kind: UsageFetchFailure; reason: string };

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * One GET against the usage endpoint. Classified failures, never thrown:
 * `auth` is the account's problem (the probe and the shim already report dead
 * logins; this just stops the tick), `throttled` and `transient` are nobody's
 * problem yet, `parse` means the endpoint changed shape under us.
 */
export async function fetchUsage(
  token: string,
  fetchImpl: FetchLike,
  timeoutMs: number = USAGE_FETCH_TIMEOUT_MS,
): Promise<UsageFetchResult> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: controller?.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", reason: `usage endpoint refused the login (HTTP ${res.status})` };
    }
    if (res.status === 429) return { ok: false, kind: "throttled", reason: "usage endpoint rate-limited the poll" };
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, kind: "transient", reason: `usage endpoint returned HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: "parse", reason: "usage endpoint returned a non-JSON body" };
    }
    const snapshot = parseUsageResponse(body);
    if (!snapshot) return { ok: false, kind: "parse", reason: "usage endpoint body had no readable window" };
    return { ok: true, snapshot };
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    return { ok: false, kind: "transient", reason: `usage request failed (${name})` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Human name for a provider window, for alert text. */
export function usageWindowLabel(window: string): string {
  const bare = window.startsWith(USAGE_WINDOW_PREFIX) ? window.slice(USAGE_WINDOW_PREFIX.length) : window;
  if (bare === "five_hour") return "5-hour";
  if (bare === "seven_day") return "weekly";
  if (bare.startsWith("seven_day_")) return `weekly ${bare.slice("seven_day_".length).replace(/_/g, " ")}`;
  return bare;
}

function relative(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined) return "";
  const mins = Math.max(0, Math.round((resetsAt * 1000 - nowMs) / 60000));
  if (mins < 90) return ` (resets in ~${mins}m)`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return ` (resets in ~${hours}h)`;
  return ` (resets in ~${Math.round(hours / 24)}d)`;
}

export interface UsageAlertAccount {
  id: string;
  /** Absent when this tick could not read the account. */
  snapshot?: UsageSnapshot;
  /** The pool's current verdict for the account, when known. */
  verdict?: HealthVerdict;
}

export interface UsageAlertDecision {
  raise: Alert[];
  /** Alert keys that belong to this family and should still be live after this tick. */
  keep: Set<string>;
}

export function usageAlertPrefix(poolId: string): string {
  return `usage:${poolId}:`;
}

export function usagePoolAlertKey(poolId: string): string {
  return `usage-pool:${poolId}`;
}

/**
 * Which alerts the latest snapshots justify. One per account per window at or
 * above the warn threshold, plus one pool-wide alert when EVERY account is
 * above it somewhere (an account this tick could not read is not known to be
 * hot, so it holds the pool-wide alert back). Everything else in the family is to be
 * cleared: a window that has fallen back below the line, or reset, ends its own
 * alert on the next tick. Scoped (per-model) limits warn too — a model family
 * at 100% refuses that model on the account even while the account-wide
 * windows read fine.
 */
export function decideUsageAlerts(params: {
  poolId: string;
  accounts: UsageAlertAccount[];
  warnThreshold: number;
  nowMs: number;
}): UsageAlertDecision {
  const { poolId, accounts, warnThreshold, nowMs } = params;
  const raise: Alert[] = [];
  const keep = new Set<string>();
  const prefix = usageAlertPrefix(poolId);
  const answered = accounts.filter((a) => a.snapshot !== undefined);
  const hot = new Set<string>();
  let soonestReset: number | undefined;

  for (const account of answered) {
    const snapshot = account.snapshot!;
    const others = accounts.filter((a) => a.id !== account.id);
    const sibling = others.find((a) => a.verdict === "ok" || a.verdict === "no_data" || a.verdict === undefined);
    for (const [window, w] of Object.entries(snapshot.windows)) {
      if (w.utilization < warnThreshold) continue;
      // Only an ACCOUNT window makes the account "hot" for the pool-wide
      // alert: a per-model window at 100% refuses one model, not the account.
      if (ACCOUNT_USAGE_WINDOWS.includes(window)) {
        hot.add(account.id);
        if (w.resetsAt !== undefined && (soonestReset === undefined || w.resetsAt < soonestReset)) {
          soonestReset = w.resetsAt;
        }
      }
      const key = `${prefix}${account.id}:${window}`;
      keep.add(key);
      const pct = Math.round(w.utilization * 100);
      const where = !ACCOUNT_USAGE_WINDOWS.includes(window)
        ? w.utilization >= 1
          ? "that model is refused on this account until reset"
          : "that model will be refused on this account at 100%"
        : w.utilization >= 1
          ? "this account is exhausted on that window"
          : others.length === 0
            ? "no sibling account to hand over to"
            : sibling
              ? `new launches route to ${sibling.id}`
              : "no healthy sibling to hand over to";
      raise.push({
        key,
        severity: "error",
        text: `pool ${poolId}: account "${account.id}" ${usageWindowLabel(window)} usage at ${pct}%${relative(w.resetsAt, nowMs)} — ${where}`,
      });
    }
    for (const limit of snapshot.scoped) {
      if (limit.utilization < warnThreshold) continue;
      const key = `${prefix}${account.id}:model:${limit.label.toLowerCase().replace(/\s+/g, "-")}`;
      keep.add(key);
      const pct = Math.round(limit.utilization * 100);
      raise.push({
        key,
        severity: "error",
        text: `pool ${poolId}: account "${account.id}" ${limit.label} model limit at ${pct}%${relative(limit.resetsAt, nowMs)} — ${
          limit.utilization >= 1 ? "that model is refused on this account until reset" : "that model will be refused on this account at 100%"
        }`,
      });
    }
  }

  if (accounts.length > 0 && hot.size === accounts.length) {
    const key = usagePoolAlertKey(poolId);
    keep.add(key);
    const pct = Math.round(warnThreshold * 100);
    raise.push({
      key,
      severity: "error",
      text:
        `pool ${poolId}: EVERY account is above ${pct}% on at least one usage window — ` +
        `at 100% turns degrade down the ladder or fall through to the next provider` +
        `${soonestReset !== undefined ? `; soonest reset${relative(soonestReset, nowMs)}` : ""}`,
    });
  }

  return { raise, keep };
}

/* ── the controller: one tick, with every side effect injected ──────────── */

export interface UsagePollMember {
  id: string;
  /** The CLI's `.credentials.json` for this account's login. */
  credentialsFile: string;
}

export interface UsagePollIo {
  /** Raw file text; undefined when the file does not exist. Other errors may throw. */
  readFile: (path: string) => string | undefined;
  /** Parsed state; undefined when absent. MUST throw on a present-but-unreadable file. */
  readHealth: (accountId: string) => AccountHealthState | undefined;
  writeHealth: (accountId: string, state: AccountHealthState) => void;
  fetchImpl: FetchLike;
  raiseAlert: (alert: Alert) => void;
  clearAlert: (key: string) => void;
  alertKeysWithPrefix: (prefix: string) => string[];
  logger: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
}

export interface UsagePollAccountReport {
  id: string;
  snapshot?: UsageSnapshot;
  /** Why no request was made (credentials unreadable/expired). */
  skipped?: string;
  /** Why the request produced nothing usable. */
  failure?: { kind: UsageFetchFailure; reason: string };
  verdict: HealthVerdict;
}

export interface UsagePollReport {
  at: number;
  accounts: UsagePollAccountReport[];
  raised: string[];
  cleared: string[];
}

/**
 * Build the tick. Logging is on TRANSITIONS only — a skip or failure reason
 * is said once when it starts and once when it ends, a verdict change is said
 * when it happens — so a 2-minute cadence cannot fill a journal with a
 * steady-state fact.
 */
export function createUsagePollController(params: {
  poolId: string;
  members: UsagePollMember[];
  healthOptions: HealthOptions;
  warnThreshold: number;
  io: UsagePollIo;
}): { tick: () => Promise<UsagePollReport> } {
  const { poolId, members, healthOptions, warnThreshold, io } = params;
  const now = io.now ?? (() => Date.now());
  const lastProblem = new Map<string, string>();
  const lastVerdict = new Map<string, HealthVerdict>();

  const noteProblem = (id: string, problem: string | undefined) => {
    const previous = lastProblem.get(id);
    if (problem === previous) return;
    if (problem) io.logger.warn(`[multi-clawd] usage poll: account "${id}" — ${problem}`);
    else if (previous) io.logger.info(`[multi-clawd] usage poll: account "${id}" — reading usage again`);
    if (problem) lastProblem.set(id, problem);
    else lastProblem.delete(id);
  };

  async function tick(): Promise<UsagePollReport> {
    const at = now();
    const reports: UsagePollAccountReport[] = [];
    for (const member of members) {
      let raw: string | undefined;
      try {
        raw = io.readFile(member.credentialsFile);
      } catch (err) {
        raw = undefined;
        noteProblem(member.id, `credentials unreadable (${err instanceof Error ? err.name : String(err)})`);
        reports.push({ id: member.id, skipped: "credentials unreadable", verdict: verdictFor(member.id) });
        continue;
      }
      const token = readOAuthAccessToken(raw, at);
      if ("skip" in token) {
        noteProblem(member.id, token.skip);
        reports.push({ id: member.id, skipped: token.skip, verdict: verdictFor(member.id) });
        continue;
      }
      const result = await fetchUsage(token.token, io.fetchImpl);
      if (!result.ok) {
        noteProblem(member.id, result.reason);
        reports.push({ id: member.id, failure: { kind: result.kind, reason: result.reason }, verdict: verdictFor(member.id) });
        continue;
      }
      let disk: AccountHealthState;
      try {
        disk = io.readHealth(member.id) ?? { accountId: member.id, windows: {} };
      } catch (err) {
        // A present file that cannot be read is the shim's evidence in an
        // unknown state. Writing over it would discard that evidence (and any
        // credential record) for the sake of two numbers; skip this tick.
        noteProblem(member.id, `health file unreadable, not overwriting (${err instanceof Error ? err.message : String(err)})`);
        reports.push({ id: member.id, snapshot: result.snapshot, skipped: "health file unreadable", verdict: "no_data" });
        continue;
      }
      noteProblem(member.id, undefined);
      const live: AccountHealthState = {
        accountId: member.id,
        updatedAt: at,
        windows: usageHealthWindows(result.snapshot, at),
      };
      const merged = mergeHealthStates(disk, live, at);
      try {
        io.writeHealth(member.id, merged);
      } catch (err) {
        io.logger.warn(`[multi-clawd] usage poll: health write failed for "${member.id}": ${String(err)}`);
      }
      const verdict = classifyAccountHealth(merged, healthOptions, at).verdict;
      const previous = lastVerdict.get(member.id);
      if (previous !== undefined && previous !== verdict) {
        io.logger.info(
          `[multi-clawd] usage poll: account "${member.id}" ${previous} → ${verdict} (${describeSnapshot(result.snapshot)})`,
        );
      } else if (previous === undefined) {
        io.logger.info(`[multi-clawd] usage poll: account "${member.id}" ${describeSnapshot(result.snapshot)} → ${verdict}`);
      }
      lastVerdict.set(member.id, verdict);
      reports.push({ id: member.id, snapshot: result.snapshot, verdict });
    }

    // An account this tick could not read (skipped, failed, or whose health
    // file was left alone) is in an UNKNOWN state, not a healthy one. Its
    // alerts stay exactly as they were, and so does the pool-wide alert, until
    // a tick that actually knows says otherwise. Otherwise a 429 or an expired
    // token on an idle, exhausted account would clear its alert every other
    // tick and the operator would watch it flap.
    const known = reports.filter((r) => r.snapshot !== undefined && r.skipped === undefined);
    const unknown = reports.filter((r) => !known.includes(r));
    const decision = decideUsageAlerts({
      poolId,
      accounts: reports.map((r) => ({ id: r.id, snapshot: known.includes(r) ? r.snapshot : undefined, verdict: r.verdict })),
      warnThreshold,
      nowMs: at,
    });
    for (const r of unknown) {
      for (const key of io.alertKeysWithPrefix(`${usageAlertPrefix(poolId)}${r.id}:`)) decision.keep.add(key);
    }
    if (unknown.length > 0) {
      for (const key of io.alertKeysWithPrefix(usagePoolAlertKey(poolId))) decision.keep.add(key);
    }
    const raised: string[] = [];
    for (const alert of decision.raise) {
      io.raiseAlert(alert);
      raised.push(alert.key);
    }
    const cleared: string[] = [];
    const family = [...io.alertKeysWithPrefix(usageAlertPrefix(poolId)), ...io.alertKeysWithPrefix(usagePoolAlertKey(poolId))];
    for (const key of family) {
      if (decision.keep.has(key)) continue;
      io.clearAlert(key);
      cleared.push(key);
    }
    return { at, accounts: reports, raised, cleared };
  }

  function verdictFor(id: string): HealthVerdict {
    return classifyAccountHealth(io.readHealth(id), healthOptions, now()).verdict;
  }

  return { tick };
}

/** "5-hour 10% · weekly 46%" */
export function describeSnapshot(snapshot: UsageSnapshot): string {
  const parts = Object.entries(snapshot.windows).map(
    ([k, w]) => `${usageWindowLabel(k)} ${Math.round(w.utilization * 100)}%`,
  );
  for (const s of snapshot.scoped) parts.push(`${s.label} ${Math.round(s.utilization * 100)}%`);
  return parts.join(" · ");
}
