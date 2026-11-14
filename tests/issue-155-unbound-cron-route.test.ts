/**
 * multi-clawd#155 — evidence harness for the unbound cron route (Tier A).
 *
 * WHAT THIS IS: a measurement of how OpenClaw's automation admission and run
 * path treat the pool, taken through the documented `openclaw cron` CLI against
 * a throwaway gateway child. It is NOT a fix and does NOT close #155: the
 * reported case (`clawd/*` as an automation model with no extra config, on a
 * bound job, or as a fallback) is still refused upstream, and S0 below pins
 * that refusal.
 *
 * Scope (deliberately narrow):
 *   S0  M0, plugin as built, no operator config  -> `cron add` is refused with
 *       the #155 text. This is the armed control: if it stops failing,
 *       upstream changed and S1-S3 must be re-read, not trusted.
 *   S1  M1 (fixture wrapper declares modelProvider = each backend's own id,
 *       operator sets agentRuntime on the pool model) -> `cron add` succeeds
 *       and the stored job carries no inference binding.
 *   S2  M1 -> `cron run --wait` launches the fake Claude exactly once, on a
 *       pool account, with scratch config dir and no Anthropic variables.
 *   S3  M1 -> neither the run output nor the gateway log carries the run-time
 *       "no recorded inference account" refusal.
 * Not here: the `anthropic` alias variant (M2), fallback behaviour, picker and
 * chat routing. `modelProvider` is declared by a TEST FIXTURE only; nothing in
 * `src/` changes.
 *
 * Isolation: scratch HOME/state/config, empty account directories, an
 * environment built from nothing against an allowlist, a fake Claude
 * subprocess, and a tripwire that refuses and records every non-loopback
 * network attempt. No credential exists anywhere in the tree.
 *
 * Where it runs: the gateway-child block needs MC155_GATEWAY_ROUTE=1, which
 * only the CI job `cron-route-evidence-155` (and the remote test runner) sets.
 * Everywhere else that block is SKIPPED, and a skip is not a pass. With the
 * gate on it never skips: a wrong or too-old OpenClaw fails, and the CI job
 * also fails unless the evidence file carries S0, S1, S2 and S3.
 *
 * Error strings asserted here are not an upstream contract. If S0 or S3
 * fails on a new OpenClaw, read what changed before touching the assertion.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compareCalVer, installedOpenClawVersion } from "./support/openclaw-upstream.js";
import {
  ADMISSION_REFUSAL_155,
  CLAUDE_MODEL_ID,
  FAKE_CLAUDE,
  MIN_BINDER_OPENCLAW,
  MISSING_MODEL_PROVIDER_FRAGMENT,
  MODEL_REF,
  POOL_ACCOUNTS,
  POOL_ID,
  TRIPWIRE,
  accountDirsAreEmpty,
  buildChildEnv,
  buildConfig,
  createScratch,
  cron,
  gatewayLogs,
  isAdmissionRefusal155,
  isolationViolations,
  keyPathsMatching,
  parseCliJson,
  readJsonl,
  routeEvidenceProblems,
  otherJobAccountNotices,
  runtimeRefusalLines,
  unexpectedBlocked,
  startGateway,
  stopGateway,
  tripwireArmed,
  tripwireBlocked,
  waitForGateway,
  type CliResult,
  type FakeLaunch,
  type GatewayChild,
  type TripwireEntry,
} from "./support/mc155-harness.js";

const GATE_ON = process.env.MC155_GATEWAY_ROUTE === "1";
const JOB_MESSAGE = "MC155 route evidence turn";

// ---------------------------------------------------------------------------
// Part 1 — the harness's own guards and detectors. No gateway. Runs everywhere.
// Each detector is shown to FAIL when it is disabled or fed clean-looking but
// wrong input, so a green gated run cannot come from a blind check.
// ---------------------------------------------------------------------------

describe("#155 harness: isolation guard (no gateway)", () => {
  const scratch = createScratch("guard");
  const env = buildChildEnv(scratch, "M1");

  test("the built environment is isolated and carries nothing from the host environment", () => {
    expect(isolationViolations(env, scratch.root)).toEqual([]);
    for (const key of Object.keys(env)) {
      expect(key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_")).toBe(false);
    }
    expect(env.HOME).toBe(scratch.home);
    // The whole PATH is one scratch directory with `node` and `sh` only.
    expect(env.PATH).toBe(scratch.bin);
    expect(readdirSync(scratch.bin).sort()).toEqual(["node", "sh"]);
    expect(accountDirsAreEmpty(scratch, (dir) => readdirSync(dir))).toBe(true);
  });

  test("it refuses a real home, a path outside scratch, a stray variable and a missing tripwire", () => {
    expect(isolationViolations({ ...env, HOME: "/home/someone" }, scratch.root, "/home/someone")).toEqual(
      expect.arrayContaining(["HOME points outside the scratch root", "HOME is the real home directory"]),
    );
    expect(isolationViolations({ ...env, OPENCLAW_STATE_DIR: "/var/lib/openclaw" }, scratch.root)).toContain(
      "OPENCLAW_STATE_DIR points outside the scratch root",
    );
    expect(isolationViolations({ ...env, ANTHROPIC_API_KEY: "x" }, scratch.root)).toContain(
      "environment variable ANTHROPIC_API_KEY is not on the allowlist",
    );
    expect(isolationViolations({ ...env, MC155_TRIPWIRE_DISABLED: "1" }, scratch.root)).toContain(
      "environment variable MC155_TRIPWIRE_DISABLED is not on the allowlist",
    );
    expect(isolationViolations({ ...env, NODE_OPTIONS: "" }, scratch.root)).toContain(
      "NODE_OPTIONS does not preload the network tripwire",
    );
    expect(isolationViolations({ ...env, MULTI_CLAWD_CLAUDE_BIN: "/usr/local/bin/claude" }, scratch.root)).toContain(
      "MULTI_CLAWD_CLAUDE_BIN is not the interpreter-form fake Claude fixture",
    );
    // The fake without the tripwire preload is refused too.
    expect(
      isolationViolations(
        { ...env, MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE_CLAUDE]) },
        scratch.root,
      ),
    ).toContain("MULTI_CLAWD_CLAUDE_BIN is not the interpreter-form fake Claude fixture");
    expect(isolationViolations({ ...env, OPENCLAW_SKIP_CHANNELS: "0" }, scratch.root)).toContain(
      'OPENCLAW_SKIP_CHANNELS must be "1"',
    );
    expect(isolationViolations(env, "/home/someone", "/home/someone")).toEqual(
      expect.arrayContaining([
        "scratch root /home/someone is not an mc155- temp directory",
        "scratch root contains the real home directory",
      ]),
    );
  });

  test("it refuses when a real claude executable is reachable on the child PATH", () => {
    const bin = join(scratch.tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(isolationViolations({ ...env, PATH: `${bin}:${env.PATH}` }, scratch.root)).toContain(
      "a real `claude` executable is reachable on the child PATH",
    );
  });

  test("the config keeps OpenClaw's file log in scratch and switches off its background requests", () => {
    const config = buildConfig(scratch, "M0", 1) as {
      logging: { file: string };
      update: unknown;
      models: unknown;
      gateway: { bind: string };
    };
    expect(config.logging.file.startsWith(`${scratch.root}/`)).toBe(true);
    expect(config.update).toEqual({ checkOnStart: false });
    expect(config.models).toEqual({ catalogRefresh: { enabled: false } });
    expect(config.gateway.bind).toBe("loopback");
  });

  test("the M0 config has no operator model policy and the M1 config has exactly the pool one", () => {
    const m0 = buildConfig(scratch, "M0", 1) as { agents?: unknown };
    const m1 = buildConfig(scratch, "M1", 1) as {
      agents: { defaults: { models: Record<string, unknown> } };
    };
    expect(m0.agents).toBeUndefined();
    expect(m1.agents.defaults.models).toEqual({ [MODEL_REF]: { agentRuntime: { id: "clawd" } } });
  });
});

describe("#155 harness: network tripwire (no gateway, no packet leaves)", () => {
  // The probe calls connect() and destroys the socket in the same tick. Node
  // issues the connect syscall on a later tick, so no packet is sent whether
  // or not the tripwire is loaded; 192.0.2.1 is a documentation address
  // (RFC 5737) in any case. The tripwire records synchronously inside
  // connect(), so the record does not depend on the syscall.
  const PROBE = [
    'const net = require("node:net");',
    'const s = net.connect({ host: process.argv[1], port: 9 });',
    's.on("error", () => {});',
    "s.destroy();",
  ].join("");

  function probe(host: string, extraEnv: Record<string, string>): TripwireEntry[] {
    const dir = mkdtempSync(join(tmpdir(), "mc155-tripwire-"));
    const log = join(dir, "tripwire.jsonl");
    const result = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", PROBE, host], {
      env: { PATH: process.env.PATH ?? "", MC155_TRIPWIRE_LOG: log, ...extraEnv },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return readJsonl<TripwireEntry>(log);
  }

  test("armed: a non-loopback connect is recorded as blocked", () => {
    const entries = probe("192.0.2.1", {});
    expect(tripwireArmed(entries)).toBe(true);
    expect(tripwireBlocked(entries)).toEqual([
      expect.objectContaining({ event: "blocked-connect", host: "192.0.2.1", port: 9 }),
    ]);
  });

  test("armed: a hostname connect is blocked before any DNS lookup", () => {
    const entries = probe("api.anthropic.com", {});
    expect(tripwireBlocked(entries)).toEqual([
      expect.objectContaining({ event: "blocked-connect", host: "api.anthropic.com" }),
    ]);
  });

  test("armed: loopback connects are not recorded", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const entries = probe(host, {});
      expect(tripwireArmed(entries)).toBe(true);
      expect(tripwireBlocked(entries)).toEqual([]);
    }
  });

  test("control: with the detector disabled the same probe leaves no record, and the arm check fails", () => {
    const entries = probe("192.0.2.1", { MC155_TRIPWIRE_DISABLED: "1" });
    expect(entries).toEqual([]);
    // An empty log is exactly what a clean run looks like, which is why the
    // gated suite requires `armed` lines and never trusts an empty log alone.
    expect(tripwireArmed(entries)).toBe(false);
  });
});

describe("#155 harness: fake Claude launch log and evidence evaluators (no gateway)", () => {
  const scratch = createScratch("eval");

  function runFake(extraEnv: Record<string, string>): void {
    const result = spawnSync(process.execPath, [FAKE_CLAUDE, "--model", CLAUDE_MODEL_ID], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch.home,
        NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}`,
        MC155_TRIPWIRE_LOG: scratch.tripwireLog,
        MULTI_CLAWD_ACCOUNT_ID: "claw1",
        CLAUDE_CONFIG_DIR: scratch.accountDirs.claw1,
        ...extraEnv,
      },
      input: "MC155 direct fake launch\n",
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
  }

  test("one launch with the log on is one clean record; the evaluator accepts it", () => {
    runFake({ FAKE_CLAUDE_LAUNCH_LOG: scratch.launchLog });
    const launches = readJsonl<FakeLaunch>(scratch.launchLog);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      model: CLAUDE_MODEL_ID,
      account_id: "claw1",
      config_dir: scratch.accountDirs.claw1,
      anthropic_env_names: [],
      has_oauth_token: false,
      tripwire_armed: true,
    });
    expect(routeEvidenceProblems(launches, scratch)).toEqual([]);
  });

  test("control: with the launch log disabled a real launch leaves no record, and the evaluator fails", () => {
    const other = createScratch("eval-off");
    const result = spawnSync(process.execPath, [FAKE_CLAUDE, "--model", CLAUDE_MODEL_ID], {
      env: { PATH: process.env.PATH ?? "", HOME: other.home, MULTI_CLAWD_ACCOUNT_ID: "claw1" },
      input: "MC155 unlogged launch\n",
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("MC155 unlogged launch");
    expect(routeEvidenceProblems(readJsonl<FakeLaunch>(other.launchLog), other)).toEqual([
      "no fake Claude launch was recorded",
    ]);
  });

  test("the route evaluator rejects every way the evidence can be wrong", () => {
    const good: FakeLaunch = {
      pid: 1,
      model: CLAUDE_MODEL_ID,
      account_id: "claw2",
      config_dir: scratch.accountDirs.claw2,
      home: scratch.home,
      anthropic_env_names: [],
      has_oauth_token: false,
      tripwire_armed: true,
    };
    expect(routeEvidenceProblems([good], scratch)).toEqual([]);
    expect(routeEvidenceProblems([good, good], scratch)).toContain("expected exactly 1 launch, saw 2");
    expect(routeEvidenceProblems([{ ...good, model: "sonnet" }], scratch)).toEqual([
      `launch model is "sonnet", expected ${CLAUDE_MODEL_ID}`,
    ]);
    expect(routeEvidenceProblems([{ ...good, account_id: "anthropic" }], scratch)).toContain(
      'launch account "anthropic" is not a pool account',
    );
    expect(routeEvidenceProblems([{ ...good, account_id: null }], scratch)).toContain(
      "launch account null is not a pool account",
    );
    expect(routeEvidenceProblems([{ ...good, config_dir: scratch.accountDirs.claw1 }], scratch)).toEqual([
      "launch config dir is not the scratch dir of claw2",
    ]);
    expect(routeEvidenceProblems([{ ...good, config_dir: "/home/someone/.claude" }], scratch)).toContain(
      "launch config dir is outside the scratch root",
    );
    expect(routeEvidenceProblems([{ ...good, home: "/home/someone" }], scratch)).toEqual([
      "launch HOME is outside the scratch root",
    ]);
    expect(routeEvidenceProblems([{ ...good, anthropic_env_names: ["ANTHROPIC_API_KEY"] }], scratch)).toEqual([
      "launch carried ANTHROPIC_* variables: ANTHROPIC_API_KEY",
    ]);
    expect(routeEvidenceProblems([{ ...good, has_oauth_token: true }], scratch)).toEqual([
      "launch carried a CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(routeEvidenceProblems([{ ...good, tripwire_armed: false }], scratch)).toEqual([
      "the network tripwire was not armed in the fake Claude process",
    ]);
  });

  test("the S0 refusal matcher needs both a failed exit and the exact #155 text", () => {
    const refused: CliResult = { status: 1, stdout: "", stderr: `invalid cron.add params: ${ADMISSION_REFUSAL_155}\n` };
    expect(isAdmissionRefusal155(refused)).toBe(true);
    // An admitted job (what M1 produces) must not satisfy the control.
    expect(isAdmissionRefusal155({ status: 0, stdout: '{"id":"job"}', stderr: "" })).toBe(false);
    // Some other failure must not be mistaken for the #155 refusal.
    expect(isAdmissionRefusal155({ status: 1, stdout: "", stderr: "gateway closed (1006)" })).toBe(false);
    // The text without a failed exit is not a refusal either.
    expect(isAdmissionRefusal155({ ...refused, status: 0 })).toBe(false);
  });

  test("the S3 detector finds a run-time refusal of this job and ignores a notice about another job", () => {
    const job = { id: "11111111-aaaa", name: "mc155-s1" };
    const exact =
      "Automation has no recorded inference account. Explicitly select its account with a model@profile update before running it.";
    expect(runtimeRefusalLines(["ok", "run finished"], job)).toEqual([]);
    // The exact sentence counts wherever it appears, with or without the job id.
    expect(runtimeRefusalLines([`ok\nerror: ${exact}`], job)).toEqual([`error: ${exact}`]);
    // Any wording of it counts when the line names this job by id or by name.
    const ours = '{"jobId":"11111111-aaaa","msg":"cron: automation has no recorded inference account; run doctor"}';
    const oursByName = 'cron: automation has no recorded inference account (job "mc155-s1")';
    expect(runtimeRefusalLines([ours, oursByName], job)).toEqual([ours, oursByName]);
    // Core's notice about one of its own built-in jobs is not this job's refusal...
    const other = '{"jobId":"22222222-bbbb","name":"Memory Dreaming Promotion","msg":"cron: automation has no recorded inference account; run openclaw doctor --fix"}';
    expect(runtimeRefusalLines([other], job)).toEqual([]);
    // ...and is still surfaced as an observation instead of being dropped.
    expect(otherJobAccountNotices([other, ours, exact], job)).toEqual([other]);
  });

  test("tripwire classification: only OpenClaw's own background hosts are tolerated as refused attempts", () => {
    const entries: TripwireEntry[] = [
      { pid: 1, event: "armed" },
      { pid: 1, event: "blocked-lookup", host: "clawhub.ai" },
      { pid: 1, event: "blocked-connect", host: "telemetry.openclaw.ai", port: 443 },
    ];
    expect(tripwireBlocked(entries)).toHaveLength(2);
    expect(unexpectedBlocked(entries)).toEqual([]);
    for (const host of ["api.anthropic.com", "console.anthropic.com", "claude.ai", "192.0.2.1", "evil.clawhub.ai.example"]) {
      const withHost: TripwireEntry[] = [...entries, { pid: 2, event: "blocked-connect", host, port: 443 }];
      expect(unexpectedBlocked(withHost)).toEqual([{ pid: 2, event: "blocked-connect", host, port: 443 }]);
    }
  });

  test("the binding probe reports any set key that names a binding", () => {
    expect(keyPathsMatching({ payload: { model: MODEL_REF }, state: {} }, /binding/i)).toEqual([]);
    expect(
      keyPathsMatching({ payload: { inferenceBinding: { profileId: "anthropic:x" } } }, /binding/i),
    ).toEqual(["payload.inferenceBinding"]);
    expect(keyPathsMatching({ payload: { inferenceBinding: null } }, /binding/i)).toEqual([]);
  });

  test("CLI JSON is read even when notices precede it", () => {
    expect(parseCliJson('{"id":"a"}')).toEqual({ id: "a" });
    expect(parseCliJson('warning: no --agent given\n{\n  "id": "a"\n}\n')).toEqual({ id: "a" });
    expect(() => parseCliJson("no json here")).toThrow(/no JSON document/);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the gateway child. CI job / remote test runner only.
// ---------------------------------------------------------------------------

describe.skipIf(GATE_ON)("#155 route evidence: NOT RUN here", () => {
  test.skip("gateway-child scenarios S0-S3 need MC155_GATEWAY_ROUTE=1 (CI job cron-route-evidence-155); a skip is not a pass", () => {});
});

describe.skipIf(!GATE_ON)("#155 route evidence against a throwaway gateway child", () => {
  const version = installedOpenClawVersion();
  const evidence: Record<string, unknown> = {
    issue: "Drakon-Systems-Ltd/multi-clawd#155",
    openclaw: version,
    node: process.version,
    model: MODEL_REF,
    note: "Evidence only. Does not close #155; the reported case stays refused upstream (see S0).",
  };
  const gateways: GatewayChild[] = [];
  const jobArgs = (name: string) => [
    "add",
    "--name",
    name,
    "--agent",
    "main",
    // Far-future schedule: the only run is the one this test forces.
    "--cron",
    "0 0 1 1 *",
    "--session",
    "isolated",
    "--message",
    JOB_MESSAGE,
    "--model",
    MODEL_REF,
    "--no-deliver",
    "--light-context",
    "--timeout-seconds",
    "120",
    "--json",
  ];

  afterAll(async () => {
    for (const gateway of gateways) await stopGateway(gateway);
    const out = process.env.MC155_EVIDENCE_OUT;
    if (out) writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  });

  test("the OpenClaw under test is the one the matrix asked for, and has the #155 binder", () => {
    const expected = process.env.MULTI_CLAWD_EXPECT_OPENCLAW;
    if (expected) expect(version).toBe(expected);
    // Fail, never skip: an older OpenClaw has no admission binder, so S0 could not be armed.
    expect(compareCalVer(version, MIN_BINDER_OPENCLAW)).toBeGreaterThanOrEqual(0);
  });

  describe("M0: plugin as built, no operator config", () => {
    let gateway: GatewayChild;
    beforeAll(async () => {
      gateway = await startGateway("M0");
      gateways.push(gateway);
      await waitForGateway(gateway);
    }, 240_000);
    afterAll(async () => {
      if (gateway) await stopGateway(gateway);
    }, 60_000);

    test("S0 (armed control): `cron add --model clawd/...` is refused with the #155 text", () => {
      const result = cron(gateway, jobArgs("mc155-s0"));
      evidence.S0 = { status: result.status, stderr: result.stderr.trim(), stdout: result.stdout.trim() };
      expect(isAdmissionRefusal155(result), `${result.stdout}\n${result.stderr}\n${gatewayLogs(gateway)}`).toBe(true);
      // Nothing was stored and nothing was launched.
      const list = cron(gateway, ["list", "--all", "--json"]);
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).not.toContain("mc155-s0");
      expect(readJsonl<FakeLaunch>(gateway.scratch.launchLog)).toEqual([]);
    }, 180_000);

    test("M0 isolation: tripwire armed in the gateway, nothing non-loopback attempted", async () => {
      await stopGateway(gateway);
      const entries = readJsonl<TripwireEntry>(gateway.scratch.tripwireLog);
      evidence.M0_tripwire = {
        armedProcesses: entries.filter((e) => e.event === "armed").length,
        refusedOpenClawBackgroundAttempts: tripwireBlocked(entries),
        unexpectedRefusedAttempts: unexpectedBlocked(entries),
      };
      evidence.M0_missing_modelProvider_notice = gatewayLogs(gateway).includes(MISSING_MODEL_PROVIDER_FRAGMENT);
      expect(entries.some((e) => e.event === "armed" && e.pid === gateway.child.pid)).toBe(true);
      expect(unexpectedBlocked(entries)).toEqual([]);
    }, 60_000);
  });

  describe("M1: fixture modelProvider = own backend id, operator agentRuntime on the pool model", () => {
    let gateway: GatewayChild;
    let jobId = "";
    let runOutput = "";
    beforeAll(async () => {
      gateway = await startGateway("M1");
      gateways.push(gateway);
      await waitForGateway(gateway);
    }, 240_000);
    afterAll(async () => {
      if (gateway) await stopGateway(gateway);
    }, 60_000);

    test("S1: `cron add` is admitted and the stored job carries no inference binding", () => {
      const result = cron(gateway, jobArgs("mc155-s1"));
      expect(result.status, `${result.stdout}\n${result.stderr}\n${gatewayLogs(gateway)}`).toBe(0);
      // The S0 control is not vacuous: the same matcher rejects this admitted result.
      expect(isAdmissionRefusal155(result)).toBe(false);
      const added = parseCliJson(result.stdout) as { id?: string; job?: { id?: string } };
      jobId = added.id ?? added.job?.id ?? "";
      expect(jobId, result.stdout).not.toBe("");
      const got = cron(gateway, ["get", jobId, "--json"]);
      expect(got.status, got.stderr).toBe(0);
      const job = parseCliJson(got.stdout);
      evidence.S1 = { jobId, job };
      expect(JSON.stringify(job)).toContain(MODEL_REF);
      expect(keyPathsMatching(job, /binding|profile/i)).toEqual([]);
      expect(readJsonl<FakeLaunch>(gateway.scratch.launchLog)).toEqual([]);
    }, 180_000);

    test("S2: `cron run --wait` launches the fake Claude once, on a pool account, in scratch", () => {
      expect(jobId).not.toBe("");
      expect(accountDirsAreEmpty(gateway.scratch, (dir) => readdirSync(dir).filter((n) => n === ".credentials.json"))).toBe(true);
      const run = cron(gateway, ["run", jobId, "--wait", "--wait-timeout", "4m", "--poll-interval", "1s"], 300_000);
      const runs = cron(gateway, ["runs", jobId, "--json"]);
      runOutput = `${run.stdout}\n${run.stderr}\n${runs.stdout}\n${runs.stderr}`;
      const launches = readJsonl<FakeLaunch>(gateway.scratch.launchLog);
      evidence.S2 = {
        runStatus: run.status,
        run: run.stdout.trim(),
        runStderr: run.stderr.trim(),
        runs: runs.stdout.trim(),
        launches,
      };
      const context = `${runOutput}\n${gatewayLogs(gateway)}`;
      expect(routeEvidenceProblems(launches, gateway.scratch), context).toEqual([]);
      expect((POOL_ACCOUNTS as readonly string[]).includes(launches[0]!.account_id ?? "")).toBe(true);
      // `cron run --wait` exits 0 only for completionStatus "succeeded".
      expect(run.status, context).toBe(0);
      const waited = parseCliJson(run.stdout) as {
        status?: string;
        completionStatus?: string;
        run?: { jobId?: string; provider?: string; model?: string; summary?: string; error?: string };
      };
      expect(waited).toMatchObject({ status: "ok", completionStatus: "succeeded" });
      expect(waited.run).toMatchObject({ jobId, provider: POOL_ID, model: CLAUDE_MODEL_ID });
      expect(waited.run?.error).toBeUndefined();
      // The fake echoes its stdin as the result, so the recorded summary is the
      // prompt core built around this job's message.
      expect(waited.run?.summary ?? "").toContain(JOB_MESSAGE);
    }, 420_000);

    test("S3: no run-time \"no recorded inference account\" refusal in the run output or the gateway log", async () => {
      expect(runOutput).not.toBe("");
      await stopGateway(gateway);
      const sources: Record<string, string> = {
        "cron run/runs output": runOutput,
        "gateway stdout+stderr": gatewayLogs(gateway),
        "gateway file log": existsSync(gateway.scratch.gatewayFileLog)
          ? readFileSync(gateway.scratch.gatewayFileLog, "utf8")
          : "",
        ...collectLogs(gateway.scratch),
      };
      const job = { id: jobId, name: "mc155-s1" };
      const lines = runtimeRefusalLines(Object.values(sources), job);
      evidence.S3 = {
        sourcesChecked: Object.keys(sources),
        runtimeRefusalLinesForThisJob: lines,
        // Observation only: core's account-check notices about OTHER jobs
        // (its own built-ins), which show the detector reads the right log.
        accountNoticesAboutOtherJobs: otherJobAccountNotices(Object.values(sources), job),
      };
      // The gateway's own file log must be in scratch and must have recorded
      // this run, or an empty result here proves nothing.
      expect(sources["gateway file log"]).toContain(jobId);
      expect(lines).toEqual([]);
    }, 60_000);

    test("M1 isolation: tripwire armed in the gateway and the fake, nothing non-loopback attempted", () => {
      const entries = readJsonl<TripwireEntry>(gateway.scratch.tripwireLog);
      const launches = readJsonl<FakeLaunch>(gateway.scratch.launchLog);
      evidence.M1_tripwire = {
        armedProcesses: entries.filter((e) => e.event === "armed").length,
        // Observation, not asserted: the backend clears NODE_OPTIONS for the
        // process it starts, so the shim between the gateway and the fake is
        // not expected to carry the tripwire.
        shimArmed: entries.some((e) => e.event === "armed" && e.script === "shim.js"),
        refusedOpenClawBackgroundAttempts: tripwireBlocked(entries),
        unexpectedRefusedAttempts: unexpectedBlocked(entries),
      };
      evidence.M1_missing_modelProvider_notice = gatewayLogs(gateway).includes(MISSING_MODEL_PROVIDER_FRAGMENT);
      expect(entries.some((e) => e.event === "armed" && e.pid === gateway.child.pid)).toBe(true);
      expect(launches).toHaveLength(1);
      for (const launch of launches) {
        expect(entries.some((e) => e.event === "armed" && e.pid === launch.pid)).toBe(true);
      }
      expect(unexpectedBlocked(entries)).toEqual([]);
    });
  });
});

/**
 * Every .log/.jsonl file the gateway wrote under its scratch home, state and
 * temp dirs, by path relative to the scratch root. The plugin directory (a
 * copy of this repository's build) and core's plugin captures are not gateway
 * output and are left out.
 */
function collectLogs(scratch: GatewayChild["scratch"]): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "plugin-captures") continue;
        walk(path, depth + 1);
      } else if (entry.isFile() && /\.(log|jsonl)$/.test(entry.name)) {
        found[path.slice(scratch.root.length + 1)] = readFileSync(path, "utf8");
      }
    }
  };
  for (const dir of [scratch.home, scratch.state, scratch.tmp, scratch.work]) walk(dir, 0);
  return found;
}
