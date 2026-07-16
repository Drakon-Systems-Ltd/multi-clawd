import { describe, expect, test } from "vitest";
import { addAlert, pendingAlertText, type AlertState } from "../src/alerts";

const NOW = 1_784_300_000_000;

describe("alert store", () => {
  test("adds an alert and surfaces it as heartbeat text", () => {
    let state: AlertState = { alerts: [] };
    state = addAlert(state, { key: "login:claw2", severity: "error", text: "claw2 login is dead" }, NOW);
    const text = pendingAlertText(state, NOW);
    expect(text).toContain("claw2 login is dead");
    expect(text).toContain("[multi-clawd]");
  });

  test("dedupes by key, keeping the newest text", () => {
    let state: AlertState = { alerts: [] };
    state = addAlert(state, { key: "login:claw2", severity: "error", text: "old" }, NOW - 1000);
    state = addAlert(state, { key: "login:claw2", severity: "error", text: "new" }, NOW);
    expect(state.alerts).toHaveLength(1);
    expect(pendingAlertText(state, NOW)).toContain("new");
    expect(pendingAlertText(state, NOW)).not.toContain("old");
  });

  test("alerts expire after their TTL", () => {
    let state: AlertState = { alerts: [] };
    state = addAlert(
      state,
      { key: "rotation:clawd", severity: "info", text: "rotated", ttlMs: 60_000 },
      NOW,
    );
    expect(pendingAlertText(state, NOW + 30_000)).toContain("rotated");
    expect(pendingAlertText(state, NOW + 61_000)).toBeUndefined();
  });

  test("clearAlert by key removes it", async () => {
    const { clearAlert } = await import("../src/alerts");
    let state: AlertState = { alerts: [] };
    state = addAlert(state, { key: "login:claw2", severity: "error", text: "dead" }, NOW);
    state = clearAlert(state, "login:claw2");
    expect(pendingAlertText(state, NOW)).toBeUndefined();
  });

  test("multiple alerts render on separate lines, errors first", () => {
    let state: AlertState = { alerts: [] };
    state = addAlert(state, { key: "a", severity: "info", text: "info thing" }, NOW);
    state = addAlert(state, { key: "b", severity: "error", text: "error thing" }, NOW);
    const text = pendingAlertText(state, NOW)!;
    const lines = text.split("\n");
    expect(lines.findIndex((l) => l.includes("error thing"))).toBeLessThan(
      lines.findIndex((l) => l.includes("info thing")),
    );
  });
});
