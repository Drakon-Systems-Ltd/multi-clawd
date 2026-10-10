/**
 * Where a Claude login's OAuth credential is stored, and how many copies of it
 * exist.
 *
 * The Claude CLI keeps one credential per config dir: on macOS in a Keychain
 * generic-password item (service `Claude Code-credentials`, suffixed per
 * non-default dir; account = the CLI's user name), falling back to a plaintext
 * `<dir>/.credentials.json` when the Keychain holds nothing for it. Exactly one
 * of those is the copy the CLI reads and refreshes.
 *
 * Copies multiply anyway — a refresh that missed the Keychain and wrote the
 * file, an item written under a different `acct` by some other tool — and they
 * are not harmless. OAuth refresh tokens ROTATE: once one copy refreshes, the
 * refresh token held by the others is normally retired, and a copy left behind
 * can never refresh again — yet it is a perfectly present credential, and a
 * health check or a tool that happens to read it reports a live login (or a
 * dead one) that has nothing to do with the copy in use. Copies can start out
 * identical; the hazard is that they diverge silently.
 *
 * This module finds every copy and reports its location, account label and
 * expiry. It never returns, logs or prints a token value: secrets read for the
 * expiry are reduced to metadata by `parseOauthCredential` on the spot.
 *
 * Peer-free on purpose (doctor imports it): nothing here may import `openclaw`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  claudeKeychainAccount,
  keychainServiceForConfigDir,
  parseOauthCredential,
  type CredentialIo,
  type KeychainRead,
} from "./login-health.js";

/** One Keychain generic-password item, attributes only. */
export interface KeychainItemMeta {
  service: string;
  account: string;
  /** Last modification (epoch ms), when the Keychain reports it. */
  modifiedAt?: number;
}

export interface CredentialStoreIo extends CredentialIo {
  /**
   * Every generic-password item visible to the user, attributes only (no
   * secret is decrypted). Undefined when the Keychain cannot be listed.
   */
  listKeychainItems: () => KeychainItemMeta[] | undefined;
}

export interface StoreAccountShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export interface CredentialCopy {
  kind: "keychain" | "file";
  /** Human location: `keychain "<service>" acct=<account>` or the file path. */
  location: string;
  /** Keychain `acct`, for keychain copies. */
  keychainAccount?: string;
  /** Access-token expiry (epoch ms), when the copy could be read and records one. */
  expiresAt?: number;
  /** Why no expiry could be read, when that is the case. */
  unreadable?: string;
  /** Whether this is the copy the Claude CLI reads for this account (false when that is unknown). */
  active: boolean;
  /** Keychain modification time (epoch ms), when known. */
  modifiedAt?: number;
}

export interface SplitStoreReport {
  accountId: string;
  /** `split`: more than one copy exists. `single`/`none`: zero or one. `n/a`: not a stored-OAuth account. */
  status: "split" | "single" | "none" | "n/a";
  copies: CredentialCopy[];
  /**
   * Whether the copy the CLI reads could be established. False when the CLI's
   * own Keychain item exists but could not be read here: the CLI may read it
   * or fall back to the file, and this check cannot tell which.
   */
  activeKnown: boolean;
  /** The Keychain could not be listed, so same-service duplicates may be missing. */
  incomplete?: boolean;
  /** Keychain service checked, for the remedy text. */
  service?: string;
  /** The Keychain `acct` the CLI reads: its item is never offered for removal. */
  cliAccount?: string;
  /** Credentials file checked. */
  file?: string;
}

/**
 * Parse `security dump-keychain` output (run WITHOUT `-d`, so no secret is
 * decrypted) into generic-password items. Values arrive either quoted or as
 * `0x<hex>  "<printable>"`; the hex is authoritative.
 */
export function parseKeychainDump(text: string): KeychainItemMeta[] {
  const items: KeychainItemMeta[] = [];
  for (const block of text.split(/^keychain: /m)) {
    if (!/^class: "genp"/m.test(block)) continue;
    const attr = (name: string): string | undefined => {
      const m = block.match(new RegExp(`^\\s*"${name}"<[a-z]+>=(.*)$`, "m"));
      if (!m) return undefined;
      const value = m[1].trim();
      if (value === "<NULL>") return undefined;
      const hex = value.match(/^0x([0-9A-Fa-f]+)/);
      if (hex) return Buffer.from(hex[1], "hex").toString("utf8").replace(/\0+$/, "");
      const quoted = value.match(/^"(.*)"$/);
      return quoted ? quoted[1] : value;
    };
    const service = attr("svce");
    if (service === undefined) continue;
    const mdat = attr("mdat")?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/);
    items.push({
      service,
      account: attr("acct") ?? "",
      modifiedAt: mdat
        ? Date.UTC(+mdat[1], +mdat[2] - 1, +mdat[3], +mdat[4], +mdat[5], +mdat[6])
        : undefined,
    });
  }
  return items;
}

/** Keychain service + credentials file the CLI uses for this account, if it stores OAuth at all. */
export function credentialLocations(
  account: StoreAccountShape,
  io: Pick<CredentialIo, "expandHome">,
): { service: string; file: string } | undefined {
  if (account.oauthTokenFile || account.oauthTokenRef) return undefined;
  if (account.native) {
    return { service: CLAUDE_KEYCHAIN_SERVICE, file: io.expandHome("~/.claude/.credentials.json") };
  }
  if (!account.configDir) return undefined;
  const dir = io.expandHome(account.configDir).replace(/\/+$/, "");
  return { service: keychainServiceForConfigDir(dir), file: `${dir}/.credentials.json` };
}

/**
 * Every copy of one account's OAuth credential: each Keychain item under its
 * service (whatever its `acct`), plus the credentials file. Expiry is read per
 * copy with an explicit account; the secret is reduced to metadata at once.
 *
 * "Active" follows the CLI's own order, the same order assessAccountCredential
 * judges: its Keychain item when that exists, else the file.
 */
export function findCredentialCopies(
  account: StoreAccountShape,
  io: CredentialStoreIo,
): SplitStoreReport {
  const where = credentialLocations(account, io);
  if (!where) return { accountId: account.id, status: "n/a", copies: [], activeKnown: true };
  const copies: CredentialCopy[] = [];
  // What the CLI's own item is: decides which copy is active.
  let cliItem: KeychainRead["status"] = "absent";
  let incomplete = false;
  if (io.platform === "darwin") {
    const listed = io.listKeychainItems();
    incomplete = listed === undefined;
    const items = (listed ?? []).filter((i) => i.service === where.service);
    // The CLI's own item is always looked up directly: a listing that failed
    // or missed it must not make the active copy disappear from the report.
    if (!items.some((i) => i.account === io.keychainAccount)) {
      items.unshift({ service: where.service, account: io.keychainAccount });
    }
    for (const item of items) {
      const read = io.readKeychainItem(where.service, item.account);
      const isCli = item.account === io.keychainAccount;
      if (isCli) cliItem = read.status;
      if (read.status === "absent") continue;
      const meta = read.status === "found" ? parseOauthCredential(read.data) : undefined;
      copies.push({
        kind: "keychain",
        location: `keychain "${where.service}" acct=${item.account || "(empty)"}`,
        keychainAccount: item.account,
        expiresAt: meta?.expiresAt,
        unreadable:
          read.status === "unreadable"
            ? "could not be read (Keychain locked, access refused or timed out)"
            : meta
              ? undefined
              : "not a Claude OAuth credential",
        active: isCli && read.status === "found",
        modifiedAt: item.modifiedAt,
      });
    }
  }
  let fileRaw: string | undefined;
  let fileUnreadable = false;
  try {
    fileRaw = io.readFile(where.file);
  } catch (err) {
    // Missing is no copy; present but unreadable (permissions, a directory in
    // the way) is still a copy, just one this check cannot see into.
    const code = (err as { code?: unknown } | null)?.code;
    fileUnreadable = code !== "ENOENT" && code !== "ENOTDIR";
  }
  if (fileRaw !== undefined || fileUnreadable) {
    const meta = fileRaw === undefined ? undefined : parseOauthCredential(fileRaw);
    copies.push({
      kind: "file",
      location: where.file,
      expiresAt: meta?.expiresAt,
      unreadable: fileUnreadable
        ? "could not be read"
        : meta
          ? undefined
          : "not a Claude OAuth credential",
      // The CLI falls back to the file only when its Keychain item is absent.
      active: cliItem === "absent",
    });
  }
  return {
    accountId: account.id,
    status: copies.length > 1 ? "split" : copies.length === 1 ? "single" : "none",
    copies,
    activeKnown: cliItem !== "unreadable",
    incomplete: incomplete || undefined,
    service: where.service,
    cliAccount: io.platform === "darwin" ? io.keychainAccount : undefined,
    file: where.file,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Doctor lines for one split-store report: one line per copy (location,
 * account label, expiry, which one the CLI reads) and a remedy that removes
 * nothing until the copy the CLI reads has been proven.
 *
 * Which copy is stale is not knowable at rest. Expiry says when an access
 * token was minted, not whether the refresh token beside it still works; a
 * refresh that missed the Keychain leaves the only live refresh token in the
 * FILE. And a passing probe can ride an unexpired access token without ever
 * refreshing. So: reversible cleanup (moving the file aside) only after a
 * passing probe; irreversible cleanup (deleting a Keychain item) only after a
 * fresh login has put a new credential where the CLI reads it; the CLI's own
 * copy never; and nothing at all while which copy the CLI reads is unknown.
 */
export function describeSplitStore(report: SplitStoreReport, nowMs: number): {
  headline: string;
  copies: string[];
  remedy: string;
} {
  const fmt = (c: CredentialCopy) => {
    const expiry =
      c.expiresAt !== undefined
        ? `${c.expiresAt > nowMs ? "expires" : "expired"} ${new Date(c.expiresAt).toISOString()}`
        : (c.unreadable ?? "no expiry recorded");
    const modified =
      c.modifiedAt !== undefined ? `, last written ${new Date(c.modifiedAt).toISOString()}` : "";
    return `${c.location} — ${expiry}${modified}${c.active ? "  ← the copy the Claude CLI reads" : ""}`;
  };
  const active = report.copies.find((c) => c.active);
  const latest = Math.max(
    ...report.copies.map((c) => c.expiresAt ?? Number.NEGATIVE_INFINITY),
  );
  // Only claimed when the evidence is unambiguous: a strictly newer copy that
  // is not the one the CLI reads.
  const newerElsewhere =
    active?.expiresAt !== undefined &&
    Number.isFinite(latest) &&
    latest > active.expiresAt;
  const headline =
    `${report.accountId}: ${report.copies.length} copies of this login's OAuth credential — ` +
    `refresh tokens rotate, so once the copies diverge only the one refreshed last can still ` +
    `refresh, and a tool that reads another sees a login that is not the one in use` +
    (!report.activeKnown
      ? "; the Claude CLI's own Keychain item could not be read, so which copy it uses is unknown"
      : newerElsewhere
        ? "; a NEWER copy exists than the one the Claude CLI reads"
        : "");
  if (!report.activeKnown) {
    return {
      headline,
      copies: report.copies.map(fmt),
      remedy:
        `unlock the Keychain (or re-authenticate with \`multi-clawd login ${report.accountId}\`), ` +
        `confirm with \`multi-clawd doctor --probe\`, then re-run doctor for cleanup steps. ` +
        `Remove nothing until doctor can tell which copy the Claude CLI reads.`,
    };
  }
  const strays = report.copies.filter(
    (c) => !c.active && !(c.kind === "keychain" && c.keychainAccount === report.cliAccount),
  );
  const files = strays.filter((c) => c.kind === "file");
  const items = strays.filter((c) => c.kind === "keychain");
  const steps = [
    `first prove the copy the Claude CLI reads with \`multi-clawd doctor --probe\` ` +
      `(if it fails, re-authenticate with \`multi-clawd login ${report.accountId}\` and probe again)`,
  ];
  if (files.length > 0) {
    steps.push(
      `after a passing probe, move ${files.map((c) => shellQuote(c.location)).join(" and ")} aside ` +
        `(e.g. rename to .credentials.json.stale — reversible)`,
    );
  }
  if (items.length > 0) {
    steps.push(
      `delete a stray Keychain item only after a fresh \`multi-clawd login ${report.accountId}\` ` +
        `and a passing probe (a probe can pass on an unexpired access token while its refresh ` +
        `token is already dead): ` +
        items
          .map(
            (c) =>
              `\`security delete-generic-password -s ${shellQuote(report.service ?? "")} -a ${shellQuote(
                c.keychainAccount ?? "",
              )}\``,
          )
          .join(", ") +
        ` (irreversible)`,
    );
  }
  const remedy =
    `${steps.join("; ")}. Never remove the copy the Claude CLI reads: another copy may hold ` +
    `the only live refresh token until the CLI's own copy is proven.`;
  return { headline, copies: report.copies.map(fmt), remedy };
}

export function expandHomeDir(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

const SECURITY_TIMEOUT_MS = 10_000;

/** `security`'s exit status for "the specified item could not be found" (errSecItemNotFound). */
const SECURITY_ITEM_NOT_FOUND = 44;

type ExecFile = (file: string, args: string[], options: Record<string, unknown>) => string;

/**
 * The real system I/O. Every Keychain read names both service and account
 * (`-s` AND `-a`): without `-a`, `security` returns whichever same-service
 * item it finds first, which need not be the one the CLI uses. The data read
 * with `-w` is the secret; it is returned to the caller for immediate parsing
 * and goes nowhere else (stderr is discarded, nothing is logged, and a failed
 * command's error — which carries its output — is dropped, not rethrown).
 *
 * `exec` and `env` are injectable for tests of this exact command boundary.
 */
export function createSystemCredentialIo(
  deps: {
    exec?: ExecFile;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {},
): CredentialStoreIo {
  const exec: ExecFile =
    deps.exec ?? ((file, args, options) => execFileSync(file, args, options) as unknown as string);
  return {
    readFile: (p) => readFileSync(expandHomeDir(p), "utf8"),
    expandHome: expandHomeDir,
    keychainAccount: claudeKeychainAccount(deps.env ?? process.env, userInfo),
    platform: deps.platform ?? process.platform,
    readKeychainItem: (service, account): KeychainRead => {
      try {
        const data = exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: SECURITY_TIMEOUT_MS,
        });
        return { status: "found", data: data.replace(/\n$/, "") };
      } catch (err) {
        const status = (err as { status?: unknown } | null)?.status;
        return status === SECURITY_ITEM_NOT_FOUND ? { status: "absent" } : { status: "unreadable" };
      }
    },
    listKeychainItems: () => {
      try {
        // No `-d`: attributes only, nothing decrypted, no access prompt.
        const out = exec("security", ["dump-keychain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: SECURITY_TIMEOUT_MS * 3,
          maxBuffer: 64 * 1024 * 1024,
        });
        return parseKeychainDump(out);
      } catch {
        return undefined;
      }
    },
  };
}
