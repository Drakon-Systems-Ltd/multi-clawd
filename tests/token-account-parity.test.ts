/**
 * Setup-token pool accounts at parity with login-based ones.
 *
 * A pool whose members are all `claude setup-token` accounts (`oauthTokenFile`,
 * optionally with a `configDir` harness) used to lose three things a login
 * pool had: an in-turn retry sibling, a fail-closed launch when the token did
 * not resolve but a configDir existed, and an honest story about usage
 * telemetry. This drives the real pool backend over real token files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseSetupTokenFile } from "../src/account-env";
import {
  RETRY_ROSTER_ENV,
  buildRetryEnv,
  chooseLaunchableRetryAccount,
  materializeRetryAccount,
  parseRetryRoster,
  type RetryAccount,
} from "../src/retry-plan";
import { checkAccountCredential } from "../src/login-health";

const home = { dir: "" };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { registerPoolBackend, healthStateFile, pendingOperatorAlerts, usagePollCredentialsFile, startUsagePoll, stopUsagePoll } =
  await import("../src/index.js");

const TOKEN1 = "sk-ant-oat01-FAKE-account-one-token-value";
const TOKEN2 = "sk-ant-oat01-FAKE-account-two-token-value";
/** Roughly what `claude setup-token > file` captures: screen text around the token. */
const SCREEN = (token: string) =>
  [
    "Opening browser to sign in…",
    "",
    "✓ Long-lived authentication token created successfully!",
    "",
    "Your OAuth token (valid for a long time):",
    "",
    token,
    "",
    "Store this token securely. You won't be able to see it again.",
    "",
    "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>",
    "",
  ].join("\n");

function tokenFile(name: string, contents: string): string {
  const file = join(home.dir, name);
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function writeState(accountId: string, windows: Record<string, unknown>): void {
  const file = healthStateFile(accountId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ accountId, updatedAt: Date.now(), windows }));
}

/** claw1: token file, no configDir (default harness). claw2: configDir + token file. */
function registerTokenPool(
  claw1File: string,
  claw2File: string,
  opts: { accounts?: Array<Record<string, unknown>>; resolver?: unknown } = {},
) {
  let backend: { prepareExecution?: unknown } | undefined;
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const api = {
    logger: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    registerCliBackend: (b: { prepareExecution?: unknown }) => {
      if (b.prepareExecution) backend = b;
    },
    registerProvider: () => {},
  } as never;
  registerPoolBackend(
    api,
    { id: "clawd", accounts: ["claw1", "claw2"] },
    (opts.accounts ?? [
      { id: "claw1", oauthTokenFile: claw1File },
      { id: "claw2", configDir: join(home.dir, ".claw2"), oauthTokenFile: claw2File },
    ]) as never,
    new Set(["claw1", "claw2"]),
    undefined,
    opts.resolver ? { resolver: opts.resolver as never } : undefined,
  );
  const prepare = backend!.prepareExecution as (ctx: Record<string, unknown>) => Promise<{ env: Record<string, string> }>;
  return { launch: () => prepare({ modelId: "clawd/claude-opus-5", workspaceDir: "/tmp/ws" }), logs };
}

const NOW_S = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "mc-tokpool-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("token file parsing", () => {
  test("exactly one token, with or without surrounding whitespace/newlines, is accepted", () => {
    expect(parseSetupTokenFile(`${TOKEN1}`)).toEqual({ token: TOKEN1 });
    expect(parseSetupTokenFile(`\n  ${TOKEN1}\r\n\n`)).toEqual({ token: TOKEN1 });
  });

  test("the setup-token screen capture is refused, not mined — with a precise reason", () => {
    const read = parseSetupTokenFile(SCREEN(TOKEN1), "token file /x/claw1");
    expect("error" in read).toBe(true);
    const error = (read as { error: string }).error;
    expect(error).toContain("token file /x/claw1");
    expect(error).toContain("ONLY the token");
    expect(error).toContain("claude setup-token > file");
    expect(error).toMatch(/1 token-like/);
    expect(error).not.toContain(TOKEN1);
    expect(error).not.toContain("FAKE");
  });

  test("a token wrapped across two lines is refused (a prefix would look valid and fail)", () => {
    const read = parseSetupTokenFile(`${TOKEN1.slice(0, 30)}\n${TOKEN1.slice(30)}\n`);
    expect("error" in read).toBe(true);
  });

  test("an export line, two tokens, or prose without a token are all refused", () => {
    expect("error" in parseSetupTokenFile(`export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN1}`)).toBe(true);
    expect("error" in parseSetupTokenFile(`${TOKEN1}\n${TOKEN2}`)).toBe(true);
    const none = parseSetupTokenFile("just some notes\nabout nothing");
    expect((none as { error: string }).error).toMatch(/does not contain a setup-token/);
  });

  test("one line holding more than one token, or a token plus junk, is refused", () => {
    expect("error" in parseSetupTokenFile(`${TOKEN1},${TOKEN2}`)).toBe(true);
    expect("error" in parseSetupTokenFile(`${TOKEN1};extra-text`)).toBe(true);
    expect("error" in parseSetupTokenFile(`${TOKEN1} ${TOKEN2}`)).toBe(true);
    expect("error" in parseSetupTokenFile(`${TOKEN1}…`)).toBe(true);
  });

  test("other sk-ant credential families are not setup-tokens", () => {
    expect("error" in parseSetupTokenFile("sk-ant-api03-FAKE-an-api-key")).toBe(true);
    expect("error" in parseSetupTokenFile("sk-ant-admin01-FAKE")).toBe(true);
  });

  test("a UTF-8 BOM and CRLF line endings are tolerated", () => {
    expect(parseSetupTokenFile(`\uFEFF${TOKEN1}\r\n`)).toEqual({ token: TOKEN1 });
  });

  test("empty and whitespace-only files are empty", () => {
    expect(parseSetupTokenFile("")).toEqual({ error: "token file is empty" });
    expect(parseSetupTokenFile(" \n\t\n")).toEqual({ error: "token file is empty" });
  });

  test("the login probe and doctor report the screen-capture case precisely", () => {
    const io = {
      readFile: () => SCREEN(TOKEN1),
      platform: "darwin",
      keychainHasClaudeCredentials: () => false,
      keychainHasClaudeCredentialsForDir: () => false,
    } as never;
    const check = checkAccountCredential({ id: "claw1", oauthTokenFile: "~/.claw1/oauth-token" }, io);
    expect(check.status).toBe("broken");
    expect(check.reason).toContain("~/.claw1/oauth-token");
    expect(check.reason).toContain("ONLY the token");
    expect(check.reason).not.toContain(TOKEN1);
  });

  test("the login probe still passes a clean token file", () => {
    const io = { readFile: () => `${TOKEN1}\n`, platform: "linux" } as never;
    expect(checkAccountCredential({ id: "claw1", oauthTokenFile: "/t" }, io).status).toBe("ok");
  });
});

describe("retry roster: token-file siblings, paths only", () => {
  const sibling: RetryAccount = { id: "claw2", stateFile: "/s/claw2.json", env: {}, tokenFile: "/t/claw2" };

  test("parse keeps the token-file path and refuses a token value in env", () => {
    const raw = JSON.stringify([
      { id: "claw2", stateFile: "/s", tokenFile: "/t/claw2", env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2, CLAUDE_CONFIG_DIR: "/d" } },
    ]);
    expect(parseRetryRoster(raw)).toEqual([{ id: "claw2", stateFile: "/s", tokenFile: "/t/claw2", env: { CLAUDE_CONFIG_DIR: "/d" } }]);
  });

  test("parse keeps only CLAUDE_CONFIG_DIR from an entry's env (allow-list)", () => {
    const raw = JSON.stringify([
      { id: "claw2", stateFile: "/s", env: { CLAUDE_CONFIG_DIR: "/d", NODE_OPTIONS: "--require /x.js", ANTHROPIC_API_KEY: "sk-ant-api03-FAKE" } },
    ]);
    expect(parseRetryRoster(raw)[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/d" });
  });

  test("materialize reads the token at retry time into that account's env only", () => {
    const ready = materializeRetryAccount(sibling, () => `${TOKEN2}\n`);
    expect(ready).toEqual({ account: { ...sibling, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2 } } });
    const env = buildRetryEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: TOKEN1, CLAUDE_CONFIG_DIR: "/launched", PATH: "/bin" },
      (ready as { account: RetryAccount }).account,
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN2);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
  });

  test("materialize fails closed — unreadable, empty, or screen text — and names no content", () => {
    const enoent = Object.assign(new Error(`ENOENT ${TOKEN2}`), { code: "ENOENT" });
    expect(materializeRetryAccount(sibling, () => { throw enoent; })).toEqual({ error: "token file unreadable (ENOENT)" });
    expect("error" in materializeRetryAccount(sibling, () => "")).toBe(true);
    const junk = materializeRetryAccount(sibling, () => SCREEN(TOKEN2));
    expect(JSON.stringify(junk)).not.toContain(TOKEN2);
  });

  test("a non-token sibling passes through untouched", () => {
    const dir: RetryAccount = { id: "claw3", stateFile: "/s", env: { CLAUDE_CONFIG_DIR: "/d" } };
    expect(materializeRetryAccount(dir, () => { throw new Error("must not read"); })).toEqual({ account: dir });
  });

  test("an unlaunchable first choice is skipped and the next healthy sibling taken", () => {
    const a: RetryAccount = { id: "claw2", stateFile: "/a", env: {}, tokenFile: "/bad" };
    const b: RetryAccount = { id: "claw3", stateFile: "/b", env: {}, tokenFile: "/good" };
    const skipped: string[] = [];
    const pick = chooseLaunchableRetryAccount({
      roster: [a, b],
      readState: () => undefined,
      nowMs: Date.now(),
      materialize: (acc) => materializeRetryAccount(acc, (p) => (p === "/good" ? TOKEN2 : "")),
      onSkip: (id, reason) => skipped.push(`${id}: ${reason}`),
    });
    expect(pick?.id).toBe("claw3");
    expect(pick?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN2);
    expect(skipped).toEqual(["claw2: token file is empty"]);
  });

  test("with every sibling unlaunchable there is no retry", () => {
    expect(
      chooseLaunchableRetryAccount({
        roster: [sibling],
        readState: () => undefined,
        nowMs: Date.now(),
        materialize: () => ({ error: "x" }),
      }),
    ).toBeUndefined();
  });
});

describe("all-token pool, end to end through the pool backend", () => {
  test("both accounts launch on their own tokens, and each hands the shim the other as a sibling", async () => {
    const f1 = tokenFile("claw1.token", `${TOKEN1}\n`);
    const f2 = tokenFile("claw2.token", `${TOKEN2}\n`);
    const { launch } = registerTokenPool(f1, f2);
    const { env } = await launch();
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN1);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const roster = parseRetryRoster(env[RETRY_ROSTER_ENV]);
    expect(roster.map((r) => [r.id, r.tokenFile])).toEqual([["claw2", f2]]);
    // The sibling's token value is nowhere in the launched child's env.
    expect(Object.values(env).join("\n")).not.toContain(TOKEN2);
  });

  test("a declared token that does not resolve is skipped even WITH a configDir, with an alert", async () => {
    const f1 = tokenFile("claw1.token", `${TOKEN1}\n`);
    const f2 = tokenFile("claw2.token", "   \n");
    writeState("claw1", { seven_day: { status: "allowed", utilization: 0.97, resetsAt: NOW_S() + 86_400, seenAt: Date.now() } });
    const { launch, logs } = registerTokenPool(f1, f2);
    // claw1 is past the threshold so the pool prefers claw2 — whose token is
    // blank. It must NOT run on claw2's configDir login; it falls back to claw1.
    const { env } = await launch();
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN1);
    expect(logs.warn.join("\n")).toMatch(/claw2's credential did not resolve/);
    const alerts = pendingOperatorAlerts(Date.now()) ?? "";
    expect(alerts).toMatch(/account "claw2" was skipped — its declared credential did not resolve/);
    expect(alerts).toContain("token file");
    expect(alerts).not.toContain(TOKEN1);
  });

  test("a screen-captured token file is skipped with the precise fix in the alert", async () => {
    const f1 = tokenFile("claw1.token", SCREEN(TOKEN1));
    const f2 = tokenFile("claw2.token", `${TOKEN2}\n`);
    const { launch } = registerTokenPool(f1, f2);
    const { env } = await launch();
    expect(env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN2);
    const alerts = pendingOperatorAlerts(Date.now()) ?? "";
    expect(alerts).toMatch(/"claw1" was skipped/);
    expect(alerts).toContain("ONLY the token");
    expect(alerts).not.toContain(TOKEN1);
    // Fixed file: the alert clears on the next launch that uses claw1.
    writeFileSync(f1, `${TOKEN1}\n`);
    await launch();
    expect(pendingOperatorAlerts(Date.now()) ?? "").not.toMatch(/"claw1" was skipped/);
  });

  test("a missing token file is named in the alert by its configured path and error code", async () => {
    const f2 = tokenFile("claw2.token", `${TOKEN2}\n`);
    const { launch } = registerTokenPool(join(home.dir, "nope.token"), f2);
    expect((await launch()).env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
    expect(pendingOperatorAlerts(Date.now()) ?? "").toMatch(/"claw1" was skipped.*nope\.token unreadable \(ENOENT\)/);
  });

  test("a secret provider's exception text never reaches an alert, a log, or the refusal", async () => {
    const SENTINEL = "sk-ant-oat01-FAKE-SENTINEL-from-provider-error";
    const throwing = {
      resolve: async () => {
        throw new Error(`provider choked on ${SENTINEL}`);
      },
      resolveDetailed: async () => ({ failure: "provider_error" }),
      peek: () => undefined,
    };
    const { launch, logs } = registerTokenPool("", "", {
      accounts: [
        { id: "claw1", oauthTokenRef: { source: "exec", provider: "vault", id: "op://Vault/Item/field" } },
        { id: "claw2", oauthTokenRef: { source: "exec", provider: "vault", id: "op://Vault/Item/other" } },
      ],
      resolver: throwing,
    });
    const err = await launch().catch((e: unknown) => e);
    expect(String(err)).toMatch(/no account's credential could be resolved/);
    expect(String(err)).toContain("credential resolution failed (Error)");
    const everything = [String(err), pendingOperatorAlerts(Date.now()) ?? "", ...logs.info, ...logs.warn, ...logs.error].join("\n");
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain("provider choked");
  });

  test("when no member resolves, the launch is refused outright", async () => {
    const { launch } = registerTokenPool(tokenFile("a", ""), tokenFile("b", SCREEN(TOKEN2)));
    await expect(launch()).rejects.toThrow(/no account's credential could be resolved/);
  });
});

describe("threshold rotation from stream telemetry alone (token accounts are not usage-polled)", () => {
  test("a stream-reported utilization past the threshold rotates a token pool", async () => {
    const { launch } = registerTokenPool(tokenFile("a", TOKEN1), tokenFile("b", TOKEN2));
    writeState("claw1", { seven_day: { status: "allowed", utilization: 0.9, resetsAt: NOW_S() + 86_400, seenAt: Date.now() } });
    expect((await launch()).env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
  });

  test("a numberless 5-hour warning from the stream rotates a token pool", async () => {
    const { launch } = registerTokenPool(tokenFile("a", TOKEN1), tokenFile("b", TOKEN2));
    writeState("claw1", { five_hour: { status: "allowed_warning", resetsAt: NOW_S() + 1800, seenAt: Date.now() } });
    expect((await launch()).env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
  });

  test("a stream rejection with a future reset rotates a token pool", async () => {
    const { launch } = registerTokenPool(tokenFile("a", TOKEN1), tokenFile("b", TOKEN2));
    writeState("claw1", { five_hour: { status: "rejected", resetsAt: NOW_S() + 1800, seenAt: Date.now() } });
    expect((await launch()).env.MULTI_CLAWD_ACCOUNT_ID).toBe("claw2");
  });

  test("the usage poll skips token accounts with the provider's reason, and makes no request", () => {
    const skip = usagePollCredentialsFile({ id: "claw2", configDir: "/d", oauthTokenFile: "/t" });
    expect("reason" in skip && skip.reason).toMatch(/user:inference/);
    expect("reason" in skip && skip.reason).toMatch(/stream telemetry/);
    const info: string[] = [];
    const fetchImpl = vi.fn();
    const started = startUsagePoll({
      accounts: [
        { id: "claw1", oauthTokenFile: "/t1" },
        { id: "claw2", configDir: "/d", oauthTokenFile: "/t2" },
      ],
      pool: { id: "clawd", accounts: ["claw1", "claw2"] },
      logger: { info: (m) => info.push(m), warn: () => {} },
      fetchImpl,
    });
    stopUsagePoll();
    expect(started.active).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(info.join("\n")).toMatch(/no pollable account/);
  });
});
