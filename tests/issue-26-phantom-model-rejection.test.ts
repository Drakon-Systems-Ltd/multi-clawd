/**
 * #26 — a model limit on the home account made every turn fail over.
 *
 * The first reading was "selection ignores model-scoped limits". It does not:
 * the home account classified `exhausted` for the model, correctly. The turn
 * still launched there because the SIBLING also classified `exhausted`, on a
 * rejection four days old whose quoted reset was still in the future — while
 * that same sibling was serving the model successfully through its own
 * backend. With the whole pool "exhausted" the launch falls back to home.
 *
 * Three rules are pinned here, each with the state shape that produced the
 * incident:
 *   1. A successful turn is evidence. It ends a recorded model rejection for
 *      the account that served it (shim, see the integration tests below).
 *   2. When every account is exhausted the launch must still happen — so it is
 *      spent on the account whose rejection is oldest and overdue a re-probe,
 *      not unconditionally on home.
 *   3. The provider's limit is per model FAMILY when its refusal names the
 *      family ("Fable limit"), so a rejection recorded on one version gates
 *      the family's other versions.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAccountHealth,
  fallbackPoolAccount,
  REJECTION_REVALIDATE_AFTER_MS,
} from "../src/health";
import { decideStickySelection } from "../src/sticky";
import {
  clearModelRejection,
  limitFamilyFor,
  modelFamily,
  modelWindowKey,
  parseStoredState,
  recordModelLimit,
  type AccountHealthState,
} from "../src/shim-core";
import { chooseRetryAccount } from "../src/retry-plan";
import { cleanShimEnv } from "./shim-env";

const NOW = 1_790_630_000_000;
const NOW_S = Math.floor(NOW / 1000);
const HOUR = 60 * 60 * 1000;

/** Home: limited for the model minutes ago, reset ~23h out. */
function homeState(): AccountHealthState {
  return {
    accountId: "claw1",
    updatedAt: NOW - 6 * 60 * 1000,
    windows: {
      seven_day: {
        status: "allowed_warning",
        utilization: 0.8,
        resetsAt: NOW_S + 23 * 3600,
        seenAt: NOW - 8 * 60 * 1000,
        model: "claude-opus-5-5",
      },
      [modelWindowKey("claude-fable-5-1")]: {
        status: "rejected",
        resetsAt: NOW_S + 23 * 3600,
        seenAt: NOW - 6 * 60 * 1000,
      },
    },
  };
}

/** Sibling: a 99-hour-old rejection whose quoted reset is still ahead. */
function siblingState(): AccountHealthState {
  return {
    accountId: "claw2",
    updatedAt: NOW - 1000,
    windows: {
      five_hour: {
        status: "allowed",
        resetsAt: NOW_S + 4 * 3600,
        seenAt: NOW - 1000,
        model: "claude-fable-5-1",
      },
      [modelWindowKey("claude-fable-5-1")]: {
        status: "rejected",
        resetsAt: NOW_S + 4 * 3600,
        seenAt: NOW - 99 * HOUR,
      },
    },
  };
}

function verdictsFor(model: string, states: AccountHealthState[]) {
  return states.map((state) => {
    const health = classifyAccountHealth(state, {}, NOW, model);
    return { id: state.accountId, verdict: health.verdict, observedAt: health.observedAt };
  });
}

describe("#26 the incident shape", () => {
  test("home is correctly exhausted for the model — selection never ignored the limit", () => {
    const h = classifyAccountHealth(homeState(), {}, NOW, "claude-fable-5-1");
    expect(h.verdict).toBe("exhausted");
    expect(h.observedAt).toBe(NOW - 6 * 60 * 1000);
  });

  test("an exhausted verdict reports when its evidence was observed", () => {
    const h = classifyAccountHealth(siblingState(), {}, NOW, "claude-fable-5-1");
    expect(h.verdict).toBe("exhausted");
    expect(h.observedAt).toBe(NOW - 99 * HOUR);
  });

  test("whole pool exhausted: the launch goes to the account overdue a re-probe, not to home", () => {
    const verdicts = verdictsFor("claude-fable-5-1", [homeState(), siblingState()]);
    expect(verdicts.map((v) => v.verdict)).toEqual(["exhausted", "exhausted"]);
    expect(fallbackPoolAccount(verdicts, NOW)).toBe("claw2");
    const d = decideStickySelection({ verdicts, nowMs: NOW });
    expect(d.account).toBe("claw2");
    // A probe is not a rotation: nothing to dwell on if it fails.
    expect(d.sticky).toBeUndefined();
  });

  test("delete the fix: without evidence ages the fallback is home, as before", () => {
    const verdicts = verdictsFor("claude-fable-5-1", [homeState(), siblingState()]).map(
      ({ id, verdict }) => ({ id, verdict }),
    );
    expect(fallbackPoolAccount(verdicts, NOW)).toBe("claw1");
  });
});

describe("#26 re-probe is bounded", () => {
  test("both rejections recent: stay on home — no ping-pong between two real limits", () => {
    const sibling = siblingState();
    sibling.windows[modelWindowKey("claude-fable-5-1")].seenAt = NOW - 20 * 60 * 1000;
    const verdicts = verdictsFor("claude-fable-5-1", [homeState(), sibling]);
    expect(fallbackPoolAccount(verdicts, NOW)).toBe("claw1");
  });

  test("the threshold is the same one account-level rejections re-validate on", () => {
    const sibling = siblingState();
    sibling.windows[modelWindowKey("claude-fable-5-1")].seenAt =
      NOW - REJECTION_REVALIDATE_AFTER_MS - 1;
    expect(
      fallbackPoolAccount(verdictsFor("claude-fable-5-1", [homeState(), sibling]), NOW),
    ).toBe("claw2");
    sibling.windows[modelWindowKey("claude-fable-5-1")].seenAt =
      NOW - REJECTION_REVALIDATE_AFTER_MS + 1000;
    expect(
      fallbackPoolAccount(verdictsFor("claude-fable-5-1", [homeState(), sibling]), NOW),
    ).toBe("claw1");
  });

  test("several overdue: the oldest evidence is probed first", () => {
    const verdicts = [
      { id: "claw1", verdict: "exhausted" as const, observedAt: NOW - 3 * HOUR },
      { id: "claw2", verdict: "exhausted" as const, observedAt: NOW - 50 * HOUR },
      { id: "claw3", verdict: "exhausted" as const, observedAt: NOW - 5 * HOUR },
    ];
    expect(fallbackPoolAccount(verdicts, NOW)).toBe("claw2");
  });

  test("a dead login is never the probe target, however old its evidence", () => {
    const verdicts = [
      { id: "claw1", verdict: "exhausted" as const, observedAt: NOW - 10 * 60 * 1000 },
      { id: "claw2", verdict: "credential_failed" as const, observedAt: NOW - 90 * HOUR },
    ];
    expect(fallbackPoolAccount(verdicts, NOW)).toBe("claw1");
  });

  test("a healthy account still wins outright — the probe rule only applies with nothing usable", () => {
    const sibling = siblingState();
    delete sibling.windows[modelWindowKey("claude-fable-5-1")];
    const d = decideStickySelection({
      verdicts: verdictsFor("claude-fable-5-1", [homeState(), sibling]),
      nowMs: NOW,
    });
    expect(d.account).toBe("claw2");
    expect(d.sticky).toEqual({ account: "claw2", since: NOW });
  });
});

describe("#26 a successful turn ends the rejection it contradicts", () => {
  test("clearing writes an allowed record rather than deleting the key", () => {
    // Persistence is read-merge-write with newest-seenAt-wins per key: a
    // deleted key would lose the merge to the rejection still on disk.
    const cleared = clearModelRejection(siblingState(), "claude-fable-5-1", NOW);
    expect(cleared.changed).toBe(true);
    const w = cleared.state.windows[modelWindowKey("claude-fable-5-1")];
    expect(w.status).toBe("allowed");
    expect(w.seenAt).toBe(NOW);
    expect(classifyAccountHealth(cleared.state, {}, NOW, "claude-fable-5-1").verdict).toBe("ok");
  });

  test("nothing recorded, nothing written", () => {
    const state = siblingState();
    delete state.windows[modelWindowKey("claude-fable-5-1")];
    expect(clearModelRejection(state, "claude-fable-5-1", NOW).changed).toBe(false);
  });

  test("another model's rejection is left alone", () => {
    const state = siblingState();
    const cleared = clearModelRejection(state, "claude-opus-5-5", NOW);
    expect(cleared.changed).toBe(false);
    expect(cleared.state.windows[modelWindowKey("claude-fable-5-1")].status).toBe("rejected");
  });

  test("the in-turn retry uses the sibling again once its rejection is cleared", () => {
    const roster = [{ id: "claw2", stateFile: "claw2.json", env: {} }];
    const recent = siblingState();
    recent.windows[modelWindowKey("claude-fable-5-1")].seenAt = NOW - 20 * 60 * 1000;
    const pick = (state: AccountHealthState) =>
      chooseRetryAccount({
        roster,
        readState: () => state,
        modelId: "claude-fable-5-1",
        nowMs: NOW,
      })?.id;
    // A rejection seen minutes ago is believed: no retry onto it.
    expect(pick(recent)).toBeUndefined();
    expect(pick(clearModelRejection(recent, "claude-fable-5-1", NOW).state)).toBe("claw2");
  });

  test("the in-turn retry re-tests a sibling whose rejection is overdue, rather than lose the turn", () => {
    // The incident, one turn earlier: home is refused mid-launch and the only
    // sibling carries the four-day-old record. Passing the refusal through
    // costs the user's turn on evidence nobody has checked since.
    const roster = [{ id: "claw2", stateFile: "claw2.json", env: {} }];
    expect(
      chooseRetryAccount({
        roster,
        readState: () => siblingState(),
        modelId: "claude-fable-5-1",
        nowMs: NOW,
      })?.id,
    ).toBe("claw2");
  });

  test("a healthy sibling is still preferred over an overdue one", () => {
    const roster = [
      { id: "claw2", stateFile: "claw2.json", env: {} },
      { id: "claw3", stateFile: "claw3.json", env: {} },
    ];
    const healthy: AccountHealthState = { accountId: "claw3", windows: {} };
    expect(
      chooseRetryAccount({
        roster,
        readState: (f) => (f === "claw2.json" ? siblingState() : healthy),
        modelId: "claude-fable-5-1",
        nowMs: NOW,
      })?.id,
    ).toBe("claw3");
  });
});

describe("#26 the limit is per family when the refusal names the family", () => {
  test("modelFamily reads the family out of a Claude model id", () => {
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("clawd/claude-fable-5")).toBe("fable");
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("gpt-6-astra")).toBeUndefined();
  });

  test("a version-less display name is a family limit; a versioned one is not", () => {
    expect(limitFamilyFor("Fable", "claude-fable-5-1")).toBe("fable");
    expect(limitFamilyFor("fable", "claude-fable-5-1")).toBe("fable");
    expect(limitFamilyFor("Fable 5", "claude-fable-5")).toBeUndefined();
    expect(limitFamilyFor("Fable 5.1", "claude-fable-5-1")).toBeUndefined();
    // The name must agree with the model actually launched — a refusal about
    // some other family says nothing we can key.
    expect(limitFamilyFor("Opus", "claude-fable-5-1")).toBeUndefined();
    expect(limitFamilyFor("weekly", "claude-fable-5-1")).toBeUndefined();
  });

  test("a family rejection recorded on one version gates the family's other versions", () => {
    const state = recordModelLimit(
      { accountId: "claw1", windows: {} },
      "claude-fable-5-1",
      NOW - 60_000,
      NOW_S + 23 * 3600,
      "fable",
    );
    expect(classifyAccountHealth(state, {}, NOW, "claude-fable-5-1").verdict).toBe("exhausted");
    expect(classifyAccountHealth(state, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    expect(classifyAccountHealth(state, {}, NOW, "clawd/claude-fable-5").verdict).toBe("exhausted");
    // Other families and model-less requests are untouched.
    expect(classifyAccountHealth(state, {}, NOW, "claude-opus-5-5").verdict).toBe("ok");
    expect(classifyAccountHealth(state, {}, NOW).verdict).toBe("ok");
  });

  test("a model-scoped rejection (no family) still gates that one version only", () => {
    const state = recordModelLimit(
      { accountId: "claw1", windows: {} },
      "claude-fable-5-1",
      NOW - 60_000,
      NOW_S + 23 * 3600,
    );
    expect(classifyAccountHealth(state, {}, NOW, "claude-fable-5").verdict).toBe("ok");
  });

  test("the family survives a round trip through the state file", () => {
    const state = recordModelLimit(
      { accountId: "claw1", windows: {} },
      "claude-fable-5-1",
      NOW,
      undefined,
      "fable",
    );
    const parsed = parseStoredState(JSON.stringify(state));
    expect(parsed?.windows[modelWindowKey("claude-fable-5-1")].family).toBe("fable");
  });

  test("success on one version clears a family rejection recorded on another", () => {
    const state = recordModelLimit(
      { accountId: "claw2", windows: {} },
      "claude-fable-5",
      NOW - 99 * HOUR,
      NOW_S + 4 * 3600,
      "fable",
    );
    const cleared = clearModelRejection(state, "claude-fable-5-1", NOW);
    expect(cleared.changed).toBe(true);
    expect(classifyAccountHealth(cleared.state, {}, NOW, "claude-fable-5").verdict).toBe("ok");
    expect(classifyAccountHealth(cleared.state, {}, NOW, "claude-fable-5-1").verdict).toBe("ok");
  });
});

// ── the shim, end to end ────────────────────────────────────────────────────
const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");

function runShim(opts: {
  stateFile: string;
  model: string;
  emitLimit?: boolean;
  limitText?: string;
  exit?: string;
}) {
  const env: NodeJS.ProcessEnv = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: opts.stateFile,
    MULTI_CLAWD_ACCOUNT_ID: "claw2",
    FAKE_CLAUDE_EXIT: opts.exit ?? "0",
  };
  if (opts.emitLimit) env.FAKE_CLAUDE_EMIT_LIMIT = "1";
  if (opts.limitText) env.FAKE_CLAUDE_LIMIT_TEXT = opts.limitText;
  const args = ["-p", "--output-format", "stream-json", "--model", opts.model];
  return spawnSync(process.execPath, [SHIM, ...args], {
    input: "the prompt\n",
    encoding: "utf8",
    env,
  });
}

function seedPhantom(dir: string): string {
  const stateFile = join(dir, "claw2.json");
  writeFileSync(
    stateFile,
    JSON.stringify({
      accountId: "claw2",
      updatedAt: Date.now() - 99 * HOUR,
      windows: {
        [modelWindowKey("claude-fable-5-1")]: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 4 * 3600,
          seenAt: Date.now() - 99 * HOUR,
        },
      },
    }),
  );
  return stateFile;
}

function readState(file: string): AccountHealthState {
  return JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
}

describe("#26 shim: success and refusal are both recorded", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
    expect(existsSync(SHIM)).toBe(true);
  });

  test("a successful turn on the model clears the phantom rejection on disk", () => {
    const stateFile = seedPhantom(mkdtempSync(join(tmpdir(), "mc-26-")));
    const res = runShim({ stateFile, model: "claude-fable-5-1" });
    expect(res.status).toBe(0);
    const state = readState(stateFile);
    expect(state.windows[modelWindowKey("claude-fable-5-1")].status).toBe("allowed");
    expect(classifyAccountHealth(state, {}, Date.now(), "claude-fable-5-1").verdict).not.toBe(
      "exhausted",
    );
    expect(res.stderr).toContain("model rejection cleared");
  });

  test("delete the fix: a turn that was itself refused clears nothing", () => {
    const stateFile = seedPhantom(mkdtempSync(join(tmpdir(), "mc-26-")));
    // Exit 0 on purpose: the exit code alone must never count as success.
    runShim({ stateFile, model: "claude-fable-5-1", emitLimit: true, exit: "0" });
    const w = readState(stateFile).windows[modelWindowKey("claude-fable-5-1")];
    expect(w.status).toBe("rejected");
    // ...and the refusal re-recorded itself with a fresh observation.
    expect(Date.now() - w.seenAt).toBeLessThan(60_000);
  });

  test("a turn on a different model leaves the rejection in place", () => {
    const stateFile = seedPhantom(mkdtempSync(join(tmpdir(), "mc-26-")));
    runShim({ stateFile, model: "claude-opus-5-5" });
    expect(readState(stateFile).windows[modelWindowKey("claude-fable-5-1")].status).toBe(
      "rejected",
    );
  });

  test("a failed exit clears nothing, whatever the stream carried", () => {
    const stateFile = seedPhantom(mkdtempSync(join(tmpdir(), "mc-26-")));
    const res = runShim({ stateFile, model: "claude-fable-5-1", exit: "1" });
    expect(res.status).toBe(1);
    expect(readState(stateFile).windows[modelWindowKey("claude-fable-5-1")].status).toBe(
      "rejected",
    );
  });

  test("a refusal naming the family is recorded family-wide", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-26-"));
    const stateFile = join(dir, "claw2.json");
    runShim({
      stateFile,
      model: "claude-fable-5-1",
      emitLimit: true,
      limitText:
        "You've reached your Fable limit. Switch to another model, or manage usage credits.",
    });
    const state = readState(stateFile);
    expect(state.windows[modelWindowKey("claude-fable-5-1")].family).toBe("fable");
    expect(classifyAccountHealth(state, {}, Date.now(), "claude-fable-5").verdict).toBe(
      "exhausted",
    );
  });

  test("a refusal naming a version stays scoped to that version", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-26-"));
    const stateFile = join(dir, "claw2.json");
    runShim({ stateFile, model: "claude-fable-5", emitLimit: true });
    const state = readState(stateFile);
    expect(state.windows[modelWindowKey("claude-fable-5")].family).toBeUndefined();
    expect(classifyAccountHealth(state, {}, Date.now(), "claude-fable-5-1").verdict).not.toBe(
      "exhausted",
    );
  });
});
