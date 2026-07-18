import { describe, expect, test } from "vitest";
import {
  decideDegradation,
  matchesPin,
  rewriteModelArg,
} from "../src/degrade";
import type { HealthVerdict } from "../src/health";

function verdicts(...vs: Array<[string, HealthVerdict]>) {
  return vs.map(([id, verdict]) => ({ id, verdict }));
}

const LADDER = ["claude-opus-4-8", "claude-sonnet-5"];

describe("decideDegradation", () => {
  test("healthy pool: no degradation", () => {
    const d = decideDegradation({
      verdicts: verdicts(["claw1", "ok"], ["claw2", "ok"]),
      requestedModel: "claude-fable-5",
      ladder: LADDER,
    });
    expect(d).toBeUndefined();
  });

  test("one account still usable: no degradation (rotation handles it)", () => {
    const d = decideDegradation({
      verdicts: verdicts(["claw1", "exhausted"], ["claw2", "near_limit"]),
      requestedModel: "claude-fable-5",
      ladder: LADDER,
    });
    expect(d).toBeUndefined();
  });

  test("whole pool exhausted: degrade to the first ladder model", () => {
    const d = decideDegradation({
      verdicts: verdicts(["claw1", "exhausted"], ["claw2", "exhausted"]),
      requestedModel: "claude-fable-5",
      ladder: LADDER,
    });
    expect(d).toEqual({ model: "claude-opus-4-8", reason: "pool exhausted for claude-fable-5" });
  });

  test("requested model already at or below the ladder: never degrade further", () => {
    const exhausted = verdicts(["claw1", "exhausted"], ["claw2", "exhausted"]);
    expect(
      decideDegradation({ verdicts: exhausted, requestedModel: "claude-opus-4-8", ladder: LADDER }),
    ).toBeUndefined();
    expect(
      decideDegradation({ verdicts: exhausted, requestedModel: "claude-sonnet-5", ladder: LADDER }),
    ).toBeUndefined();
  });

  test("no ladder configured: no degradation", () => {
    const d = decideDegradation({
      verdicts: verdicts(["claw1", "exhausted"]),
      requestedModel: "claude-fable-5",
      ladder: [],
    });
    expect(d).toBeUndefined();
  });

  test("single-account pool degrades (the single-account host use case)", () => {
    const d = decideDegradation({
      verdicts: verdicts(["claw1", "exhausted"]),
      requestedModel: "claude-fable-5",
      ladder: ["claude-opus-4-8"],
    });
    expect(d?.model).toBe("claude-opus-4-8");
  });
});

describe("matchesPin (never-degrade lanes)", () => {
  test("agentDir substring pin matches", () => {
    expect(
      matchesPin(
        [{ agentDirIncludes: "billing-app" }],
        { agentDir: "/home/user/.openclaw/agents/billing-app", workspaceDir: "/w" },
      ),
    ).toBe(true);
  });

  test("workspaceDir substring pin matches", () => {
    expect(
      matchesPin(
        [{ workspaceDirIncludes: "client-portal" }],
        { agentDir: "/a", workspaceDir: "/srv/client-portal/books" },
      ),
    ).toBe(true);
  });

  test("non-matching launches are not pinned", () => {
    expect(
      matchesPin(
        [{ agentDirIncludes: "billing-app" }, { workspaceDirIncludes: "contracts" }],
        { agentDir: "/agents/main", workspaceDir: "/dev/scratch" },
      ),
    ).toBe(false);
  });

  test("empty pin list pins nothing; empty matcher never matches", () => {
    expect(matchesPin([], { agentDir: "/a", workspaceDir: "/w" })).toBe(false);
    expect(matchesPin([{}], { agentDir: "/a", workspaceDir: "/w" })).toBe(false);
  });
});

describe("rewriteModelArg", () => {
  test("replaces the value following --model", () => {
    const argv = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5", "--verbose"];
    expect(rewriteModelArg(argv, "claude-opus-4-8")).toEqual([
      "-p", "--output-format", "stream-json", "--model", "claude-opus-4-8", "--verbose",
    ]);
  });

  test("replaces every occurrence (last-wins CLIs stay consistent)", () => {
    const argv = ["--model", "a", "--x", "--model", "b"];
    expect(rewriteModelArg(argv, "c")).toEqual(["--model", "c", "--x", "--model", "c"]);
  });

  test("argv without --model is returned unchanged", () => {
    const argv = ["-p", "--verbose"];
    expect(rewriteModelArg(argv, "claude-opus-4-8")).toEqual(argv);
  });

  test("trailing --model with no value is left alone", () => {
    expect(rewriteModelArg(["-p", "--model"], "x")).toEqual(["-p", "--model"]);
  });
});
