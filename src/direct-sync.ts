/**
 * The direct Anthropic route's IO half (v1.9): talking to OpenClaw's auth
 * store through its own CLI, and nothing else.
 *
 * Every read and write here is an `openclaw` subcommand run through an
 * injected runner, for three reasons:
 * - They are the supported mechanisms. `paste-token`, `secrets apply` and
 *   `models auth order set` validate their input, take the store lock, and
 *   publish the change to a running gateway themselves (`models.authRefresh`).
 *   The on-disk store is never touched directly.
 * - The in-process SDK writers only refresh the gateway's runtime snapshot if
 *   this plugin's `openclaw/plugin-sdk` import shares a module instance with
 *   the gateway's store — not something to depend on unmeasured.
 * - An injected runner makes every path testable against a scripted CLI.
 *
 * No SDK import: the global `multi-clawd` CLI loads this module from `dist/`,
 * and the `openclaw` peer is not resolvable from every global install.
 *
 * Secrets: a setup-token only ever travels on a child's stdin. It is never an
 * argument, never logged, and never part of a returned message. Stderr from
 * the CLI is reduced to one line with anything token-shaped masked before it
 * reaches a log.
 */
import { classifyAccountHealth, type HealthOptions, type HealthVerdict } from "./health.js";
import type { AccountHealthState } from "./shim-core.js";
import type { StickyEntry } from "./sticky.js";
import { DIRECT_PROVIDER, planDirectOrder, type DirectMember } from "./direct-route.js";
import { parseClaudeSetupToken } from "./hermes-core.js";
import type { SecretRefShape } from "./token-resolution.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type OpenclawRunner = (
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
) => Promise<RunResult>;

/** One line of CLI stderr, safe to log: token-shaped runs masked, length capped. */
export function safeCliError(result: Pick<RunResult, "code" | "stderr" | "stdout">): string {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /error|fail|refus|not found|missing|invalid|denied/i.test(l)) ??
    text.split("\n").map((l) => l.trim()).find(Boolean) ??
    "";
  const masked = line.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").replace(/[A-Za-z0-9_-]{40,}/g, "…");
  return `exit ${result.code}${masked ? `: ${masked.slice(0, 200)}` : ""}`;
}

function parseJson(stdout: string): unknown {
  // The CLI can print banner/log lines before the JSON document.
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/** `openclaw models auth list --provider anthropic --json` → profile ids + types. */
export function parseAuthList(stdout: string): Array<{ id: string; type?: string }> | undefined {
  const doc = parseJson(stdout) as { profiles?: unknown } | undefined;
  if (!doc || !Array.isArray(doc.profiles)) return undefined;
  return doc.profiles
    .filter((p): p is { id: string; type?: unknown; provider?: unknown } =>
      typeof (p as { id?: unknown })?.id === "string",
    )
    .filter((p) => p.provider === undefined || p.provider === DIRECT_PROVIDER)
    .map((p) => ({ id: p.id, type: typeof p.type === "string" ? p.type : undefined }));
}

/** `openclaw models auth order get --provider anthropic --json` → stored order (null = none). */
export function parseOrderGet(stdout: string): { order: string[] | null } | undefined {
  const doc = parseJson(stdout) as { order?: unknown } | undefined;
  if (!doc || !("order" in doc)) return undefined;
  if (doc.order === null || doc.order === undefined) return { order: null };
  if (!Array.isArray(doc.order)) return undefined;
  return { order: doc.order.filter((v): v is string => typeof v === "string") };
}

export interface UnusableProfile {
  profileId: string;
  kind: string;
  reason?: string;
  until: number;
}

/** `openclaw models status --json` → anthropic profiles in cooldown or disabled. */
export function parseUnusableProfiles(stdout: string): UnusableProfile[] | undefined {
  const doc = parseJson(stdout) as { auth?: { unusableProfiles?: unknown } } | undefined;
  const rows = doc?.auth?.unusableProfiles;
  if (!Array.isArray(rows)) return undefined;
  const out: UnusableProfile[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.profileId !== "string" || typeof row.until !== "number") continue;
    if (row.provider !== undefined && row.provider !== DIRECT_PROVIDER) continue;
    out.push({
      profileId: row.profileId,
      kind: typeof row.kind === "string" ? row.kind : "cooldown",
      reason: typeof row.reason === "string" ? row.reason : undefined,
      until: row.until,
    });
  }
  return out;
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertAgentId(agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) throw new Error(`invalid agent id "${agentId}"`);
  return agentId;
}

export function authListArgs(agentId: string): string[] {
  return ["models", "auth", "list", "--agent", assertAgentId(agentId), "--provider", DIRECT_PROVIDER, "--json"];
}

export function orderGetArgs(agentId: string): string[] {
  return ["models", "auth", "order", "get", "--agent", assertAgentId(agentId), "--provider", DIRECT_PROVIDER, "--json"];
}

export function orderSetArgs(agentId: string, order: readonly string[]): string[] {
  if (order.length === 0) throw new Error("refusing to set an empty order");
  for (const id of order) {
    if (!id.startsWith(`${DIRECT_PROVIDER}:`)) throw new Error(`"${id}" is not an ${DIRECT_PROVIDER} profile id`);
  }
  return ["models", "auth", "order", "set", "--agent", assertAgentId(agentId), "--provider", DIRECT_PROVIDER, ...order];
}

export function pasteTokenArgs(agentId: string, profileId: string): string[] {
  return [
    "models",
    "auth",
    "paste-token",
    "--agent",
    assertAgentId(agentId),
    "--provider",
    DIRECT_PROVIDER,
    "--profile-id",
    profileId,
  ];
}

/**
 * A `secrets apply` plan that stores `profileId` as a token profile whose
 * credential is a SecretRef — OpenClaw resolves it at runtime, so the secret
 * is never copied out of the secret manager.
 *
 * Both scrub passes are OFF on purpose. `scrubAuthProfilesForProviderTargets`
 * clears plaintext from every auth profile of a provider the plan touches —
 * here, the operator's own hand-made `anthropic` profiles. `scrubEnv` edits
 * `.env` files. Neither is ours to do.
 */
export function buildTokenRefPlan(params: {
  agentId: string;
  profileId: string;
  ref: SecretRefShape;
}): Record<string, unknown> {
  const { profileId } = params;
  // Plan paths are dot paths; a dot inside the id would split it.
  if (profileId.includes(".")) {
    throw new Error(
      `profile id "${profileId}" contains "." and cannot be targeted by a secrets plan — choose a direct.profileId without dots`,
    );
  }
  return {
    version: 1,
    protocolVersion: 1,
    scrubEnv: false,
    scrubAuthProfilesForProviderTargets: false,
    targets: [
      {
        type: "auth-profiles.token.token",
        path: `profiles.${profileId}.token`,
        pathSegments: ["profiles", profileId, "token"],
        agentId: assertAgentId(params.agentId),
        authProfileProvider: DIRECT_PROVIDER,
        ref: { source: params.ref.source, provider: params.ref.provider, id: params.ref.id },
      },
    ],
  };
}

export type SyncAction =
  | "present"
  | "adopted"
  | "adopt-missing"
  | "stored"
  | "would-store"
  | "failed";

export interface SyncResult {
  accountId: string;
  profileId: string;
  action: SyncAction;
  detail?: string;
}

/**
 * Store each member's direct credential as an OpenClaw `anthropic` profile,
 * when it is not already there (or always, with `resync`).
 *
 * - `existing`: adopted, never written; reported missing if it is not stored.
 * - `file`: the setup-token is read, shape-checked, and piped to
 *   `paste-token` on stdin.
 * - `ref`: stored as a `tokenRef` through `secrets apply` — dry-run first.
 */
export async function syncDirectProfiles(params: {
  members: readonly DirectMember[];
  agentId: string;
  runner: OpenclawRunner;
  readTokenFile: (path: string) => string;
  writePlanFile: (plan: Record<string, unknown>) => { path: string; cleanup: () => void };
  resync?: boolean;
  dryRun?: boolean;
}): Promise<{ results: SyncResult[]; listError?: string }> {
  const { runner, agentId } = params;
  const list = await runner(authListArgs(agentId), { timeoutMs: 60_000 });
  const listed = list.code === 0 ? parseAuthList(list.stdout) : undefined;
  if (!listed) return { results: [], listError: safeCliError(list) };
  const stored = new Set(listed.map((p) => p.id));
  const results: SyncResult[] = [];

  for (const member of params.members) {
    const base = { accountId: member.accountId, profileId: member.profileId };
    const { source } = member;
    if (source.kind === "existing") {
      results.push({ ...base, action: stored.has(member.profileId) ? "adopted" : "adopt-missing" });
      continue;
    }
    if (source.kind !== "file" && source.kind !== "ref") continue;
    if (stored.has(member.profileId) && !params.resync) {
      results.push({ ...base, action: "present" });
      continue;
    }
    if (source.kind === "file") {
      let token: string;
      try {
        token = parseClaudeSetupToken(params.readTokenFile(source.path));
      } catch (err) {
        // parseClaudeSetupToken's messages never echo the contents.
        results.push({ ...base, action: "failed", detail: `token file: ${(err as Error).message}` });
        continue;
      }
      if (params.dryRun) {
        results.push({ ...base, action: "would-store", detail: "paste-token from the token file" });
        continue;
      }
      const r = await runner(pasteTokenArgs(agentId, member.profileId), { input: token, timeoutMs: 120_000 });
      results.push(
        r.code === 0
          ? { ...base, action: "stored", detail: "paste-token" }
          : { ...base, action: "failed", detail: `paste-token ${safeCliError(r)}` },
      );
      continue;
    }
    // source.kind === "ref"
    let plan: Record<string, unknown>;
    try {
      plan = buildTokenRefPlan({ agentId, profileId: member.profileId, ref: source.ref });
    } catch (err) {
      results.push({ ...base, action: "failed", detail: (err as Error).message });
      continue;
    }
    const execFlag = source.ref.source === "exec" ? ["--allow-exec"] : [];
    const file = params.writePlanFile(plan);
    try {
      const check = await runner(["secrets", "apply", "--from", file.path, "--dry-run", ...execFlag], {
        timeoutMs: 120_000,
      });
      if (check.code !== 0) {
        results.push({ ...base, action: "failed", detail: `secrets apply --dry-run ${safeCliError(check)}` });
        continue;
      }
      if (params.dryRun) {
        results.push({ ...base, action: "would-store", detail: "secrets apply (tokenRef, validated)" });
        continue;
      }
      const apply = await runner(["secrets", "apply", "--from", file.path, ...execFlag], { timeoutMs: 120_000 });
      results.push(
        apply.code === 0
          ? { ...base, action: "stored", detail: "secrets apply (tokenRef — no copy of the secret)" }
          : { ...base, action: "failed", detail: `secrets apply ${safeCliError(apply)}` },
      );
    } finally {
      file.cleanup();
    }
  }
  return { results };
}

export interface DirectRouteSnapshot {
  stored: Set<string>;
  /** Stored per-agent order; null = none stored (config order or round-robin applies). */
  storedOrder: string[] | null;
}

/** Read what OpenClaw holds for one agent's anthropic route. */
export async function readDirectRouteSnapshot(
  runner: OpenclawRunner,
  agentId: string,
): Promise<{ snapshot?: DirectRouteSnapshot; error?: string }> {
  const list = await runner(authListArgs(agentId), { timeoutMs: 60_000 });
  const listed = list.code === 0 ? parseAuthList(list.stdout) : undefined;
  if (!listed) return { error: `auth list ${safeCliError(list)}` };
  const order = await runner(orderGetArgs(agentId), { timeoutMs: 60_000 });
  const parsed = order.code === 0 ? parseOrderGet(order.stdout) : undefined;
  if (!parsed) return { error: `order get ${safeCliError(order)}` };
  return { snapshot: { stored: new Set(listed.map((p) => p.id)), storedOrder: parsed.order } };
}

function sameOrder(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The order to write for one agent given what OpenClaw holds, or undefined
 * when nothing needs writing.
 *
 * The base the plan preserves unmanaged ids from is the EFFECTIVE explicit
 * order (stored, else config). With neither, OpenClaw was trying every stored
 * profile round-robin, so every stored anthropic profile is kept — the plugin
 * never takes a profile out of rotation that OpenClaw would have tried.
 */
export function planAgentOrder(params: {
  members: Array<{ accountId: string; profileId: string; verdict: HealthVerdict }>;
  snapshot: DirectRouteSnapshot;
  configOrder?: readonly string[];
  sticky?: StickyEntry;
  nowMs: number;
  minDwellMs?: number;
}): { order?: string[]; missing: string[]; firstAccount?: string } {
  const { snapshot } = params;
  const present = params.members.filter((m) => snapshot.stored.has(m.profileId));
  const missing = params.members.filter((m) => !snapshot.stored.has(m.profileId)).map((m) => m.profileId);
  if (present.length === 0) return { missing };
  const explicit = snapshot.storedOrder ?? (params.configOrder?.length ? [...params.configOrder] : null);
  const base = (explicit ?? [...snapshot.stored]).filter((id) => snapshot.stored.has(id));
  const plan = planDirectOrder({
    members: present,
    currentOrder: base,
    sticky: params.sticky,
    nowMs: params.nowMs,
    minDwellMs: params.minDwellMs,
  });
  if (!plan) return { missing };
  // Already in force: stored and equal, or no stored order but the config
  // order says exactly this. Round-robin (no explicit order) is never "equal".
  const inForce = snapshot.storedOrder !== null ? sameOrder(snapshot.storedOrder, plan.order) : sameOrder(explicit, plan.order);
  return { order: inForce ? undefined : plan.order, missing, firstAccount: plan.firstAccount };
}

export interface DirectOrderControllerDeps {
  members: readonly DirectMember[];
  agents: readonly string[];
  runner: OpenclawRunner;
  readHealth: (accountId: string) => AccountHealthState | undefined;
  healthOptions: HealthOptions;
  minDwellMs?: number;
  configOrder: () => readonly string[] | undefined;
  readSticky: () => StickyEntry | undefined;
  writeSticky: (entry: StickyEntry | undefined) => void;
  logger: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
  /** Re-read and re-assert an unchanged plan after this long. Default 1h. */
  reassertMs?: number;
  /** After a failed read/write, wait this long before retrying the same plan. Default 10m. */
  backoffMs?: number;
}

export interface TickReport {
  managedOrder: string[];
  agents: Array<{ agentId: string; outcome: "skipped" | "unchanged" | "written" | "failed"; order?: string[]; detail?: string }>;
}

/**
 * The gateway-side loop that keeps each agent's `anthropic` order in
 * pool-health order. State (what was applied, what failed) is per controller;
 * the caller keeps one controller at module scope so it survives register().
 */
export function createDirectOrderController(deps: DirectOrderControllerDeps): {
  tick: () => Promise<TickReport>;
} {
  const reassertMs = deps.reassertMs ?? 60 * 60 * 1000;
  const backoffMs = deps.backoffMs ?? 10 * 60 * 1000;
  const applied = new Map<string, { key: string; at: number }>();
  const failed = new Map<string, { key: string; at: number }>();
  const warnedMissing = new Set<string>();
  let running = false;

  return {
    async tick(): Promise<TickReport> {
      const nowMs = (deps.now ?? Date.now)();
      if (running) return { managedOrder: [], agents: [] };
      running = true;
      try {
        const verdicts = deps.members.map((m) => ({
          accountId: m.accountId,
          profileId: m.profileId,
          verdict: classifyAccountHealth(deps.readHealth(m.accountId), deps.healthOptions, nowMs).verdict,
        }));
        const sticky = deps.readSticky();
        const managed = planDirectOrder({ members: verdicts, sticky, nowMs, minDwellMs: deps.minDwellMs });
        if (!managed) return { managedOrder: [], agents: [] };
        if (JSON.stringify(managed.sticky) !== JSON.stringify(sticky)) deps.writeSticky(managed.sticky);
        const key = managed.order.join(" ");
        const report: TickReport = { managedOrder: managed.order, agents: [] };

        for (const agentId of deps.agents) {
          const done = applied.get(agentId);
          if (done && done.key === key && nowMs - done.at < reassertMs) {
            report.agents.push({ agentId, outcome: "skipped" });
            continue;
          }
          const fail = failed.get(agentId);
          if (fail && fail.key === key && nowMs - fail.at < backoffMs) {
            report.agents.push({ agentId, outcome: "skipped", detail: "backing off after a failure" });
            continue;
          }
          const read = await readDirectRouteSnapshot(deps.runner, agentId);
          if (!read.snapshot) {
            if (!fail || fail.key !== key) {
              deps.logger.warn(`[multi-clawd] direct route: cannot read agent ${agentId}'s anthropic profiles (${read.error})`);
            }
            failed.set(agentId, { key, at: nowMs });
            report.agents.push({ agentId, outcome: "failed", detail: read.error });
            continue;
          }
          const plan = planAgentOrder({
            members: verdicts,
            snapshot: read.snapshot,
            configOrder: deps.configOrder(),
            sticky,
            nowMs,
            minDwellMs: deps.minDwellMs,
          });
          for (const id of plan.missing) {
            const k = `${agentId}:${id}`;
            if (warnedMissing.has(k)) continue;
            warnedMissing.add(k);
            deps.logger.warn(
              `[multi-clawd] direct route: profile ${id} is not stored for agent ${agentId} — run \`multi-clawd direct sync\``,
            );
          }
          if (!plan.order) {
            applied.set(agentId, { key, at: nowMs });
            failed.delete(agentId);
            report.agents.push({ agentId, outcome: "unchanged" });
            continue;
          }
          const write = await deps.runner(orderSetArgs(agentId, plan.order), { timeoutMs: 60_000 });
          if (write.code === 0) {
            applied.set(agentId, { key, at: nowMs });
            failed.delete(agentId);
            deps.logger.info(
              `[multi-clawd] direct route: agent ${agentId} anthropic order → ${plan.order.join(" → ")}`,
            );
            report.agents.push({ agentId, outcome: "written", order: plan.order });
          } else {
            const detail = `order set ${safeCliError(write)}`;
            if (!fail || fail.key !== key) {
              deps.logger.warn(`[multi-clawd] direct route: agent ${agentId}: ${detail}`);
            }
            failed.set(agentId, { key, at: nowMs });
            report.agents.push({ agentId, outcome: "failed", detail });
          }
        }
        return report;
      } finally {
        running = false;
      }
    },
  };
}
