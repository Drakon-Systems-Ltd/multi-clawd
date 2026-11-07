import { beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BILLING_REFUSAL_ERROR_KIND,
  clearBillingRefusal,
  mergeHealthStates,
  parseAuthFailure,
  parseBillingRefusal,
  parseModelLimitError,
  parseStoredState,
  parseTransientApiError,
  recordBillingRefusal,
  type AccountHealthState,
} from "../src/shim-core";
import {
  BILLING_REFUSED_TTL_MS,
  allCredentialFailed,
  billingRefusalFor,
  choosePoolAccount,
  classifyAccountHealth,
  fallbackPoolAccount,
  pickPoolAccountForLaunch,
  type PoolVerdict,
} from "../src/health";
import { chooseRetryAccount, RETRY_ROSTER_ENV } from "../src/retry-plan";
import { planDirectOrder } from "../src/direct-route";
import { renderExplanation } from "../src/explain-core";
import { readHistory } from "../src/history";
import { cleanShimEnv } from "./shim-env";

/**
 * #126 — a billing refusal (the provider will not serve this account because
 * its credit balance is too low) is an ACCOUNT-level fault: no model can be
 * served and no window reset will change that. It used to be forwarded as an
 * ordinary error with nothing recorded, so selection kept choosing the same
 * account and the in-turn retry never fired.
 *
 * Evidence basis (no live calls were made, no credential read): the public
 * @anthropic-ai/claude-code package, builds 2.1.316, 2.1.317 and 2.1.318.
 * Its stream-json `assistant` record carries a TYPED top-level `error` kind
 * drawn from the enum authentication_failed | oauth_org_not_allowed |
 * account_on_hold | verification_required | billing_error | rate_limit |
 * overloaded | invalid_request | model_not_found | server_error | unknown |
 * max_output_tokens | cloud_credential_error — the same enum the CLI's
 * StopFailure hook exposes as its matcher values. `billing_error` is produced
 * for exactly one condition in that source: the API's HTTP 400
 * invalid_request_error "Your credit balance is too low to access the
 * Anthropic API. Please go to Plans & Billing to upgrade or purchase
 * credits.", which the CLI reports as "Credit balance too low · Add funds:
 * https://platform.claude.com/settings/billing". The 2.1.76 build has no such
 * kind, so the marker is version-scoped like `usage_limit_reached` (#68).
 *
 * Only the typed kind is matched. The wording is not: it is the CLI's
 * fallback text and it has changed between builds.
 */

const ROOT = join(__dirname, "..");
const SHIM = join(ROOT, "dist", "shim.js");
const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--model", "claude-fable-5-1"];
const MODEL = "claude-fable-5-1";

const BILLING_TEXT = "Credit balance too low · Add funds: https://platform.claude.com/settings/billing";
const LIMIT_TEXT = "You've reached your Fable 5 limit. /model to switch models.";
const NOW = 1_784_600_000_000;

function synthetic(extra: Record<string, unknown>, text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
    is_api_error_message: true,
    session_id: "s1",
    ...extra,
  });
}

function errorResult(extra: Record<string, unknown>, text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: text,
    session_id: "s1",
    ...extra,
  });
}

const BILLING_NOTICE = synthetic({ error: "billing_error", api_error_status: 400 }, BILLING_TEXT);

describe("parseBillingRefusal (#126)", () => {
  test("the typed kind on the CLI's synthetic notice is a billing refusal", () => {
    expect(BILLING_REFUSAL_ERROR_KIND).toBe("billing_error");
    const hit = parseBillingRefusal(BILLING_NOTICE);
    expect(hit).toMatchObject({ kind: "billing_error", status: 400 });
    expect(hit?.reason).toContain("billing_error");
  });

  test("the typed kind is recognised whatever the wording, on either error record", () => {
    expect(parseBillingRefusal(synthetic({ error: "billing_error" }, "API Error: x"))).toMatchObject({
      kind: "billing_error",
    });
    expect(parseBillingRefusal(errorResult({ error: "billing_error", api_error_status: 400 }, "API Error: x")))
      .toMatchObject({ kind: "billing_error", status: 400 });
  });

  test("the wording ALONE is never a billing refusal — only the marker is matched", () => {
    // The CLI's own text, with no typed kind: forwarded as an ordinary error.
    expect(parseBillingRefusal(synthetic({ api_error_status: 400 }, BILLING_TEXT))).toBeUndefined();
    expect(parseBillingRefusal(errorResult({ api_error_status: 400 }, BILLING_TEXT))).toBeUndefined();
    // The API's raw wording, likewise.
    expect(
      parseBillingRefusal(
        errorResult({}, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."),
      ),
    ).toBeUndefined();
    // A 402 with billing-flavoured text but no kind: still not ours to classify.
    expect(parseBillingRefusal(errorResult({ api_error_status: 402 }, "Payment Required"))).toBeUndefined();
  });

  test("a non-error record carrying the kind or the text is model output, not a refusal", () => {
    expect(parseBillingRefusal(JSON.stringify({ type: "result", result: BILLING_TEXT }))).toBeUndefined();
    expect(parseBillingRefusal(JSON.stringify({ type: "result", result: "billing_error" }))).toBeUndefined();
    expect(
      parseBillingRefusal(
        JSON.stringify({ type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "x" }] } }),
      ),
    ).toBeUndefined();
    // Another typed kind is not a billing refusal.
    expect(parseBillingRefusal(synthetic({ error: "invalid_request", api_error_status: 400 }, BILLING_TEXT))).toBeUndefined();
    expect(parseBillingRefusal(synthetic({ error: "rate_limit", api_error_status: 429 }, "x"))).toBeUndefined();
    expect(parseBillingRefusal("not json")).toBeUndefined();
    expect(parseBillingRefusal('{"type":"system","subtype":"init"}')).toBeUndefined();
  });

  test("a billing refusal is neither a transient, nor an auth failure, nor a model limit", () => {
    for (const status of [400, 402, 429, 500, 529]) {
      const line = synthetic({ error: "billing_error", api_error_status: status }, BILLING_TEXT);
      expect(parseBillingRefusal(line), `@${status}`).toBeDefined();
      expect(parseTransientApiError(line), `@${status}`).toBeUndefined();
      expect(parseAuthFailure(line), `@${status}`).toBeUndefined();
      expect(parseModelLimitError(line), `@${status}`).toBeUndefined();
    }
    // Even auth-flavoured wording under the billing kind stays a billing refusal.
    const authWorded = synthetic({ error: "billing_error", api_error_status: 400 }, "Please run /login");
    expect(parseBillingRefusal(authWorded)).toBeDefined();
    expect(parseAuthFailure(authWorded)).toBeUndefined();
  });

  test("a spent window and a dead login are not billing refusals", () => {
    expect(parseBillingRefusal(synthetic({ error: "rate_limit", api_error_status: 429, api_error: "usage_limit_reached" }, LIMIT_TEXT))).toBeUndefined();
    expect(parseBillingRefusal(synthetic({ error: "authentication_failed", api_error_status: 401 }, "Please run /login"))).toBeUndefined();
  });

  test("the reason is capped so a giant error body cannot bloat the state file", () => {
    const hit = parseBillingRefusal(synthetic({ error: "billing_error" }, "x".repeat(5000)));
    expect(hit?.reason.length).toBeLessThanOrEqual(200);
  });
});

describe("billing record persistence (#126)", () => {
  const base: AccountHealthState = { accountId: "claw1", windows: {} };
  const refusal = { kind: "billing_error" as const, status: 400, reason: "billing_error: Credit balance too low" };

  test("recordBillingRefusal stamps kind, reason and time; clear writes an explicit ok record", () => {
    const refused = recordBillingRefusal(base, refusal, NOW);
    expect(refused.billing).toEqual({ status: "refused", kind: "billing_error", reason: refusal.reason, seenAt: NOW });
    expect(refused.updatedAt).toBe(NOW);
    const cleared = clearBillingRefusal(refused, NOW + 1000);
    expect(cleared.billing).toEqual({ status: "ok", seenAt: NOW + 1000 });
  });

  test("round-trips through the state file; a malformed record is dropped, never fatal", () => {
    const refused = recordBillingRefusal(base, refusal, NOW);
    expect(parseStoredState(JSON.stringify(refused))?.billing).toEqual(refused.billing);
    expect(parseStoredState(JSON.stringify({ ...base, billing: { status: "weird", seenAt: NOW } }))?.billing).toBeUndefined();
    expect(parseStoredState(JSON.stringify({ ...base, billing: "nope" }))?.billing).toBeUndefined();
    // Files written before this feature parse fine.
    expect(parseStoredState(JSON.stringify(base))?.billing).toBeUndefined();
  });

  test("merge keeps the newer record, so a later success clears a disk refusal and not vice versa", () => {
    const disk = recordBillingRefusal(base, refusal, NOW);
    const live = clearBillingRefusal(base, NOW + 60_000);
    expect(mergeHealthStates(disk, live).billing?.status).toBe("ok");
    expect(mergeHealthStates(live, disk).billing?.status).toBe("ok");
    const olderLive = clearBillingRefusal(base, NOW - 60_000);
    expect(mergeHealthStates(disk, olderLive).billing?.status).toBe("refused");
  });

  test("a refusal beyond the retention horizon is pruned: the reader stopped honouring it long before", () => {
    const disk = recordBillingRefusal(base, refusal, NOW - 15 * 24 * 3600 * 1000);
    expect(mergeHealthStates(disk, base, NOW).billing).toBeUndefined();
    const recent = recordBillingRefusal(base, refusal, NOW - 60_000);
    expect(mergeHealthStates(recent, base, NOW).billing?.status).toBe("refused");
  });

  test("the credential record is untouched by a billing record and vice versa", () => {
    const both: AccountHealthState = {
      ...recordBillingRefusal(base, refusal, NOW),
      credential: { status: "ok", seenAt: NOW },
    };
    const merged = mergeHealthStates(both, base, NOW);
    expect(merged.credential).toEqual({ status: "ok", seenAt: NOW });
    expect(merged.billing?.status).toBe("refused");
  });
});

describe("classification: a billing refusal is an account-level cooldown (#126)", () => {
  const refusal = { kind: "billing_error" as const, status: 400, reason: "billing_error: Credit balance too low" };
  const healthyWindows: AccountHealthState["windows"] = {
    "usage:five_hour": { status: "allowed", utilization: 0.1, seenAt: NOW - 1000, resetsAt: NOW / 1000 + 3600 },
  };

  test("quota `allowed` cannot rescue a billing-refused account, for any model", () => {
    const state = recordBillingRefusal({ accountId: "claw1", windows: healthyWindows }, refusal, NOW - 60_000);
    for (const model of [MODEL, "claude-opus-5-5", undefined]) {
      const health = classifyAccountHealth(state, {}, NOW, model);
      expect(health.verdict, String(model)).toBe("billing_refused");
      expect(health.resumeAt).toBe(NOW - 60_000 + BILLING_REFUSED_TTL_MS);
      expect(health.observedAt).toBe(NOW - 60_000);
      expect(health.reason).toContain("billing");
    }
  });

  test("the cooldown is bounded: past the TTL the account reads by its quota again", () => {
    const state = recordBillingRefusal({ accountId: "claw1", windows: healthyWindows }, refusal, NOW - BILLING_REFUSED_TTL_MS - 1);
    expect(classifyAccountHealth(state, {}, NOW, MODEL).verdict).toBe("ok");
    expect(billingRefusalFor(state, NOW)).toBeUndefined();
    // At the edge it still binds.
    const edge = recordBillingRefusal({ accountId: "claw1", windows: healthyWindows }, refusal, NOW - BILLING_REFUSED_TTL_MS);
    expect(classifyAccountHealth(edge, {}, NOW, MODEL).verdict).toBe("billing_refused");
  });

  test("an explicit ok record does not bind, and is not quota evidence either", () => {
    const state = clearBillingRefusal({ accountId: "claw1", windows: {} }, NOW);
    // No windows: `no_data`, not `ok` — an ok billing record is not telemetry.
    expect(classifyAccountHealth(state, {}, NOW, MODEL).verdict).toBe("no_data");
    expect(billingRefusalFor(state, NOW)).toBeUndefined();
    const withQuota = clearBillingRefusal({ accountId: "claw1", windows: healthyWindows }, NOW);
    expect(classifyAccountHealth(withQuota, {}, NOW, MODEL).verdict).toBe("ok");
  });

  test("a dead login still outranks a billing refusal: the operator's fix differs", () => {
    const state: AccountHealthState = {
      ...recordBillingRefusal({ accountId: "claw1", windows: {} }, refusal, NOW),
      credential: { status: "failed", reason: "fixture", seenAt: NOW },
    };
    expect(classifyAccountHealth(state, {}, NOW, MODEL).verdict).toBe("credential_failed");
  });

  test("a billing refusal outranks a model-scoped rejection: no window reset ends it", () => {
    const state: AccountHealthState = recordBillingRefusal(
      {
        accountId: "claw1",
        windows: { [`model:${MODEL}`]: { status: "rejected", seenAt: NOW - 1000, resetsAt: NOW / 1000 + 3600 } },
      },
      refusal,
      NOW,
    );
    expect(classifyAccountHealth(state, {}, NOW, MODEL).verdict).toBe("billing_refused");
  });
});

describe("pool selection vocabulary (#126)", () => {
  const v = (id: string, verdict: PoolVerdict["verdict"], extra: Partial<PoolVerdict> = {}): PoolVerdict => ({ id, verdict, ...extra });

  test("a billing-refused member is never chosen, in any strategy", () => {
    for (const strategy of ["ordered", "reset-aware", "spread"] as const) {
      expect(choosePoolAccount([v("claw1", "billing_refused"), v("claw2", "ok")], strategy)).toBe("claw2");
      expect(choosePoolAccount([v("claw1", "billing_refused"), v("claw2", "no_data")], strategy)).toBe("claw2");
      expect(choosePoolAccount([v("claw1", "billing_refused"), v("claw2", "near_limit", { utilization: 0.9 })], strategy)).toBe("claw2");
      expect(choosePoolAccount([v("claw1", "billing_refused")], strategy)).toBeUndefined();
    }
  });

  test("as a last resort it ranks behind an exhausted account and ahead of a dead login", () => {
    expect(fallbackPoolAccount([v("claw1", "billing_refused"), v("claw2", "exhausted")], NOW)).toBe("claw2");
    expect(fallbackPoolAccount([v("claw1", "credential_failed"), v("claw2", "billing_refused")], NOW)).toBe("claw2");
    // Wholly billing-refused: the launch still goes somewhere, so it fails for
    // real and the host's chain moves on.
    expect(fallbackPoolAccount([v("claw1", "billing_refused"), v("claw2", "billing_refused")], NOW)).toBe("claw1");
    expect(pickPoolAccountForLaunch([v("claw1", "billing_refused"), v("claw2", "billing_refused")], NOW)).toBe("claw1");
  });

  test("it does not count toward the all-logins-dead hard error: the account can authenticate", () => {
    expect(allCredentialFailed([v("claw1", "billing_refused"), v("claw2", "credential_failed")])).toBe(false);
  });

  test("the in-turn retry skips a sibling inside its billing cooldown and takes one past it", () => {
    const roster = [{ id: "claw2", stateFile: "/dev/null", env: {} }];
    const refused = recordBillingRefusal({ accountId: "claw2", windows: {} }, { kind: "billing_error", reason: "r" }, NOW - 60_000);
    expect(chooseRetryAccount({ roster, readState: () => refused, modelId: MODEL, nowMs: NOW })).toBeUndefined();
    expect(chooseRetryAccount({ roster, readState: () => refused, modelId: MODEL, nowMs: NOW + BILLING_REFUSED_TTL_MS })?.id).toBe("claw2");
  });

  test("the direct Anthropic route ranks it behind exhausted and ahead of a rejected login", () => {
    const m = (accountId: string, verdict: PoolVerdict["verdict"]) => ({ accountId, profileId: `anthropic:${accountId}`, verdict });
    const plan = planDirectOrder({
      members: [m("a", "credential_failed"), m("b", "credential_unverified"), m("c", "billing_refused"), m("d", "exhausted"), m("e", "ok")],
      nowMs: NOW,
    });
    expect(plan?.order).toEqual(["anthropic:e", "anthropic:d", "anthropic:c", "anthropic:b", "anthropic:a"]);
  });
});

describe("explain tells the operator what to fix (#126)", () => {
  test("the verdict has its own words, distinct from exhaustion and from a dead login", () => {
    const text = renderExplanation({
      accounts: [{ id: "claw1" }, { id: "claw2" }],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      chain: {},
      health: [
        { id: "claw1", verdict: "billing_refused", detail: "billing refused by the provider 2m ago" },
        { id: "claw2", verdict: "ok" },
      ],
      nowMs: NOW,
    } as Parameters<typeof renderExplanation>[0]);
    expect(text).toMatch(/claw1: BILLING REFUSED/);
    expect(text).not.toMatch(/claw1: EXHAUSTED/);
    expect(text).not.toMatch(/claw1: LOGIN REJECTED/);
    expect(text).toContain("billing refused by the provider 2m ago");
  });
});

// ── integration: the compiled shim against the fixture CLI ──────────────────

beforeAll(() => {
  expect(existsSync(SHIM)).toBe(true);
});

function scenario(opts: {
  roster?: Array<{ id: string; stateFile: string; env: Record<string, string> }>;
  billingFor?: string;
  shape?: "typed" | "untyped";
  claw1State?: AccountHealthState;
  claw2State?: AccountHealthState;
  /** Extra fixture controls (limit / other-kind modes, exit codes, status overrides). */
  extraEnv?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-126-"));
  const claw1State = join(dir, "claw1.json");
  const claw2State = join(dir, "claw2.json");
  if (opts.claw1State) writeFileSync(claw1State, JSON.stringify(opts.claw1State));
  if (opts.claw2State) writeFileSync(claw2State, JSON.stringify(opts.claw2State));
  const env: NodeJS.ProcessEnv = {
    ...cleanShimEnv(),
    MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, FAKE]),
    MULTI_CLAWD_STATE_FILE: claw1State,
    MULTI_CLAWD_ACCOUNT_ID: "claw1",
    FAKE_CLAUDE_EXIT: "0",
  };
  if (opts.billingFor !== undefined) env.FAKE_CLAUDE_BILLING_FOR_ACCOUNT = opts.billingFor;
  if (opts.shape === "untyped") env.FAKE_CLAUDE_BILLING_SHAPE = "untyped";
  if (opts.roster) env[RETRY_ROSTER_ENV] = JSON.stringify(opts.roster);
  Object.assign(env, opts.extraEnv ?? {});
  const res = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], { input: "the prompt\n", encoding: "utf8", env });
  return { res, claw1State, claw2State, env, dir };
}

/** The fixture CLI run DIRECTLY with the shim's env, for byte-for-byte passthrough assertions. */
function directFixtureStdout(env: NodeJS.ProcessEnv): string {
  const childEnv = { ...env, MULTI_CLAWD_ACCOUNT_ID: "claw1" };
  delete childEnv[RETRY_ROSTER_ENV];
  return spawnSync(process.execPath, [FAKE, ...STREAM_ARGS], { input: "the prompt\n", encoding: "utf8", env: childEnv }).stdout;
}

function rosterFor(claw2State: string) {
  return [{ id: "claw2", stateFile: claw2State, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-two" } }];
}

function records(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readState(file: string): AccountHealthState {
  return JSON.parse(readFileSync(file, "utf8")) as AccountHealthState;
}

describe("in-turn hop and account cooldown on a billing refusal (#126)", () => {
  test("the turn is served by the sibling; the refusing account is benched for billing, not quota or login", () => {
    const { res, claw1State, claw2State } = scenario({ billingFor: "claw1", roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-126s-")), "claw2.json")) });
    void claw2State;
    expect(res.stdout).not.toContain("Credit balance");
    expect(res.stdout).not.toContain("<synthetic>");
    const result = records(res.stdout).find((r) => r.type === "result");
    expect(result?.served_by).toBe("claw2");
    expect(result?.config_dir).toBe("/tmp/claude-two");
    expect(result?.result).toBe("the prompt");
    expect(records(res.stdout).filter((r) => r.type === "system")).toHaveLength(1);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("billing refusal recorded for claw1");
    expect(res.stderr).toContain("retrying this turn on claw2");
    const state = readState(claw1State);
    expect(state.billing).toMatchObject({ status: "refused", kind: "billing_error" });
    expect(state.credential?.status).not.toBe("failed");
    expect(state.windows[`model:${MODEL}`]).toBeUndefined();
    // The journal names the cause.
    const history = readHistory(join(claw1State, "..", "history.jsonl"));
    expect(history.find((e) => e.kind === "retry")).toMatchObject({ accountId: "claw1", toAccountId: "claw2", reason: "billing" });
  });

  test("the recorded cooldown then keeps the account out of the next selection", () => {
    const { claw1State } = scenario({ billingFor: "claw1", roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-126s-")), "claw2.json")) });
    const health = classifyAccountHealth(readState(claw1State), {}, Date.now(), MODEL);
    expect(health.verdict).toBe("billing_refused");
    expect(health.resumeAt).toBeGreaterThan(Date.now());
  });

  test("a sibling inside its own billing cooldown is not retried onto: the failure passes through unchanged", () => {
    const { res, claw1State, claw2State, env } = scenario({
      billingFor: "claw1",
      roster: [],
      claw2State: recordBillingRefusal({ accountId: "claw2", windows: {} }, { kind: "billing_error", reason: "r" }, Date.now()),
    });
    const roster = rosterFor(claw2State);
    env[RETRY_ROSTER_ENV] = JSON.stringify(roster);
    const again = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], { input: "the prompt\n", encoding: "utf8", env });
    void res;
    expect(again.stderr).toContain("no healthy sibling to retry onto");
    expect(again.stdout).toBe(directFixtureStdout(env));
    expect(again.status).toBe(1);
    expect(readState(claw1State).billing?.status).toBe("refused");
    expect(readState(claw2State).billing?.status).toBe("refused");
  });

  test("with no sibling the refusal is forwarded byte-for-byte, exit code kept, and still recorded", () => {
    const { res, claw1State, env } = scenario({ billingFor: "claw1" });
    expect(res.stdout).toBe(directFixtureStdout(env));
    expect(res.stdout).toContain('"error":"billing_error"');
    expect(res.status).toBe(1);
    expect(readState(claw1State).billing).toMatchObject({ status: "refused", kind: "billing_error" });
  });

  test("the same wording WITHOUT the typed kind is an ordinary error: nothing recorded, no retry", () => {
    const { res, claw1State, env } = scenario({
      billingFor: "claw1",
      shape: "untyped",
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-126s-")), "claw2.json")),
    });
    expect(res.stdout).toBe(directFixtureStdout(env));
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain("retrying this turn");
    if (existsSync(claw1State)) expect(readState(claw1State).billing).toBeUndefined();
  });

  test("a successful turn on the account ends the cooldown early", () => {
    const refused = recordBillingRefusal({ accountId: "claw1", windows: {} }, { kind: "billing_error", reason: "r" }, Date.now() - 60_000);
    const { res, claw1State } = scenario({ claw1State: refused });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("billing recovered for claw1");
    expect(readState(claw1State).billing?.status).toBe("ok");
    expect(classifyAccountHealth(readState(claw1State), {}, Date.now(), MODEL).verdict).not.toBe("billing_refused");
  });

  test("a refusal that exits 0 is not a success: a model limit with exit code 0 keeps the billing cooldown", () => {
    // Review finding: the CLI can exit 0 having delivered a refusal as its
    // result. The clear used to key on the exit code and the absence of a
    // billing refusal in the stream, so a model-limit turn that exited 0
    // overwrote a live cooldown with `ok` and logged a recovery that never
    // happened. Only a real (non-error) result ends the cooldown early.
    const refused = recordBillingRefusal({ accountId: "claw1", windows: {} }, { kind: "billing_error", reason: "r" }, Date.now() - 60_000);
    const { res, claw1State, env } = scenario({
      claw1State: refused,
      extraEnv: { FAKE_CLAUDE_LIMIT_FOR_ACCOUNT: "claw1", FAKE_CLAUDE_LIMIT_EXIT: "0" },
    });
    void env;
    expect(res.status).toBe(0);
    // The limit is forwarded as the limit (its status tag is the #97 marker,
    // not a hop): no sibling served this turn and no success result exists.
    const result = records(res.stdout).find((r) => r.type === "result");
    expect(result?.is_error).toBe(true);
    expect(result?.served_by).toBeUndefined();
    expect(res.stderr).not.toContain("billing recovered");
    expect(res.stderr).toContain("model limit hit recorded");
    const state = readState(claw1State);
    expect(state.billing).toMatchObject({ status: "refused", kind: "billing_error" });
    expect(classifyAccountHealth(state, {}, Date.now(), MODEL).verdict).toBe("billing_refused");
  });

  test("a plain 402 without the typed kind passes through the whole shim unchanged: nothing recorded, no hop", () => {
    const { res, claw1State, env } = scenario({
      billingFor: "claw1",
      shape: "untyped",
      extraEnv: { FAKE_CLAUDE_BILLING_STATUS: "402" },
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-126s-")), "claw2.json")),
    });
    expect(res.stdout).toBe(directFixtureStdout(env));
    expect(res.stdout).toContain('"api_error_status":402');
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain("retrying this turn");
    expect(res.stderr).not.toContain("billing refusal recorded");
    if (existsSync(claw1State)) {
      const state = readState(claw1State);
      expect(state.billing).toBeUndefined();
      expect(state.credential).toBeUndefined();
      expect(state.windows[`model:${MODEL}`]).toBeUndefined();
    }
  });

  test("another typed kind (invalid_request) passes through the whole shim unchanged: nothing recorded, no hop", () => {
    const { res, claw1State, env } = scenario({
      extraEnv: { FAKE_CLAUDE_ERROR_KIND_FOR_ACCOUNT: "claw1" },
      roster: rosterFor(join(mkdtempSync(join(tmpdir(), "mc-126s-")), "claw2.json")),
    });
    expect(res.stdout).toBe(directFixtureStdout(env));
    expect(res.stdout).toContain('"error":"invalid_request"');
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain("retrying this turn");
    expect(res.stderr).not.toContain("recorded");
    if (existsSync(claw1State)) {
      const state = readState(claw1State);
      expect(state.billing).toBeUndefined();
      expect(state.credential).toBeUndefined();
      expect(state.windows[`model:${MODEL}`]).toBeUndefined();
    }
  });

  test("a spent window on the sibling is still a candidate for the hop, as it is after a model limit", () => {
    // The refusing account is OUT (no credit) — a sibling the pool believes
    // spent but overdue a re-probe is the same trade a model limit makes (#26).
    const overdue: AccountHealthState = {
      accountId: "claw2",
      windows: { [`model:${MODEL}`]: { status: "rejected", seenAt: Date.now() - 48 * 3600 * 1000, resetsAt: Date.now() / 1000 + 4 * 24 * 3600 } },
    };
    const { res, claw2State, env } = scenario({ billingFor: "claw1", roster: [], claw2State: overdue });
    env[RETRY_ROSTER_ENV] = JSON.stringify(rosterFor(claw2State));
    void res;
    const again = spawnSync(process.execPath, [SHIM, ...STREAM_ARGS], { input: "the prompt\n", encoding: "utf8", env });
    expect(again.stderr).toContain("retrying this turn on claw2");
    expect(records(again.stdout).find((r) => r.type === "result")?.served_by).toBe("claw2");
  });
});
