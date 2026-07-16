/**
 * Operator alerts (v0.3): a tiny in-memory store surfaced through the
 * heartbeat_prompt_contribution hook, so alerts reach the operator through
 * the agent's normal heartbeat channel (e.g. Telegram) instead of dying as
 * journal lines. Deduped by key; errors persist until cleared or expired,
 * informational events carry a short TTL.
 */

export interface Alert {
  key: string;
  severity: "error" | "info";
  text: string;
  /** How long the alert stays visible. Errors default to 6h, info to 30min. */
  ttlMs?: number;
}

interface StoredAlert extends Alert {
  at: number;
}

export interface AlertState {
  alerts: StoredAlert[];
}

const DEFAULT_TTL_MS: Record<Alert["severity"], number> = {
  error: 6 * 60 * 60 * 1000,
  info: 30 * 60 * 1000,
};

export function addAlert(state: AlertState, alert: Alert, nowMs: number): AlertState {
  return {
    alerts: [
      ...state.alerts.filter((a) => a.key !== alert.key),
      { ...alert, at: nowMs },
    ],
  };
}

export function clearAlert(state: AlertState, key: string): AlertState {
  return { alerts: state.alerts.filter((a) => a.key !== key) };
}

function isLive(alert: StoredAlert, nowMs: number): boolean {
  const ttl = alert.ttlMs ?? DEFAULT_TTL_MS[alert.severity];
  return nowMs - alert.at <= ttl;
}

/** Render pending alerts for heartbeat injection; undefined when quiet. */
export function pendingAlertText(state: AlertState, nowMs: number): string | undefined {
  const live = state.alerts.filter((a) => isLive(a, nowMs));
  if (live.length === 0) return undefined;
  const ordered = [...live].sort((a, b) =>
    a.severity === b.severity ? a.at - b.at : a.severity === "error" ? -1 : 1,
  );
  return ordered
    .map((a) => `[multi-clawd] ${a.severity.toUpperCase()}: ${a.text}`)
    .join("\n");
}
