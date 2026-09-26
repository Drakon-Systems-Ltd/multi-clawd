/**
 * What `explain`, `doctor` and `multi-clawd direct` report about the direct
 * Anthropic route (v1.9). One gatherer so the three surfaces cannot disagree.
 *
 * Observed facts (stored profiles, stored order, cooldowns, probe results)
 * come from OpenClaw's CLI through the injected runner; intent comes from the
 * plugin config. Secret references are described by provider name only.
 */
import { classifyAccountHealth, type HealthOptions, type HealthVerdict } from "./health.js";
import type { AccountHealthState } from "./shim-core.js";
import {
  DIRECT_PROVIDER,
  collectDirectMembers,
  type DirectAccountShape,
  type DirectMember,
} from "./direct-route.js";
import {
  parseUnusableProfiles,
  planAgentOrder,
  readDirectRouteSnapshot,
  safeCliError,
  type OpenclawRunner,
  type UnusableProfile,
} from "./direct-sync.js";
import type { ExplainDirect } from "./explain-core.js";
import type { StickyEntry } from "./sticky.js";

/** Plain-English credential source for one member — never the value or ref id. */
export function describeDirectSource(member: DirectMember): string {
  const s = member.source;
  switch (s.kind) {
    case "ref":
      return `setup-token via ${s.ref.provider || "a secret provider"} secret reference${
        s.reused ? " (the same one its CLI login uses)" : ""
      }`;
    case "file":
      return `setup-token file ${s.path}${s.reused ? " (the same one its CLI login uses)" : ""}`;
    case "existing":
      return "adopted profile you stored yourself";
    default:
      return "no direct credential";
  }
}

export interface DirectStatus {
  agentId: string;
  explain: ExplainDirect;
  verdicts: Array<{ accountId: string; profileId: string; verdict: HealthVerdict }>;
  /** The order the gateway loop would write now; undefined = already in force. */
  pendingOrder?: string[];
  unusable: UnusableProfile[];
  errors: string[];
}

/**
 * Gather the direct route's state for one agent. Undefined when no account
 * mentions `direct` — callers print nothing new in that case.
 */
export async function gatherDirectStatus(params: {
  accounts: readonly DirectAccountShape[];
  poolAccounts?: readonly string[];
  agentId: string;
  runner: OpenclawRunner;
  readHealth: (accountId: string) => AccountHealthState | undefined;
  healthOptions: HealthOptions;
  configOrder?: readonly string[];
  sticky?: StickyEntry;
  minDwellMs?: number;
  nowMs: number;
  /** Skip `models status --json` (a few seconds) when cooldowns are not needed. */
  skipCooldowns?: boolean;
}): Promise<DirectStatus | undefined> {
  const { members, problems } = collectDirectMembers(params.accounts, params.poolAccounts ?? []);
  if (members.length === 0 && problems.length === 0) return undefined;
  const errors: string[] = [];
  const verdicts = members.map((m) => ({
    accountId: m.accountId,
    profileId: m.profileId,
    verdict: classifyAccountHealth(params.readHealth(m.accountId), params.healthOptions, params.nowMs).verdict,
  }));

  const read = members.length > 0 ? await readDirectRouteSnapshot(params.runner, params.agentId) : {};
  if ("error" in read && read.error) errors.push(read.error);
  const snapshot = "snapshot" in read ? read.snapshot : undefined;

  let unusable: UnusableProfile[] = [];
  if (members.length > 0 && !params.skipCooldowns) {
    const status = await params.runner(["models", "status", "--agent", params.agentId, "--json"], { timeoutMs: 120_000 });
    const parsed = status.code === 0 ? parseUnusableProfiles(status.stdout) : undefined;
    if (parsed) unusable = parsed;
    else errors.push(`models status ${safeCliError(status)}`);
  }

  let pendingOrder: string[] | undefined;
  if (snapshot) {
    pendingOrder = planAgentOrder({
      members: verdicts,
      snapshot,
      configOrder: params.configOrder,
      sticky: params.sticky,
      nowMs: params.nowMs,
      minDwellMs: params.minDwellMs,
    }).order;
  }

  const byProfile = new Map(unusable.map((u) => [u.profileId, u]));
  const order = snapshot?.storedOrder ?? (params.configOrder?.length ? [...params.configOrder] : snapshot ? [] : undefined);
  const orderSource = snapshot?.storedOrder
    ? `stored for agent ${params.agentId}`
    : params.configOrder?.length
      ? "config auth.order"
      : undefined;
  return {
    agentId: params.agentId,
    verdicts,
    pendingOrder,
    unusable,
    errors,
    explain: {
      members: members.map((m) => {
        const u = byProfile.get(m.profileId);
        return {
          accountId: m.accountId,
          profileId: m.profileId,
          source: describeDirectSource(m),
          stored: snapshot ? snapshot.stored.has(m.profileId) : undefined,
          ...(m.source.kind === "existing" ? { adopted: true } : {}),
          ...(u ? { cooldownUntil: u.until, cooldownReason: u.reason ?? u.kind } : {}),
        };
      }),
      problems: problems.map((p) => ({ accountId: p.accountId, reason: p.reason })),
      order,
      orderSource,
    },
  };
}

export interface ProbeOutcome {
  profileId: string;
  status: string;
  error?: string;
}

/** `openclaw models status --probe --json` → per-profile anthropic probe results. */
export function parseProbeResults(stdout: string): ProbeOutcome[] | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  let doc: { auth?: { probes?: { results?: unknown } } };
  try {
    doc = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  const rows = doc?.auth?.probes?.results;
  if (!Array.isArray(rows)) return undefined;
  return (rows as Array<Record<string, unknown>>)
    .filter((r) => typeof r?.profileId === "string" && (r.provider === undefined || r.provider === DIRECT_PROVIDER))
    .map((r) => ({
      profileId: r.profileId as string,
      status: typeof r.status === "string" ? r.status : "unknown",
      ...(typeof r.error === "string" ? { error: r.error.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 200) } : {}),
    }));
}

/** Arguments for a live probe of exactly these profiles (one tiny call each). */
export function probeArgs(agentId: string, profileIds: readonly string[]): string[] {
  return [
    "models",
    "status",
    "--agent",
    agentId,
    "--json",
    "--probe",
    "--probe-provider",
    DIRECT_PROVIDER,
    "--probe-profile",
    profileIds.join(","),
    "--probe-max-tokens",
    "16",
  ];
}
