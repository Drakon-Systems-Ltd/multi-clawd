/**
 * Runtime credential health (#8): the Claude CLI can reject an account's OAuth
 * session while every quota window still reads `allowed`. These cover the
 * dimension itself — parsing the failure out of the stream, persisting it,
 * clearing it, and the precedence it takes over quota at classification time.
 *
 * The pool WIRING for the same fix lives in pool-selection.test.ts; this file
 * is the vocabulary those wires carry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  clearCredentialFailure,
  mergeHealthStates,
  parseAuthFailure,
  parseStoredState,
  recordCredentialFailure,
  type AccountHealthState,
} from "../src/shim-core";
import {
  allCredentialFailed,
  choosePoolAccount,
  classifyAccountHealth,
  credentialFailureFor,
  fallbackPoolAccount,
  pickPoolAccountForLaunch,
  CREDENTIAL_FAILED_TTL_MS,
} from "../src/health";
import { renderExplanation } from "../src/explain-core";

const NOW = 1_784_600_000_000;
const NOW_S = NOW / 1000;

/** The live #8 record: HTTP 410 session_expired as the CLI reports it. */
const SESSION_EXPIRED_LINE = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  session_id: "s1",
});

/**
 * A SECOND real record, captured from the Claude CLI itself (2.1.224) by
 * running it against an empty config dir — see tests/fixtures/
 * cli-not-logged-in.jsonl for provenance. Every wording in
 * AUTH_FAILURE_PATTERNS was inferred from traces until now; this one is the
 * article, and it is not shaped the way you would guess: the envelope says
 * `subtype: "success"` and the separator is a middle dot, not a hyphen.
 */
const NOT_LOGGED_IN_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "cli-not-logged-in.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim());

describe("the real not-logged-in record (CLI 2.1.224)", () => {
  test("the result record is recognised as an auth failure", () => {
    const result = NOT_LOGGED_IN_FIXTURE.map(parseAuthFailure).filter(Boolean);
    expect(result).toContainEqual({ reason: "Not logged in · Please run /login" });
  });

  test("`subtype: success` does not stop it — is_error is what counts", () => {
    // The trap in the real shape: the CLI reports a failed turn under a
    // "success" subtype. A parser keyed on subtype alone reads this as a clean
    // turn and the account is never benched.
    const record = NOT_LOGGED_IN_FIXTURE.map((l) => JSON.parse(l)).find(
      (r) => r.type === "result",
    );
    expect(record.subtype).toBe("success");
    expect(record.is_error).toBe(true);
    expect(parseAuthFailure(JSON.stringify(record))).toBeTruthy();
  });

  test("it records as a credential failure, not a quota one", () => {
    const line = NOT_LOGGED_IN_FIXTURE.find((l) => parseAuthFailure(l))!;
    const state = recordCredentialFailure(
      { accountId: "claw2", windows: {} },
      parseAuthFailure(line)!.reason,
      NOW,
    );
    expect(classifyAccountHealth(state, {}, NOW).verdict).toBe("credential_failed");
  });
});

describe("parseAuthFailure", () => {
  test("recognises the real session_expired record and keeps the reason", () => {
    expect(parseAuthFailure(SESSION_EXPIRED_LINE)).toEqual({
      reason: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
  });

  test("recognises auth failures reported in an error object", () => {
    const line = JSON.stringify({
      type: "error",
      error: { message: "401 Unauthorized: invalid bearer token" },
    });
    expect(parseAuthFailure(line)?.reason).toContain("Unauthorized");
  });

  test("recognises a not-logged-in refusal", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in. Please run /login to authenticate.",
    });
    expect(parseAuthFailure(line)).toBeDefined();
  });

  test("a QUOTA failure is not an auth failure (the two must not blur)", () => {
    const limit = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "You've reached your Fable 5 limit. /model to switch models.",
    });
    expect(parseAuthFailure(limit)).toBeUndefined();
  });

  test("a bare resumed-session expiry is NOT a credential failure", () => {
    // Rotating accounts mid-conversation loses the CLI session, which lives in
    // the previous account's config dir; the resume fails with a session
    // expiry. Recording that would bench the account we just rotated TO —
    // exactly backwards. Only auth-specific wording counts.
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "session_expired: no conversation found with that session id",
    });
    expect(parseAuthFailure(line)).toBeUndefined();
  });

  test("a successful result quoting auth text does not trigger", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "The error means: Failed to authenticate — run /login.",
    });
    expect(parseAuthFailure(line)).toBeUndefined();
  });

  test("junk and non-error records pass through without throwing", () => {
    expect(parseAuthFailure("not json")).toBeUndefined();
    expect(parseAuthFailure('{"type":"assistant"}')).toBeUndefined();
    expect(parseAuthFailure("")).toBeUndefined();
  });

  test("the reason is capped so a giant error body cannot bloat the state file", () => {
    const line = JSON.stringify({
      type: "error",
      error: { message: `Failed to authenticate: ${"x".repeat(5000)}` },
    });
    expect(parseAuthFailure(line)!.reason.length).toBeLessThanOrEqual(200);
  });
});

describe("credential record persistence", () => {
  const base: AccountHealthState = { accountId: "claw1", windows: {} };

  test("recordCredentialFailure stamps status, reason and time", () => {
    const s = recordCredentialFailure(base, "OAuth session expired", NOW);
    expect(s.credential).toEqual({
      status: "failed",
      reason: "OAuth session expired",
      seenAt: NOW,
    });
    expect(s.updatedAt).toBe(NOW);
  });

  test("clearCredentialFailure writes an explicit ok record, not a deletion", () => {
    // A deleted field would LOSE the read-merge-write against the stale
    // "failed" still on disk, resurrecting the exclusion the clear ended.
    const failed = recordCredentialFailure(base, "dead", NOW);
    const cleared = clearCredentialFailure(failed, NOW + 1000);
    expect(cleared.credential).toEqual({ status: "ok", seenAt: NOW + 1000 });
  });

  test("round-trips through the state file", () => {
    const s = recordCredentialFailure(base, "OAuth session expired", NOW);
    const parsed = parseStoredState(JSON.stringify(s));
    expect(parsed?.credential).toEqual(s.credential);
  });

  test("a malformed credential record is dropped, never fatal", () => {
    const raw = JSON.stringify({
      accountId: "claw1",
      windows: { five_hour: { status: "allowed", seenAt: NOW } },
      credential: { status: "banana" },
    });
    const parsed = parseStoredState(raw);
    expect(parsed?.credential).toBeUndefined();
    expect(parsed?.windows.five_hour).toBeDefined(); // the rest survives
  });

  test("state files written before this feature parse fine (no credential key)", () => {
    const raw = JSON.stringify({
      accountId: "claw1",
      updatedAt: NOW,
      windows: { five_hour: { status: "allowed", seenAt: NOW } },
    });
    expect(parseStoredState(raw)?.credential).toBeUndefined();
  });

  test("merge keeps the newer record, so a later success clears a disk failure", () => {
    const disk = recordCredentialFailure({ accountId: "claw1", windows: {} }, "dead", NOW);
    const live = clearCredentialFailure({ accountId: "claw1", windows: {} }, NOW + 60_000);
    expect(mergeHealthStates(disk, live, NOW + 60_000).credential).toEqual({
      status: "ok",
      seenAt: NOW + 60_000,
    });
  });

  test("merge does not let an older live record undo a newer disk failure", () => {
    const disk = recordCredentialFailure({ accountId: "claw1", windows: {} }, "dead", NOW);
    const live = clearCredentialFailure({ accountId: "claw1", windows: {} }, NOW - 60_000);
    expect(mergeHealthStates(disk, live, NOW).credential?.status).toBe("failed");
  });

  test("a credential record beyond the retention horizon is pruned from the file", () => {
    const disk = recordCredentialFailure({ accountId: "claw1", windows: {} }, "dead", NOW);
    const later = NOW + 15 * 24 * 60 * 60 * 1000; // > PRUNE_AFTER_MS (14d)
    expect(mergeHealthStates(disk, { accountId: "claw1", windows: {} }, later).credential)
      .toBeUndefined();
  });
});

describe("credential health outranks quota in classification", () => {
  function withCredential(
    credential: AccountHealthState["credential"],
    windows: AccountHealthState["windows"] = {
      five_hour: { status: "allowed", utilization: 0.1, seenAt: NOW - 1000 },
    },
  ): AccountHealthState {
    return { accountId: "claw1", updatedAt: NOW - 1000, windows, credential };
  }

  test("quota `allowed` cannot rescue a rejected login", () => {
    const h = classifyAccountHealth(
      withCredential({ status: "failed", reason: "OAuth session expired", seenAt: NOW - 60_000 }),
      {},
      NOW,
    );
    expect(h.verdict).toBe("credential_failed");
    expect(h.reason).toContain("OAuth session expired");
    expect(h.resumeAt).toBe(NOW - 60_000 + CREDENTIAL_FAILED_TTL_MS);
  });

  test("it gates every model, not just the one that hit it", () => {
    const s = withCredential({ status: "failed", seenAt: NOW - 1000 });
    for (const model of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(classifyAccountHealth(s, {}, NOW, model).verdict).toBe("credential_failed");
    }
  });

  test("it stops binding past the TTL so an out-of-band fix recovers", () => {
    const s = withCredential({
      status: "failed",
      seenAt: NOW - CREDENTIAL_FAILED_TTL_MS - 1000,
    });
    expect(classifyAccountHealth(s, {}, NOW).verdict).not.toBe("credential_failed");
  });

  test("an explicit ok record does not bind at all", () => {
    expect(classifyAccountHealth(withCredential({ status: "ok", seenAt: NOW }), {}, NOW).verdict)
      .toBe("ok");
  });

  test("an ok record is not treated as positive quota evidence either", () => {
    // No windows at all: the account is still `no_data`, not `ok` — a working
    // login says nothing about how much quota is left.
    expect(classifyAccountHealth(withCredential({ status: "ok", seenAt: NOW }, {}), {}, NOW).verdict)
      .toBe("no_data");
  });

  test("credentialFailureFor answers the same question the classifier asks", () => {
    expect(credentialFailureFor(undefined, NOW)).toBeUndefined();
    expect(credentialFailureFor(withCredential({ status: "ok", seenAt: NOW }), NOW)).toBeUndefined();
    expect(
      credentialFailureFor(withCredential({ status: "failed", seenAt: NOW }), NOW)?.verdict,
    ).toBe("credential_failed");
  });
});

describe("pool selection vocabulary", () => {
  test("a credential-broken member is never chosen", () => {
    expect(
      choosePoolAccount([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "ok" },
      ]),
    ).toBe("claw2");
  });

  test("not even as the last resort an exhausted account is", () => {
    // An exhausted account still authenticates, so it can serve a degraded
    // tier or produce a real quota error. A rejected login can do neither.
    expect(
      choosePoolAccount([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "exhausted" },
      ]),
    ).toBeUndefined();
    expect(
      pickPoolAccountForLaunch([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "exhausted" },
      ]),
    ).toBe("claw2");
  });

  test("allCredentialFailed is the hard-error trigger, and only that", () => {
    expect(
      allCredentialFailed([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "credential_failed" },
      ]),
    ).toBe(true);
    expect(
      allCredentialFailed([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "exhausted" },
      ]),
    ).toBe(false);
    expect(allCredentialFailed([])).toBe(false);
  });

  test("with every login dead the fallback is home — the caller raises the error", () => {
    expect(
      fallbackPoolAccount([
        { id: "claw1", verdict: "credential_failed" },
        { id: "claw2", verdict: "credential_failed" },
      ]),
    ).toBe("claw1");
  });
});

describe("diagnostics keep the two failure kinds apart", () => {
  test("explain names re-authentication for a dead login and a reset for a quota stop", () => {
    const out = renderExplanation({
      accounts: [{ id: "claw1" }, { id: "claw2" }],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      health: [
        { id: "claw1", verdict: "credential_failed", detail: "login rejected by the Claude CLI" },
        { id: "claw2", verdict: "exhausted", detail: "weekly window rejected" },
      ],
      nowMs: NOW,
    });
    expect(out).toContain("LOGIN REJECTED");
    expect(out).toMatch(/re-authenticated/i);
    expect(out).toContain("EXHAUSTED");
    // The exhausted line must not tell the operator to go and log in.
    const exhaustedLine = out.split("\n").find((l) => l.includes("claw2:"))!;
    expect(exhaustedLine).not.toMatch(/re-authenticated/i);
  });

  test("the two verdicts carry different reasons out of the classifier", () => {
    const dead = classifyAccountHealth(
      {
        accountId: "claw1",
        windows: { five_hour: { status: "allowed", seenAt: NOW - 1000 } },
        credential: { status: "failed", reason: "OAuth session expired", seenAt: NOW - 1000 },
      },
      {},
      NOW,
    );
    const exhausted = classifyAccountHealth(
      {
        accountId: "claw2",
        windows: { five_hour: { status: "rejected", resetsAt: NOW_S + 1800, seenAt: NOW - 1000 } },
      },
      {},
      NOW,
    );
    expect(dead.verdict).not.toBe(exhausted.verdict);
    expect(dead.reason).not.toEqual(exhausted.reason);
    expect(dead.reason).toMatch(/re-authenticate/i);
    expect(exhausted.reason).toMatch(/rejected until/);
  });
});
