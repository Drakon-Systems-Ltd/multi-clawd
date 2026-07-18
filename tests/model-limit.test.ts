import { describe, expect, test } from "vitest";
import {
  parseModelLimitError,
  recordModelLimit,
  modelWindowKey,
  canonicalizeModelIdForWindow,
  type AccountHealthState,
} from "../src/shim-core";
import { classifyAccountHealth } from "../src/health";

const NOW = 1_784_500_000_000;
const NOW_S = NOW / 1000;

const LIMIT_LINE = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "You've reached your Fable 5 limit. /model to switch models.",
  session_id: "s1",
});

describe("parseModelLimitError", () => {
  test("recognises the real 429 limit record and extracts the display name", () => {
    const hit = parseModelLimitError(LIMIT_LINE);
    expect(hit).toEqual({ displayName: "Fable 5" });
  });

  test("recognises limit text in an error field too", () => {
    const line = JSON.stringify({
      type: "error",
      error: { message: "You've reached your Opus 4.8 limit. /model to switch models." },
    });
    expect(parseModelLimitError(line)).toEqual({ displayName: "Opus 4.8" });
  });

  test("ignores non-limit errors and junk without throwing", () => {
    expect(parseModelLimitError(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toBeUndefined();
    expect(parseModelLimitError('{"type":"assistant"}')).toBeUndefined();
    expect(parseModelLimitError("not json")).toBeUndefined();
    // a successful result QUOTING limit text must not trigger
    expect(
      parseModelLimitError(
        JSON.stringify({ type: "result", is_error: false, result: "You've reached your Fable 5 limit." }),
      ),
    ).toBeUndefined();
  });
});

describe("canonicalizeModelIdForWindow", () => {
  test("strips known provider/account prefixes to the bare model id", () => {
    for (const id of [
      "clawd/claude-fable-5",
      "claw2/claude-fable-5",
      "claw3/claude-fable-5",
      "claude-cli/claude-fable-5",
      "anthropic/claude-fable-5",
      "claude-fable-5",
    ]) {
      expect(canonicalizeModelIdForWindow(id)).toBe("claude-fable-5");
    }
  });

  test("leaves an unknown prefix untouched (conservative)", () => {
    expect(canonicalizeModelIdForWindow("other/claude-fable-5")).toBe("other/claude-fable-5");
  });

  test("modelWindowKey keys the same window regardless of spelling", () => {
    expect(modelWindowKey("anthropic/claude-fable-5")).toBe(modelWindowKey("claude-fable-5"));
    expect(modelWindowKey("clawd/claude-fable-5")).toBe("model:claude-fable-5");
  });
});

describe("recordModelLimit", () => {
  test("writes a model-scoped rejected window keyed by canonical model id", () => {
    let state: AccountHealthState = { accountId: "claw1", windows: {} };
    state = recordModelLimit(state, "claude-fable-5", NOW, NOW_S + 3600);
    expect(state.windows[modelWindowKey("claude-fable-5")]).toMatchObject({
      status: "rejected",
      resetsAt: NOW_S + 3600,
      seenAt: NOW,
    });
    expect(state.updatedAt).toBe(NOW);
  });

  test("resetsAt is optional (TTL semantics apply at read time)", () => {
    const state = recordModelLimit({ accountId: "a", windows: {} }, "claude-fable-5", NOW);
    expect(state.windows[modelWindowKey("claude-fable-5")].resetsAt).toBeUndefined();
  });
});

describe("model-aware classifyAccountHealth", () => {
  function stateWith(windows: AccountHealthState["windows"]): AccountHealthState {
    return { accountId: "claw1", updatedAt: NOW - 1000, windows };
  }

  test("a model-rejected window exhausts the account ONLY for that model", () => {
    const state = stateWith({
      [modelWindowKey("claude-fable-5")]: { status: "rejected", resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
      five_hour: { status: "allowed", seenAt: NOW - 1000 },
    });
    expect(
      classifyAccountHealth(state, {}, NOW, "claude-fable-5").verdict,
    ).toBe("exhausted");
    expect(classifyAccountHealth(state, {}, NOW, "claude-opus-4-8").verdict).toBe("ok");
    expect(classifyAccountHealth(state, {}, NOW).verdict).toBe("ok");
  });

  test("model window without resetsAt blocks for the TTL, then unbinds", () => {
    const state = stateWith({
      [modelWindowKey("claude-fable-5")]: { status: "rejected", seenAt: NOW - 30 * 60 * 1000 },
    });
    // within the 60-min default TTL → exhausted for that model
    expect(classifyAccountHealth(state, {}, NOW, "claude-fable-5").verdict).toBe("exhausted");
    // past the TTL → no longer binding. The account's ONLY window is now an
    // expired model window, i.e. no live evidence → no_data (which every
    // selector treats identically to ok: choosePoolAccount/sticky both accept
    // ok||no_data, degrade only checks exhausted). The pre-v0.3.7 code reported
    // "ok" here only because the model window still counted toward the generic
    // staleAfterMs freshness gate; now model windows age purely by their own
    // TTL, so an expired one is correctly not-evidence.
    const later = NOW + 40 * 60 * 1000;
    const stateFresh = { ...state, updatedAt: later - 1000 };
    expect(classifyAccountHealth(stateFresh, {}, later, "claude-fable-5").verdict).toBe("no_data");
  });

  test("model window with a PASSED resetsAt is not binding", () => {
    const state = stateWith({
      [modelWindowKey("claude-fable-5")]: { status: "rejected", resetsAt: NOW_S - 60, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(state, {}, NOW, "claude-fable-5").verdict).toBe("ok");
  });

  test("account-level windows still gate every model", () => {
    const state = stateWith({
      five_hour: { status: "rejected", resetsAt: NOW_S + 600, seenAt: NOW - 1000 },
    });
    expect(classifyAccountHealth(state, {}, NOW, "claude-opus-4-8").verdict).toBe("exhausted");
  });

  test("exhausted-for-model carries resumeAt from resetsAt", () => {
    const state = stateWith({
      [modelWindowKey("claude-fable-5")]: { status: "rejected", resetsAt: NOW_S + 3600, seenAt: NOW - 1000 },
    });
    const h = classifyAccountHealth(state, {}, NOW, "claude-fable-5");
    expect(h.resumeAt).toBe((NOW_S + 3600) * 1000);
  });
});
