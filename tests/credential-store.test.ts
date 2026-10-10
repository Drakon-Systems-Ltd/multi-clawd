import { describe, expect, test } from "vitest";
import {
  createSystemCredentialIo,
  credentialLocations,
  describeSplitStore,
  findCredentialCopies,
  parseKeychainDump,
  type CredentialStoreIo,
  type KeychainItemMeta,
} from "../src/credential-store";
import { CLAUDE_KEYCHAIN_SERVICE, keychainServiceForConfigDir } from "../src/login-health";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const ACCESS = "fake-access-token-value";
const REFRESH = "fake-refresh-token-value";

function cred(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt } });
}

function storeIo(opts: {
  // `data` absent = an item that exists but cannot be read.
  items?: Array<KeychainItemMeta & { data?: string }>;
  files?: Record<string, string>;
  platform?: NodeJS.Platform;
  listFails?: boolean;
}): CredentialStoreIo {
  const items = opts.items ?? [];
  return {
    readFile: (p) => {
      const f = opts.files?.[p];
      if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f;
    },
    expandHome: (p) => p.replace(/^~/, "/home/example"),
    keychainAccount: "example-user",
    platform: opts.platform ?? "darwin",
    readKeychainItem: (service, account) => {
      const item = items.find((i) => i.service === service && i.account === account);
      if (!item) return { status: "absent" };
      return item.data === undefined ? { status: "unreadable" } : { status: "found", data: item.data };
    },
    listKeychainItems: () =>
      opts.listFails ? undefined : items.map(({ service, account, modifiedAt }) => ({ service, account, modifiedAt })),
  };
}

const NATIVE_FILE = "/home/example/.claude/.credentials.json";

describe("parseKeychainDump", () => {
  test("reads service, account and modification time from an attributes-only dump", () => {
    const dump = [
      'keychain: "/home/example/Library/Keychains/login.keychain-db"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    0x00000007 <blob>="Claude Code-credentials"',
      '    "acct"<blob>="example-user"',
      '    "mdat"<timedate>=0x32303236313031303131303331395A00  "20261010110319Z\\000"',
      '    "svce"<blob>="Claude Code-credentials"',
      'keychain: "/home/example/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      "attributes:",
      '    "acct"<blob>=0x756E6B6E6F776E  "unknown"',
      '    "svce"<blob>="Claude Code-credentials"',
      'keychain: "/home/example/Library/Keychains/login.keychain-db"',
      'class: "inet"',
      "attributes:",
      '    "acct"<blob>="someone"',
      '    "srvr"<blob>="example.com"',
      'keychain: "/home/example/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      "attributes:",
      '    "acct"<blob>=<NULL>',
      '    "svce"<blob>="Other"',
    ].join("\n");
    expect(parseKeychainDump(dump)).toEqual([
      {
        service: "Claude Code-credentials",
        account: "example-user",
        modifiedAt: Date.UTC(2026, 9, 10, 11, 3, 19),
      },
      { service: "Claude Code-credentials", account: "unknown", modifiedAt: undefined },
      { service: "Other", account: "", modifiedAt: undefined },
    ]);
  });
});

describe("credential split-store detection", () => {
  test("one keychain item under the CLI's account is a single copy", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({ items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW + HOUR) }] }),
    );
    expect(report.status).toBe("single");
    expect(report.copies[0].active).toBe(true);
  });

  test("a duplicate item under another acct is a split, and the CLI's own is marked active", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "unknown", data: cred(NOW - 90 * 24 * HOUR) },
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW + HOUR) },
          // Another account's per-dir item is NOT a copy of this one.
          { service: keychainServiceForConfigDir("/home/example/.claw2"), account: "example-user", data: cred(NOW) },
        ],
      }),
    );
    expect(report.status).toBe("split");
    expect(report.copies.map((c) => [c.keychainAccount, c.active])).toEqual([
      ["unknown", false],
      ["example-user", true],
    ]);
  });

  test("the plaintext file plus a keychain item is a split; the file is not the active copy", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW - HOUR) }],
        files: { [NATIVE_FILE]: cred(NOW + 5 * HOUR) },
      }),
    );
    expect(report.status).toBe("split");
    expect(report.copies.find((c) => c.kind === "file")).toMatchObject({
      location: NATIVE_FILE,
      expiresAt: NOW + 5 * HOUR,
      active: false,
    });
  });

  test("with no item under the CLI's account the file is what the CLI reads", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "unknown", data: cred(NOW) }],
        files: { [NATIVE_FILE]: cred(NOW) },
      }),
    );
    expect(report.copies.find((c) => c.kind === "file")?.active).toBe(true);
  });

  test("a failed listing still finds the CLI's own item, and says the check is incomplete", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW) }],
        files: { [NATIVE_FILE]: cred(NOW) },
        listFails: true,
      }),
    );
    expect(report.status).toBe("split");
    expect(report.incomplete).toBe(true);
  });

  test("an unreadable CLI item leaves the active copy unknown — the file is not called inactive", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user" }],
        files: { [NATIVE_FILE]: cred(NOW + HOUR) },
      }),
    );
    expect(report.status).toBe("split");
    expect(report.activeKnown).toBe(false);
    expect(report.copies.every((c) => !c.active)).toBe(true);
    const text = describeSplitStore(report, NOW);
    expect(text.headline).toContain("which copy it uses is unknown");
    // No removal of any kind while the CLI's copy is unknown — least of all its own item.
    expect(text.remedy).not.toContain("delete-generic-password");
    expect(text.remedy).not.toContain("aside");
    expect(text.remedy).toContain("re-run doctor for cleanup steps");
  });

  test("a present but unreadable credentials file is still a copy", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      {
        ...storeIo({ items: [{ service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW) }] }),
        readFile: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    );
    expect(report.status).toBe("split");
    expect(report.copies[1]).toMatchObject({ kind: "file", unreadable: "could not be read" });
  });

  test("configDir accounts are checked under their own per-dir service and dir", () => {
    const service = keychainServiceForConfigDir("/home/example/.claw2");
    expect(credentialLocations({ id: "claw2", configDir: "~/.claw2" }, storeIo({}))).toEqual({
      service,
      file: "/home/example/.claw2/.credentials.json",
    });
    const report = findCredentialCopies(
      { id: "claw2", configDir: "~/.claw2" },
      storeIo({
        items: [{ service, account: "example-user", data: cred(NOW) }],
        files: { "/home/example/.claw2/.credentials.json": cred(NOW) },
      }),
    );
    expect(report.status).toBe("split");
  });

  test("Linux has one store, so nothing can be split", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({ platform: "linux", files: { [NATIVE_FILE]: cred(NOW) } }),
    );
    expect(report.status).toBe("single");
  });

  test("token-sourced accounts have no stored OAuth credential to split", () => {
    expect(findCredentialCopies({ id: "claw3", oauthTokenFile: "~/t" }, storeIo({})).status).toBe("n/a");
  });

  test("an unreadable copy is reported as such, not skipped", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW) },
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "unknown" }, // access refused
        ],
      }),
    );
    expect(report.copies[1].unreadable).toMatch(/could not be read/);
  });

  test("the report shows location, account label and expiry, never a token, and destroys nothing first", () => {
    const report = findCredentialCopies(
      { id: "claw1", native: true },
      storeIo({
        items: [
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "example-user", data: cred(NOW - HOUR) },
          { service: CLAUDE_KEYCHAIN_SERVICE, account: "unknown", data: cred(NOW - 90 * 24 * HOUR) },
        ],
        files: { [NATIVE_FILE]: cred(NOW + 5 * HOUR) },
      }),
    );
    const text = describeSplitStore(report, NOW);
    const all = JSON.stringify({ report, text });
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
    expect(text.headline).toContain("3 copies");
    // A newer copy than the CLI's exists (the file): say so.
    expect(text.headline).toContain("a NEWER copy exists than the one the Claude CLI reads");
    expect(text.copies[0]).toContain('keychain "Claude Code-credentials" acct=example-user');
    expect(text.copies[0]).toContain(`expired ${new Date(NOW - HOUR).toISOString()}`);
    expect(text.copies[0]).toContain("the copy the Claude CLI reads");
    expect(text.copies[2]).toContain(`${NATIVE_FILE} — expires ${new Date(NOW + 5 * HOUR).toISOString()}`);
    // Proof comes BEFORE any removal, irreversible removal needs a fresh login
    // first, and the copy the CLI reads is never targeted.
    expect(text.remedy.indexOf("doctor --probe")).toBeLessThan(text.remedy.indexOf("aside"));
    expect(text.remedy).toMatch(/delete a stray Keychain item only after a fresh `multi-clawd login claw1`/);
    expect(text.remedy).toContain("-a 'unknown'");
    expect(text.remedy).not.toContain("-a 'example-user'");
    expect(text.remedy).toContain("Never remove the copy the Claude CLI reads");
  });

  test("a newest, unexpired CLI copy still gets no removal before proof, and no false NEWER claim", () => {
    // Expiry says when an access token was minted, not whether the refresh
    // token beside it still works.
    const service = keychainServiceForConfigDir("/home/example/.claw2");
    const report = findCredentialCopies(
      { id: "claw2", configDir: "~/.claw2" },
      storeIo({
        items: [{ service, account: "example-user", data: cred(NOW + 8 * HOUR) }],
        files: { "/home/example/.claw2/.credentials.json": cred(NOW + 8 * HOUR) },
      }),
    );
    const text = describeSplitStore(report, NOW);
    expect(text.headline).not.toContain("NEWER");
    expect(text.remedy).toMatch(/^first prove the copy the Claude CLI reads with `multi-clawd doctor --probe`/);
    expect(text.remedy).toContain("move '/home/example/.claw2/.credentials.json' aside");
  });
});

describe("createSystemCredentialIo: the real command boundary", () => {
  type Call = { file: string; args: string[]; options: Record<string, unknown> };
  function execWith(result: (call: Call) => string) {
    const calls: Call[] = [];
    const exec = (file: string, args: string[], options: Record<string, unknown>) => {
      const call = { file, args, options };
      calls.push(call);
      return result(call);
    };
    return { calls, exec };
  }
  function failWith(status: number | null): never {
    throw Object.assign(new Error(`security failed, output: ${ACCESS}`), { status, stdout: ACCESS });
  }

  test("reads name service AND account, with a timeout and stderr discarded", () => {
    const { calls, exec } = execWith(() => `${cred(NOW)}\n`);
    const io = createSystemCredentialIo({ exec, env: { USER: "example-user" }, platform: "darwin" });
    expect(io.keychainAccount).toBe("example-user");
    const read = io.readKeychainItem(CLAUDE_KEYCHAIN_SERVICE, io.keychainAccount);
    expect(read).toEqual({ status: "found", data: cred(NOW) });
    expect(calls[0].file).toBe("security");
    expect(calls[0].args).toEqual([
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      "example-user",
      "-w",
    ]);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
    expect((calls[0].options.stdio as string[])[2]).toBe("ignore");
  });

  test("exit 44 is absent; any other failure is unreadable; neither carries the error's output", () => {
    const absent = createSystemCredentialIo({ exec: execWith(() => failWith(44)).exec, platform: "darwin" });
    expect(absent.readKeychainItem("s", "a")).toEqual({ status: "absent" });
    for (const status of [1, 51, null]) {
      const io = createSystemCredentialIo({ exec: execWith(() => failWith(status)).exec, platform: "darwin" });
      const read = io.readKeychainItem("s", "a");
      expect(read).toEqual({ status: "unreadable" });
      expect(JSON.stringify(read)).not.toContain(ACCESS);
    }
  });

  test("listing is attributes-only (no -d) and a failure is undefined, not empty", () => {
    const { calls, exec } = execWith(() => 'keychain: "k"\nclass: "genp"\n    "svce"<blob>="x"\n    "acct"<blob>="y"\n');
    const io = createSystemCredentialIo({ exec, platform: "darwin" });
    expect(io.listKeychainItems()).toEqual([{ service: "x", account: "y", modifiedAt: undefined }]);
    expect(calls[0].args).toEqual(["dump-keychain"]);
    expect(calls[0].args).not.toContain("-d");
    const failing = createSystemCredentialIo({ exec: execWith(() => failWith(1)).exec, platform: "darwin" });
    expect(failing.listKeychainItems()).toBeUndefined();
  });
});
