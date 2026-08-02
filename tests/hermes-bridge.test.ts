import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { HERMES, SKIP_REASON, hermesPython, isolatedEnv, writeAuthStore } from "./hermes-support";

const BRIDGE = resolve("scripts/hermes_bridge.py");
const TOKEN_ONE = "sk-ant-oat01-fake-test-bridge-one";
const TOKEN_TWO = "sk-ant-oat01-fake-test-bridge-two";

type Home = { root: string; home: string; hermesHome: string };

function makeHome(): Home {
  const root = mkdtempSync(join(tmpdir(), "multi-clawd-hermes-"));
  const home = join(root, "home");
  const hermesHome = join(root, "hermes-home");
  mkdirSync(home, { recursive: true });
  return { root, home, hermesHome };
}

/** A named profile under an isolated HOME, created the way Hermes requires. */
function makeProfile(name: string, options: { create: boolean }): Home & { global: string } {
  const root = mkdtempSync(join(tmpdir(), "multi-clawd-hermes-profile-"));
  const home = join(root, "home");
  const globalHome = join(home, ".hermes");
  const hermesHome = join(globalHome, "profiles", name);
  mkdirSync(globalHome, { recursive: true });
  if (options.create) mkdirSync(hermesHome, { recursive: true });
  return { root, home, hermesHome, global: globalHome };
}

function stableId(accountId: string): string {
  const digest = createHash("sha256").update(`multi-clawd/hermes/${accountId}`).digest("hex");
  return `multi-clawd-${digest.slice(0, 16)}`;
}

function credential(accountId = "claw1", accessToken = TOKEN_ONE, priority = 0) {
  return {
    accountId,
    id: stableId(accountId),
    label: `multi-clawd:${accountId}`,
    source: "manual:multi-clawd",
    authType: "oauth",
    accessToken,
    priority,
  };
}

function bridge(target: Home, request: unknown) {
  const result = spawnSync(HERMES!.python, [BRIDGE], {
    cwd: resolve("."),
    env: isolatedEnv(target.home, target.hermesHome),
    input: typeof request === "string" ? request : JSON.stringify(request),
    encoding: "utf8",
    timeout: 60_000,
  });
  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function localRows(target: Home): any[] {
  const path = join(target.hermesHome, "auth.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).credential_pool?.anthropic ?? [];
}

function readStrategy(target: Home): unknown {
  const state = hermesPython(
    target.home,
    target.hermesHome,
    "import json; from hermes_cli.config import read_raw_config; " +
      "print(json.dumps(read_raw_config().get('credential_pool_strategies')))",
  );
  return state;
}

function applyRequest(target: Home, overrides: Record<string, unknown> = {}) {
  return {
    operation: "apply",
    targetHome: target.hermesHome,
    dryRun: false,
    credentials: [credential()],
    ...overrides,
  };
}

function allOutput(result: ReturnType<typeof bridge>): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe.skipIf(!HERMES)(`secure Hermes Python bridge (${HERMES?.version ?? SKIP_REASON})`, () => {
  test("adds a setup-token row via Hermes APIs, defaults the strategy, and emits no token", () => {
    const target = makeHome();
    const result = bridge(target, applyRequest(target, { strategy: "round_robin" }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({
      ok: true,
      operation: "apply",
      strategy: "round_robin",
      wrote: true,
      strategyChanged: true,
      actions: [{ accountId: "claw1", id: stableId("claw1"), action: "add", priority: 0 }],
    });
    expect(allOutput(result)).not.toContain(TOKEN_ONE);

    const rows = localRows(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stableId("claw1"),
      label: "multi-clawd:claw1",
      source: "manual:multi-clawd",
      auth_type: "oauth",
      priority: 0,
      access_token: TOKEN_ONE,
    });
    expect(rows[0].refresh_token ?? null).toBeNull();
    expect(readStrategy(target)).toMatchObject({ anthropic: "round_robin" });
    expect(statSync(join(target.hermesHome, "auth.json")).mode & 0o777).toBe(0o600);
  });

  test("rejects rotating grant material outright", () => {
    const target = makeHome();
    for (const extra of [{ refreshToken: "fake-refresh" }, { expiresAtMs: 2_000_000_000_000 }]) {
      const result = bridge(
        target,
        applyRequest(target, { credentials: [{ ...credential(), ...extra }] }),
      );
      expect(result.status).toBe(1);
      expect(result.json.error.code).toBe("rotating_grant_not_supported");
      expect(allOutput(result)).not.toContain("fake-refresh");
    }
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);
  });

  test("an omitted strategy preserves the configured one; a set one is respected", () => {
    const target = makeHome();
    expect(bridge(target, applyRequest(target, { strategy: "round_robin" })).status).toBe(0);
    expect(readStrategy(target)).toMatchObject({ anthropic: "round_robin" });

    const preserved = bridge(
      target,
      applyRequest(target, { credentials: [credential("claw1", TOKEN_TWO)] }),
    );
    expect(preserved.status, preserved.stderr).toBe(0);
    expect(preserved.json).toMatchObject({
      strategy: "round_robin",
      requestedStrategy: null,
      currentStrategy: "round_robin",
      strategyChanged: false,
    });
    expect(preserved.json.actions[0].action).toBe("update");
    expect(readStrategy(target)).toMatchObject({ anthropic: "round_robin" });
  });

  test("with no strategy configured anywhere, an omitted strategy defaults to fill_first", () => {
    const target = makeHome();
    const result = bridge(target, applyRequest(target));
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      strategy: "fill_first",
      requestedStrategy: null,
      currentStrategy: null,
      strategyChanged: true,
    });
    expect(readStrategy(target)).toMatchObject({ anthropic: "fill_first" });
  });

  test("updates idempotently, keeps runtime bookkeeping, clears stale expiries, and preserves unrelated rows", () => {
    const target = makeHome();
    const unrelated = {
      id: "keep-api-key",
      label: "keep me",
      source: "manual",
      auth_type: "api_key",
      priority: 4,
      access_token: "fake-unrelated-token",
      request_count: 8,
    };
    writeAuthStore(target.hermesHome, [
      unrelated,
      {
        id: stableId("claw1"),
        label: "multi-clawd:claw1",
        source: "manual:multi-clawd",
        auth_type: "oauth",
        priority: 7,
        access_token: TOKEN_ONE,
        refresh_token: "fake-stale-refresh",
        expires_at: "2026-01-01T00:00:00+00:00",
        expires_at_ms: 1_900_000_000_000,
        last_status: "exhausted",
        last_error_code: 429,
        request_count: 11,
      },
    ]);

    const first = bridge(
      target,
      applyRequest(target, { credentials: [credential("claw1", TOKEN_TWO, 0)] }),
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.json.actions[0].action).toBe("update");
    expect(allOutput(first)).not.toContain(TOKEN_TWO);
    expect(allOutput(first)).not.toContain("fake-unrelated-token");

    const rows = localRows(target);
    expect(rows).toHaveLength(2);
    const managed = rows.find((row) => row.id === stableId("claw1"));
    const kept = rows.find((row) => row.id === "keep-api-key");
    expect(kept).toMatchObject({ access_token: "fake-unrelated-token", request_count: 8, priority: 4 });
    expect(managed).toMatchObject({
      access_token: TOKEN_TWO,
      priority: 0,
      last_error_code: 429,
      request_count: 11,
    });
    expect(managed.refresh_token ?? null).toBeNull();
    expect(managed.expires_at ?? null).toBeNull();
    expect(managed.expires_at_ms ?? null).toBeNull();

    const authMtime = statSync(join(target.hermesHome, "auth.json")).mtimeMs;
    const second = bridge(
      target,
      applyRequest(target, { credentials: [credential("claw1", TOKEN_TWO, 0)] }),
    );
    expect(second.status).toBe(0);
    expect(second.json).toMatchObject({ wouldWrite: false, wrote: false, strategyChanged: false });
    expect(second.json.actions[0].action).toBe("noop");
    expect(statSync(join(target.hermesHome, "auth.json")).mtimeMs).toBe(authMtime);
  });

  test("sends account preference order through as deterministic priorities", () => {
    const target = makeHome();
    const result = bridge(
      target,
      applyRequest(target, {
        credentials: [credential("home", TOKEN_ONE, 0), credential("spare", TOKEN_TWO, 1)],
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const rows = localRows(target);
    expect(rows.find((row) => row.id === stableId("home")).priority).toBe(0);
    expect(rows.find((row) => row.id === stableId("spare")).priority).toBe(1);

    const collide = bridge(
      target,
      applyRequest(target, {
        credentials: [credential("home", TOKEN_ONE, 0), credential("spare", TOKEN_TWO, 0)],
      }),
    );
    expect(collide.status).toBe(1);
    expect(collide.json.error.code).toBe("malformed_credentials");
  });

  test("probe and dry-run are secret-free and make no writes", () => {
    const target = makeHome();
    const probe = bridge(target, { operation: "probe", targetHome: target.hermesHome });
    expect(probe.status).toBe(0);
    expect(probe.json).toMatchObject({
      ok: true,
      operation: "probe",
      localRowCount: 0,
      strategy: null,
      effectiveStrategy: "fill_first",
      effectiveIncludesGlobalFallback: false,
    });
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);

    const dry = bridge(target, applyRequest(target, { dryRun: true }));
    expect(dry.status).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, wouldWrite: true, wrote: false });
    expect(allOutput(dry)).not.toContain(TOKEN_ONE);
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);
    expect(existsSync(join(target.hermesHome, "config.yaml"))).toBe(false);
  });

  test("rejects malformed payloads and target mismatch without leaking tokens or writing", () => {
    const target = makeHome();
    const malformed = bridge(target, {
      ...applyRequest(target),
      credentials: [{ ...credential(), id: stableId("different"), accessToken: TOKEN_TWO }],
    });
    expect(malformed.status).toBe(1);
    expect(malformed.json).toMatchObject({ ok: false, error: { code: "invalid_managed_id" } });
    expect(allOutput(malformed)).not.toContain(TOKEN_TWO);

    const badJson = bridge(target, `{"operation":"apply","accessToken":"${TOKEN_ONE}"`);
    expect(badJson.status).toBe(1);
    expect(badJson.json.error.code).toBe("malformed_json");
    expect(allOutput(badJson)).not.toContain(TOKEN_ONE);

    const mismatch = bridge(target, {
      operation: "probe",
      targetHome: `${target.hermesHome}-other`,
    });
    expect(mismatch.status).toBe(1);
    expect(mismatch.json.error.code).toBe("target_home_mismatch");
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);
  });

  test("does not accept credentials through argv or environment", () => {
    const target = makeHome();
    const result = spawnSync(HERMES!.python, [BRIDGE, TOKEN_ONE], {
      cwd: resolve("."),
      env: { ...isolatedEnv(target.home, target.hermesHome), MULTI_CLAWD_ACCESS_TOKEN: TOKEN_TWO },
      input: JSON.stringify({ operation: "probe" }),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("argv_not_supported");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN_ONE);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN_TWO);
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);
  });

  test("hard-fails only on multi-clawd's own duplicate managed rows", () => {
    const target = makeHome();
    const managed = {
      id: stableId("claw1"),
      label: "multi-clawd:claw1",
      source: "manual:multi-clawd",
      auth_type: "oauth",
      priority: 0,
      access_token: TOKEN_ONE,
    };
    writeAuthStore(target.hermesHome, [managed, { ...managed }]);
    const before = statSync(join(target.hermesHome, "auth.json")).mtimeMs;

    const doctor = bridge(target, { operation: "doctor" });
    expect(doctor.status).toBe(0);
    expect(doctor.json.healthy).toBe(false);
    expect(doctor.json.findings.errors.duplicateManagedIds).toEqual([stableId("claw1")]);
    expect(allOutput(doctor)).not.toContain(TOKEN_ONE);

    const apply = bridge(target, applyRequest(target));
    expect(apply.status).toBe(1);
    expect(apply.json.error.code).toBe("duplicate_managed_ids");
    expect(statSync(join(target.hermesHome, "auth.json")).mtimeMs).toBe(before);
  });

  test("refuses an API-key-shaped or non-ASCII access token with no leakage", () => {
    const target = makeHome();
    for (const bad of [
      "sk-ant-api03-fake-test-not-a-setup-token",
      "sk-ant-oat01-fake-café-token",
      "sk-ant-oat01-fake-😀-token",
    ]) {
      const result = bridge(
        target,
        applyRequest(target, { credentials: [{ ...credential(), accessToken: bad }] }),
      );
      expect(result.status, bad).toBe(1);
      expect(result.json.error.code, bad).toBe("malformed_credentials");
      expect(allOutput(result)).not.toContain(bad);
    }
    expect(existsSync(join(target.hermesHome, "auth.json"))).toBe(false);
  });

  test("an unrelated row stuffed with token-like values is never echoed, only its position", () => {
    const target = makeHome();
    const secretLike = "sk-ant-oat01-should-never-appear-in-output";
    writeAuthStore(target.hermesHome, [
      {
        id: secretLike,
        label: secretLike,
        source: secretLike,
        auth_type: secretLike,
        priority: 0,
        last_status: secretLike,
        access_token: "fake-unrelated-access-token",
      },
    ]);

    const doctor = bridge(target, { operation: "doctor" });
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.json.healthy).toBe(true);
    expect(doctor.json.localRows).toEqual([{ index: 0, managed: false }]);
    expect(allOutput(doctor)).not.toContain(secretLike);

    const apply = bridge(target, applyRequest(target));
    expect(apply.status, apply.stderr).toBe(0);
    expect(allOutput(apply)).not.toContain(secretLike);
    // Hermes' own merge may reorder rows, so find the unrelated one by shape,
    // not by an assumed position — and confirm it carries nothing else.
    const unrelated = apply.json.resultingRows.find((row: any) => row.managed === false);
    expect(unrelated).toBeDefined();
    expect(Object.keys(unrelated).sort()).toEqual(["index", "managed"]);
  });

  test("several claude_code rows and unrelated malformed rows are warnings, not failures", () => {
    const target = makeHome();
    writeAuthStore(target.hermesHome, [
      { id: "native-one", source: "claude_code", auth_type: "oauth", access_token: "fake-native-one" },
      { id: "native-two", source: "claude_code", auth_type: "oauth", access_token: "fake-native-two" },
      "not-a-row",
    ]);

    const doctor = bridge(target, { operation: "doctor" });
    expect(doctor.status).toBe(0);
    expect(doctor.json.healthy).toBe(true);
    expect(doctor.json.errorCount).toBe(0);
    expect(doctor.json.findings.warnings.multipleClaudeCodeRows).toEqual(["row:0", "row:1"]);
    expect(doctor.json.findings.warnings.malformedUnrelatedRows).toEqual(["row:2"]);
    // Unrelated rows are reported positionally; their ids never leave the bridge.
    expect(allOutput(doctor)).not.toContain("native-one");

    const apply = bridge(target, applyRequest(target));
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.json.wrote).toBe(true);
    // Both claude_code rows survive untouched. The non-dict row is dropped by
    // Hermes' own merge, which skips garbage entries — not by this adapter.
    const rows = localRows(target);
    expect(rows.filter((row) => row.source === "claude_code")).toHaveLength(2);
    expect(rows.filter((row) => row.source === "manual:multi-clawd")).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  test("a managed Hermes install cannot silently swallow the strategy write", () => {
    // save_config() returns without writing on a package-manager-managed
    // install and only prints to stderr, which this bridge discards. Without
    // the verify-after-write the CLI would report "(changed)" for a no-op.
    const target = makeHome();
    mkdirSync(target.hermesHome, { recursive: true });
    writeFileSync(join(target.hermesHome, ".managed"), "");

    const result = bridge(target, applyRequest(target, { strategy: "round_robin" }));
    expect(result.status).toBe(1);
    expect(result.json.error.code).toBe("strategy_write_unverified");
    expect(result.json.error.message).toMatch(/managed install/);
    // The credentials themselves did land, and the failure names what did not.
    expect(localRows(target)).toHaveLength(1);
    expect(existsSync(join(target.hermesHome, "config.yaml"))).toBe(false);
  });

  test("refuses to plan against an unparseable auth store", () => {
    const target = makeHome();
    mkdirSync(target.hermesHome, { recursive: true });
    writeAuthStore(target.hermesHome, []);
    const path = join(target.hermesHome, "auth.json");
    writeFileSync(path, "{ not json");
    const result = bridge(target, applyRequest(target));
    expect(result.status).toBe(1);
    expect(result.json.error.code).toBe("auth_store_unreadable");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  test("isolates selected Hermes homes and never follows a payload path into another home", () => {
    const first = makeHome();
    const second = makeHome();
    expect(bridge(first, applyRequest(first)).status).toBe(0);

    const secondProbe = bridge(second, { operation: "probe", targetHome: second.hermesHome });
    expect(secondProbe.json.localRowCount).toBe(0);
    expect(existsSync(join(second.hermesHome, "auth.json"))).toBe(false);

    const cross = bridge(first, applyRequest(second));
    expect(cross.status).toBe(1);
    expect(cross.json.error.code).toBe("target_home_mismatch");
    expect(localRows(first)).toHaveLength(1);
    expect(localRows(second)).toHaveLength(0);
  });

  test("a named profile is never fabricated", () => {
    const target = makeProfile("work", { create: false });
    for (const request of [
      { operation: "doctor", targetHome: target.hermesHome },
      applyRequest(target),
    ]) {
      const result = bridge(target, request);
      expect(result.status).toBe(1);
      expect(result.json.error.code).toBe("hermes_profile_missing");
      expect(result.json.error.message).toContain("hermes profile create");
    }
    expect(existsSync(target.hermesHome)).toBe(false);
  });

  test("a profile sync never copies the global pool into the profile", () => {
    const target = makeProfile("work", { create: true });
    const globalAuth = writeAuthStore(target.global, [
      {
        id: "global-native",
        label: "global native login",
        source: "claude_code",
        auth_type: "oauth",
        priority: 0,
        access_token: "fake-global-oauth-grant",
        refresh_token: "fake-global-refresh-grant",
      },
      {
        id: "global-api-key",
        label: "global key",
        source: "manual",
        auth_type: "api_key",
        priority: 1,
        access_token: "fake-global-api-key",
      },
    ]);
    const globalBefore = readFileSync(globalAuth, "utf8");

    // Hermes' own read falls back to the global pool for an empty profile —
    // the bridge must report that as effective-only, never plan against it.
    const doctor = bridge(target, { operation: "doctor", targetHome: target.hermesHome });
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.json).toMatchObject({
      localRowCount: 0,
      effectiveRowCount: 2,
      effectiveIncludesGlobalFallback: true,
    });

    const result = bridge(target, applyRequest(target));
    expect(result.status, result.stderr).toBe(0);

    const rows = localRows(target);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(stableId("claw1"));
    expect(readFileSync(globalAuth, "utf8")).toBe(globalBefore);
    const serialized = JSON.stringify(rows);
    for (const secret of ["fake-global-oauth-grant", "fake-global-refresh-grant", "fake-global-api-key"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
