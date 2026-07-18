/**
 * Tier-aware degradation (v0.3.5): when the WHOLE pool is
 * exhausted for the requested model, step down to a configured same-provider
 * model on the least-bad account instead of hard-failing to the next
 * provider. Makes the pool useful even on single-account hosts (a pool of
 * one native account + a ladder replaces a bespoke "switch to Opus at 95%"
 * watcher).
 *
 * Decision here; transport via MULTI_CLAWD_MODEL_OVERRIDE in the child env;
 * enforcement in the shim's argv rewrite — the OpenClaw runner appends
 * `--model <requested>` after any resolveExecutionArgs output (last-wins),
 * so the rewrite must happen in the process we own.
 *
 * Rules:
 * - Degrade ONLY when no pool account is usable (all exhausted) — while any
 *   account can still serve the requested tier, rotation wins.
 * - Never degrade a request that is already at or below the ladder.
 * - Pinned lanes (agent/workspace matchers) are exempt — contractual "always
 *   this model" lanes fail over to the chain rather than silently degrade.
 */
import type { HealthVerdict } from "./health.js";

export interface DegradePin {
  agentDirIncludes?: string;
  workspaceDirIncludes?: string;
}

export interface DegradeDecision {
  model: string;
  reason: string;
}

export function decideDegradation(params: {
  verdicts: Array<{ id: string; verdict: HealthVerdict }>;
  requestedModel: string;
  ladder: readonly string[];
}): DegradeDecision | undefined {
  const { verdicts, requestedModel, ladder } = params;
  if (ladder.length === 0) return undefined;
  if (ladder.includes(requestedModel)) return undefined;
  const allExhausted =
    verdicts.length > 0 && verdicts.every((v) => v.verdict === "exhausted");
  if (!allExhausted) return undefined;
  return {
    model: ladder[0],
    reason: `pool exhausted for ${requestedModel}`,
  };
}

/** Whether a launch matches any never-degrade pin. Empty matchers never match. */
export function matchesPin(
  pins: readonly DegradePin[],
  launch: { agentDir: string; workspaceDir: string },
): boolean {
  return pins.some((pin) => {
    const checks: boolean[] = [];
    if (pin.agentDirIncludes) checks.push(launch.agentDir.includes(pin.agentDirIncludes));
    if (pin.workspaceDirIncludes)
      checks.push(launch.workspaceDir.includes(pin.workspaceDirIncludes));
    return checks.length > 0 && checks.every(Boolean);
  });
}

/**
 * Replace the value after every `--model` flag. Used by the shim on its own
 * argv; replacing all occurrences keeps last-wins CLIs consistent.
 */
export function rewriteModelArg(argv: readonly string[], model: string): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i += 1) {
    if (out[i] === "--model") out[i + 1] = model;
  }
  return out;
}
