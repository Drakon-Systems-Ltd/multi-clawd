import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_MAX_BYTES, historyFile, parseHistorySince, readHistory, recordHistory, renderHistory } from "../src/history.js";
import { cleanShimEnv } from "./shim-env.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const shim = join(root, "dist", "shim.js");
const fake = join(root, "tests", "fixtures", "fake-claude.mjs");
const at = () => new Date().toISOString();
const event = (accountId = "claw1") => ({ at: at(), kind: "served" as const, accountId });

describe("issue #70 account history", () => {
  test("records each account launch, retry hop, and classified rotation at the shim call sites", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-shim-"));
    const state = join(dir, "claw1.json");
    const result = spawnSync(process.execPath, [shim, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"], {
      encoding: "utf8", input: "private prompt\n",
      env: { ...cleanShimEnv(), MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, fake]),
        MULTI_CLAWD_STATE_FILE: state, MULTI_CLAWD_ACCOUNT_ID: "claw1",
        CLAUDE_CODE_OAUTH_TOKEN: "private-credential-value", PRIVATE_ENV_VALUE: "private-env-value",
        FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1",
        MULTI_CLAWD_RETRY_ACCOUNTS: JSON.stringify([{ id: "claw2", stateFile: join(dir, "claw2.json"), env: { CLAUDE_CONFIG_DIR: join(dir, "claw2") } }]) },
    });
    expect(result.status).toBe(0);
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.kind === "served").map((e) => e.accountId)).toEqual(["claw1", "claw2"]);
    expect(rows.filter((e) => e.kind === "retry")).toEqual([
      expect.objectContaining({ accountId: "claw1", toAccountId: "claw2", reason: "model_limit" }),
    ]);
    expect(rows.filter((e) => e.kind === "rotation")).toEqual([
      expect.objectContaining({ accountId: "claw1", toAccountId: "claw2", reason: "model_limit" }),
    ]);
    const raw = readFileSync(historyFile(state), "utf8");
    expect(raw).not.toContain("private prompt");
    expect(raw).not.toContain("private-credential-value");
    expect(raw).not.toContain("private-env-value");
    expect(raw).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test.each([
    ["model limit", { FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1" }],
    ["auth failure", { FAKE_CLAUDE_EMIT_AUTH_FAIL: "1" }],
  ])("records no rotation for a single-account %s", (_cause, fakeEnv) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-single-"));
    const state = join(dir, "claw1.json");
    const result = spawnSync(process.execPath, [shim, "-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"], {
      encoding: "utf8", input: "private prompt\n",
      env: { ...cleanShimEnv(), MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, fake]),
        MULTI_CLAWD_STATE_FILE: state, MULTI_CLAWD_ACCOUNT_ID: "claw1", ...fakeEnv },
    });
    expect(result.error).toBeUndefined();
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.kind === "served")).toHaveLength(1);
    expect(rows.filter((e) => e.kind === "rotation")).toEqual([]);
  });

  test("bounds the file, skips corrupt lines, and drops sensitive unknown fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-cap-"));
    const state = join(dir, "claw1.json");
    for (let i = 0; i < 650; i++) recordHistory(state, { ...event(), modelId: "claude-fable-5-1",
      prompt: "private prompt", credential: "secret token", env: "sensitive" } as Parameters<typeof recordHistory>[1]);
    const file = historyFile(state);
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(readHistory(file).length).toBeLessThanOrEqual(500);
    expect(readFileSync(file, "utf8")).not.toMatch(/private prompt|secret token|sensitive/);
    writeFileSync(file, `${readFileSync(file, "utf8")}not-json\n{"at":`, "utf8");
    expect(readHistory(file).length).toBeGreaterThan(0);
    recordHistory(state, event());
    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  // 651 locked read/trim/replace cycles: ~0.25 s locally, but over 5 s on the
  // Linux Node 22 CI runner under the full parallel suite. Explicit budget.
  }, 30_000);

  test("two concurrent writers keep valid, bounded events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-history-writers-"));
    const script = join(dir, "writer.mjs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, `import { recordHistory } from ${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)};\nfor (let i = 0; i < 20; i++) recordHistory(process.argv[2], { at: new Date().toISOString(), kind: "served", accountId: process.argv[3] });\n`);
    const state = join(dir, "claw1.json");
    const run = (id: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [script, state, id]);
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(await Promise.all([run("claw1"), run("claw2")])).toEqual([0, 0]);
    const rows = readHistory(historyFile(state));
    expect(rows.filter((e) => e.accountId === "claw1")).toHaveLength(20);
    expect(rows.filter((e) => e.accountId === "claw2")).toHaveLength(20);
    expect(statSync(historyFile(state)).size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  });

  test("parses since and renders per-account counts and last served", () => {
    expect(parseHistorySince("7d")).toBe(604800000);
    expect(parseHistorySince("24h")).toBe(86400000);
    expect(() => parseHistorySince("banana")).toThrow(/--since/);
    expect(() => parseHistorySince("0d")).toThrow(/--since/);
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const rows = [
      { at: "2026-10-24T12:00:00.000Z", kind: "served" as const, accountId: "claw1" },
      { at: "2026-10-24T13:00:00.000Z", kind: "retry" as const, accountId: "claw1", toAccountId: "claw2" },
      { at: "2026-10-24T14:00:00.000Z", kind: "rotation" as const, accountId: "claw1", reason: "model_limit" as const },
      { at: "2026-10-24T15:00:00.000Z", kind: "served" as const, accountId: "claw2" },
      { at: "2026-10-15T12:00:00.000Z", kind: "served" as const, accountId: "claw1" },
    ];
    const rendered = renderHistory(rows, ["claw1", "claw2", "claw3"], "7d", now);
    expect(rendered).toContain("claw1: 1 served launch, 1 retry, 1 rotation; last served 2026-10-24T12:00:00.000Z");
    expect(rendered).toContain("claw2: 1 served launch,");
    expect(rendered).toContain("claw3: 0 served launches, 0 retries, 0 rotations; last served never");
  });

  test("last served uses the latest timestamp when events are appended out of order", () => {
    const rows = [
      { at: "2026-10-24T10:00:00.000Z", kind: "served" as const, accountId: "claw1" },
      { at: "2026-10-24T09:00:00.000Z", kind: "served" as const, accountId: "claw1" },
    ];
    expect(renderHistory(rows, ["claw1"], "7d", Date.parse("2026-10-25T12:00:00.000Z")))
      .toContain("claw1: 2 served launches, 0 retries, 0 rotations; last served 2026-10-24T10:00:00.000Z");
  });

  test("explain --history renders counts, invalid --since exits non-zero, plain explain stays unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-history-cli-"));
    const openclaw = join(home, ".openclaw");
    mkdirSync(openclaw, { recursive: true });
    writeFileSync(join(openclaw, "openclaw.json"), JSON.stringify({ plugins: { entries: {
      "multi-clawd": { config: { accounts: [{ id: "claw1", label: "First" }] } },
    } } }));
    recordHistory(join(openclaw, "state", "multi-clawd", "claw1.json"), event());
    const cli = join(root, "scripts", "cli.mjs");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "explain", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    });
    const plain = run();
    const history = run("--history", "--since", "24h");
    const invalid = run("--history", "--since", "yesterday");
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain("Account history");
    expect(history.status).toBe(0);
    expect(history.stdout).toContain("Account history (last 24h):");
    expect(history.stdout).toContain("claw1: 1 served launch,");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("--since must be a positive duration");
  });
});
