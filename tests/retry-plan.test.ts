import { describe, expect, test } from "vitest";
import {
  buildRetryEnv,
  chooseRetryAccount,
  parseRetryRoster,
  retryArming,
  RETRY_ROSTER_ENV,
  type RetryAccount,
} from "../src/retry-plan";
import type { AccountHealthState } from "../src/shim-core";

const NOW = 1_800_000_000_000;

function account(id: string, env: Record<string, string> = {}): RetryAccount {
  return { id, stateFile: `/state/${id}.json`, env };
}

const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];

describe("parseRetryRoster", () => {
  test("round-trips the plugin's roster", () => {
    const roster = [account("claw2", { CLAUDE_CONFIG_DIR: "/home/u/.claude-two" })];
    expect(parseRetryRoster(JSON.stringify(roster))).toEqual(roster);
  });

  test("malformed input disables retry rather than throwing", () => {
    // A broken roster must degrade to today's behaviour: the turn still runs,
    // it just does not get the extra chance.
    expect(parseRetryRoster(undefined)).toEqual([]);
    expect(parseRetryRoster("")).toEqual([]);
    expect(parseRetryRoster("{not json")).toEqual([]);
    expect(parseRetryRoster('{"id":"claw2"}')).toEqual([]);
    expect(parseRetryRoster('[{"id":"claw2"}]')).toEqual([]);
    expect(parseRetryRoster('[{"stateFile":"/s.json"}]')).toEqual([]);
  });

  test("non-string env values are dropped, not coerced", () => {
    const parsed = parseRetryRoster(
      '[{"id":"claw2","stateFile":"/s.json","env":{"CLAUDE_CONFIG_DIR":"/d","X":5}}]',
    );
    expect(parsed[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/d" });
  });
});

describe("retryArming", () => {
  test("armed for a fresh stream-json launch with a sibling", () => {
    expect(retryArming(STREAM_ARGS, [account("claw2")])).toEqual({ armed: true });
  });

  test("never armed for a resumed session", () => {
    // The session being resumed lives in THIS account's config dir; re-spawning
    // it elsewhere either fails to resume or drops the conversation.
    const arming = retryArming([...STREAM_ARGS, "--resume", "abc"], [account("claw2")]);
    expect(arming.armed).toBe(false);
    expect(arming.reason).toContain("resumed session");
  });

  test("never armed outside stream-json", () => {
    expect(retryArming(["-p"], [account("claw2")]).armed).toBe(false);
    expect(retryArming(["-p", "--output-format=stream-json"], [account("claw2")]).armed).toBe(true);
  });

  test("an empty roster disarms with a reason, not silently", () => {
    const arming = retryArming(STREAM_ARGS, []);
    expect(arming.armed).toBe(false);
    expect(arming.reason).toContain("sibling");
  });
});

describe("chooseRetryAccount", () => {
  const states: Record<string, AccountHealthState> = {
    "/state/healthy.json": { accountId: "healthy", windows: {} },
    "/state/limited.json": {
      accountId: "limited",
      windows: {
        "model:claude-fable-5-1": { status: "rejected", seenAt: NOW - 60_000 },
      },
    },
    "/state/dead.json": {
      accountId: "dead",
      windows: {},
      credential: { status: "failed", seenAt: NOW - 60_000 },
    },
  };
  const readState = (f: string) => states[f];

  test("skips an account already limited for THIS model", () => {
    const chosen = chooseRetryAccount({
      roster: [
        { id: "limited", stateFile: "/state/limited.json", env: {} },
        { id: "healthy", stateFile: "/state/healthy.json", env: {} },
      ],
      readState,
      modelId: "claude-fable-5-1",
      nowMs: NOW,
    });
    expect(chosen?.id).toBe("healthy");
  });

  test("an account limited for another model is still eligible", () => {
    const chosen = chooseRetryAccount({
      roster: [{ id: "limited", stateFile: "/state/limited.json", env: {} }],
      readState,
      modelId: "claude-opus-5",
      nowMs: NOW,
    });
    expect(chosen?.id).toBe("limited");
  });

  test("skips an account whose login is known dead", () => {
    expect(
      chooseRetryAccount({
        roster: [{ id: "dead", stateFile: "/state/dead.json", env: {} }],
        readState,
        modelId: "claude-fable-5-1",
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  test("an account with no state yet is eligible (a standby has never run)", () => {
    const chosen = chooseRetryAccount({
      roster: [{ id: "fresh", stateFile: "/state/none.json", env: {} }],
      readState: () => undefined,
      modelId: "claude-fable-5-1",
      nowMs: NOW,
    });
    expect(chosen?.id).toBe("fresh");
  });

  test("returns undefined when every sibling is barred", () => {
    expect(
      chooseRetryAccount({
        roster: [
          { id: "limited", stateFile: "/state/limited.json", env: {} },
          { id: "dead", stateFile: "/state/dead.json", env: {} },
        ],
        readState,
        modelId: "claude-fable-5-1",
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });
});

describe("buildRetryEnv", () => {
  test("swaps identity completely and forbids a second retry", () => {
    const env = buildRetryEnv(
      {
        PATH: "/usr/bin",
        CLAUDE_CONFIG_DIR: "/home/u/.claude-one",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-one",
        MULTI_CLAWD_ACCOUNT_ID: "claw1",
        MULTI_CLAWD_STATE_FILE: "/state/claw1.json",
        [RETRY_ROSTER_ENV]: "[...]",
        MULTI_CLAWD_MODEL_OVERRIDE: "claude-sonnet-5",
      },
      account("claw2", { CLAUDE_CONFIG_DIR: "/home/u/.claude-two" }),
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-two");
    // The leaving account's token must not survive into the sibling's child —
    // it would decide the retry's identity and spend the wrong subscription.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
    expect(env.MULTI_CLAWD_STATE_FILE).toBe("/state/claw2.json");
    expect(env[RETRY_ROSTER_ENV]).toBe("");
    // Unrelated plumbing survives.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MULTI_CLAWD_MODEL_OVERRIDE).toBe("claude-sonnet-5");
  });

  test("a native sibling inherits no config dir from the account it replaces", () => {
    const env = buildRetryEnv({ CLAUDE_CONFIG_DIR: "/home/u/.claude-two" }, account("claw1"));
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
