/**
 * Login-health classification (v0.3): registration success must stop masking
 * dead logins. This checks that each account's credential *source* actually
 * holds something plausible — it does not spend quota on live probes.
 *
 * Observed failure this guards against: native
 * credentials went blank while the backend still registered fine, so every
 * turn failed "Not logged in" with no operator-visible warning.
 *
 * And its quieter twin: a credential that is present but dead. Checking only
 * that a Keychain item EXISTS reported "alive" for an item holding an expired
 * access token whose refresh token had already been rotated away, while every
 * real turn failed "OAuth session expired and could not be refreshed". So the
 * source is now judged on evidence — an unexpired access token, or a
 * successful turn since it expired — and never on presence alone.
 */

import { parseSetupTokenFile } from "./account-env.js";
import { createHash } from "node:crypto";

export interface CredentialAccountShape {
  id: string;
  native?: boolean;
  configDir?: string;
  oauthTokenFile?: string;
  oauthTokenRef?: Record<string, unknown>;
}

export interface CredentialIo {
  /** Read a file (path may be `~`-relative); throws when unreadable. */
  readFile: (path: string) => string;
  /** Expand a possibly `~`-relative path to the absolute one the CLI hashes. */
  expandHome: (path: string) => string;
  /**
   * macOS: the generic-password item for exactly this (service, account) pair.
   * `absent` only when the Keychain says there is no such item; a locked
   * Keychain, a refused access or a timeout is `unreadable`, which proves
   * nothing either way. `data` IS the secret: callers hand it straight to
   * `parseOauthCredential`, which keeps only metadata, and never log, return
   * or print it.
   */
  readKeychainItem: (service: string, account: string) => KeychainRead;
  /** The Keychain `acct` the Claude CLI files its credential under (see claudeKeychainAccount). */
  keychainAccount: string;
  platform: NodeJS.Platform;
}

export type KeychainRead =
  | { status: "found"; data: string }
  | { status: "absent" }
  | { status: "unreadable" };

/** Keychain service the Claude CLI uses for its default config dir. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The Keychain `acct` the Claude CLI reads and writes: `$USER`, else the OS
 * user name, else a fixed fallback — the CLI's own rule, mirrored exactly.
 *
 * It matters which item is read. More than one item can carry the same
 * service name under different accounts, and `security find-generic-password
 * -s <service>` without `-a` returns whichever it finds first, which need not
 * be the one the CLI uses. Every read here therefore names the account.
 */
export function claudeKeychainAccount(
  env: Record<string, string | undefined>,
  userInfo: () => { username: string },
): string {
  try {
    return env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

/**
 * Keychain service name Claude Code uses for a non-default `CLAUDE_CONFIG_DIR`:
 * the default-dir item is `Claude Code-credentials`; every other dir gets a
 * suffix of the first 8 hex chars of sha256(absolute dir path). `absDir` must
 * be the expanded, resolved path — hashing `~/.x` yields the wrong item.
 */
export function keychainServiceForConfigDir(absDir: string): string {
  const hash = createHash("sha256").update(absDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/**
 * What a credential source says about its login, judged on evidence:
 *
 * - `ok`: the stored access token is unexpired, or it has expired but a
 *   successful turn since then proves the CLI refreshed it.
 * - `unverified`: a credential is stored, but its access token has expired and
 *   nothing since has proven that the refresh works. This is the normal state
 *   of an idle account, and also exactly how a login whose refresh token has
 *   died looks at rest, so it is reported as neither alive nor dead.
 * - `broken`: no usable credential where the CLI will look.
 * - `unknown`: this check cannot see the source (secret refs).
 */
export interface CredentialCheck {
  status: "ok" | "unverified" | "broken" | "unknown";
  /** Why the status is not `ok`. */
  reason?: string;
  /** For `ok`: what proved it. */
  detail?: string;
  /** When the stored access token expires (epoch ms), when known. */
  expiresAt?: number;
  /** Where the credential was read from (Keychain item or file path). Never a value. */
  source?: string;
}

/** Evidence, from outside the credential store, that the login works. */
export interface CredentialProof {
  /** Last time the API accepted this account's login (epoch ms), if ever seen. */
  lastSuccessAt?: number;
}

/**
 * How recent a successful turn must be to prove a refresh. A turn proves the
 * refresh token worked at that moment; a day later it may have been revoked.
 */
export const AUTH_PROOF_FRESH_MS = 24 * 60 * 60 * 1000;

/** An access token this close to expiry is treated as expired. */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** 9999-12-31T23:59:59Z. */
const MAX_PLAUSIBLE_EXPIRY_MS = 253402300799000;

/** The non-secret shape of a stored `claudeAiOauth` credential. */
export interface OauthCredentialMeta {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  /** Epoch ms. */
  expiresAt?: number;
}

/**
 * Reduce a stored Claude credential (Keychain data or `.credentials.json`) to
 * metadata. The token strings are tested for presence and dropped here; they
 * never leave this function. Undefined when the text is not a Claude OAuth
 * credential at all.
 */
export function parseOauthCredential(raw: string): OauthCredentialMeta | undefined {
  let text = raw.trim();
  // `security -w` prints the data hex-encoded when it is not plain text.
  if (/^(?:[0-9a-f]{2})+$/i.test(text)) {
    text = Buffer.from(text, "hex").toString("utf8").trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const o = oauth as Record<string, unknown>;
  const present = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  let expiresAt: number | undefined;
  if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) && o.expiresAt > 0) {
    // Milliseconds in every CLI release seen; seconds tolerated.
    const ms = o.expiresAt < 1e12 ? o.expiresAt * 1000 : o.expiresAt;
    // Past year 9999 is garbage, not an expiry (and past the Date range it
    // would throw when formatted).
    if (ms < MAX_PLAUSIBLE_EXPIRY_MS) expiresAt = ms;
  }
  return {
    hasAccessToken: present(o.accessToken),
    hasRefreshToken: present(o.refreshToken),
    expiresAt,
  };
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 90 ? `${min}m` : `${Math.round(min / 60)}h`;
}

/**
 * Judge one stored credential. Presence is not health: an item holding an
 * expired access token and a refresh token the server has already rotated
 * away looks exactly like a working login until a turn tries to use it.
 */
export function judgeOauthCredential(
  meta: OauthCredentialMeta,
  source: string,
  proof: CredentialProof,
  nowMs: number,
): CredentialCheck {
  const base = { source, expiresAt: meta.expiresAt };
  if (!meta.hasAccessToken) {
    return { ...base, status: "broken", reason: `${source}: access token is blank` };
  }
  if (meta.expiresAt !== undefined && meta.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS > nowMs) {
    return {
      ...base,
      status: "ok",
      detail: `access token valid until ${new Date(meta.expiresAt).toISOString()}`,
    };
  }
  if (meta.expiresAt === undefined) {
    // Without an expiry no success can be placed after it, so nothing here can
    // prove the refresh works.
    return {
      ...base,
      status: "unverified",
      reason: `${source}: records no access-token expiry, so it cannot be judged at rest`,
    };
  }
  const expiry = `access token expired ${new Date(meta.expiresAt).toISOString()}`;
  const success = proof.lastSuccessAt;
  if (
    success !== undefined &&
    success <= nowMs &&
    nowMs - success <= AUTH_PROOF_FRESH_MS &&
    success >= meta.expiresAt
  ) {
    return {
      ...base,
      status: "ok",
      detail: `${expiry}; a successful turn ${ago(nowMs - success)} ago proves the refresh works`,
    };
  }
  if (!meta.hasRefreshToken) {
    return {
      ...base,
      status: "broken",
      reason: `${source}: ${expiry} and no refresh token is stored`,
    };
  }
  return {
    ...base,
    status: "unverified",
    reason: `${source}: ${expiry} and no successful turn since proves the refresh works`,
  };
}

/**
 * Ref-resolution outcome as classified by token-resolution's resolveDetailed.
 * (Mirrored here rather than imported to keep this module dependency-free.)
 */
export interface RefProbeResult {
  value?: string;
  failure?: "provider_error" | "empty_result";
}

export interface RefProbeStatus {
  status: "ok" | "degraded" | "broken";
  /**
   * Which evidence produced a `broken` verdict. The distinction is the whole
   * point: `credential` means the resolver ran and the credential itself is
   * wrong, which is positive evidence against this ACCOUNT; `provider` means
   * the resolver never got an answer, which is evidence about the BOX and says
   * nothing about the account. Only the former may influence account
   * selection — a box-wide outage breaks every probe at once, so acting on it
   * would rotate away from a perfectly good login and fix nothing.
   */
  cause?: "credential" | "provider";
  reason?: string;
}

export interface RefProbeTracker {
  observe(result: RefProbeResult, nowMs: number): RefProbeStatus;
}

/**
 * Pure per-account state machine for the async oauthTokenRef probe: it
 * separates a transient provider outage (timeout/network → degrade, retry)
 * from a real credential problem (resolver ran, got nothing → broken now).
 *
 * - empty_result → broken immediately (a credential problem, not a blip).
 * - provider_error → DEGRADED and retried; only declared broken after
 *   `deadAfterConsecutive` consecutive provider errors AND at least
 *   `deadAfterMs` elapsed since the first failure of the streak (both, so a
 *   burst of fast failures cannot trip a false "login dead" alert).
 * - a resolved value resets the streak and clears the degraded flag.
 */
export function createRefProbeTracker(
  options: { deadAfterConsecutive?: number; deadAfterMs?: number } = {},
): RefProbeTracker {
  const deadAfterConsecutive = options.deadAfterConsecutive ?? 3;
  const deadAfterMs = options.deadAfterMs ?? 10 * 60 * 1000;
  let consecutive = 0;
  let firstFailureAt: number | undefined;

  return {
    observe(result, nowMs) {
      if (result.value !== undefined) {
        consecutive = 0;
        firstFailureAt = undefined;
        return { status: "ok" };
      }
      if (result.failure === "empty_result") {
        consecutive = 0;
        firstFailureAt = undefined;
        return {
          status: "broken",
          cause: "credential",
          reason: "oauthTokenRef resolved to nothing (credential problem)",
        };
      }
      // provider_error (or an unknown/absent failure treated as transient)
      if (consecutive === 0) firstFailureAt = nowMs;
      consecutive += 1;
      const elapsed = nowMs - (firstFailureAt ?? nowMs);
      if (consecutive >= deadAfterConsecutive && elapsed >= deadAfterMs) {
        return {
          status: "broken",
          cause: "provider",
          reason: `resolver failing ${deadAfterConsecutive}+ consecutive probes over ${Math.round(
            deadAfterMs / 60000,
          )}m`,
        };
      }
      return {
        status: "degraded",
        reason: `resolver error (network?) — streak ${consecutive}/${deadAfterConsecutive}`,
      };
    },
  };
}

/** Undefined when the file cannot be read at all. */
function assessCredentialsJson(
  io: CredentialIo,
  path: string,
  proof: CredentialProof,
  nowMs: number,
): CredentialCheck | undefined {
  let raw: string;
  try {
    raw = io.readFile(path);
  } catch {
    return undefined;
  }
  const meta = parseOauthCredential(raw);
  if (!meta) {
    return { status: "broken", reason: `${path} holds no Claude OAuth credential`, source: path };
  }
  return judgeOauthCredential(meta, path, proof, nowMs);
}

/**
 * The Keychain item the CLI reads for this service, under the account it
 * uses. Undefined only when the Keychain says there is no such item, so the
 * caller can fall back to the file the CLI falls back to. An item that exists
 * but cannot be read here is `unknown`: whether the CLI reads it or the file
 * cannot be told, so neither is judged.
 */
function assessKeychain(
  io: CredentialIo,
  service: string,
  proof: CredentialProof,
  nowMs: number,
): CredentialCheck | undefined {
  const read = io.readKeychainItem(service, io.keychainAccount);
  if (read.status === "absent") return undefined;
  const source = `keychain "${service}"`;
  if (read.status === "unreadable") {
    return {
      status: "unknown",
      reason: `${source} could not be read (Keychain locked, access refused or timed out) — not judged`,
      source,
    };
  }
  const meta = parseOauthCredential(read.data);
  if (!meta) return { status: "broken", reason: `${source} holds no Claude OAuth credential`, source };
  return judgeOauthCredential(meta, source, proof, nowMs);
}

/**
 * Credential-source health for one account, judged on evidence (see
 * CredentialCheck). On macOS the Claude CLI reads the Keychain first and only
 * falls back to `<dir>/.credentials.json` when the Keychain holds nothing for
 * it, so this checks the same places in the same order.
 */
export function assessAccountCredential(
  account: CredentialAccountShape,
  io: CredentialIo,
  options: { proof?: CredentialProof; nowMs?: number } = {},
): CredentialCheck {
  const proof = options.proof ?? {};
  const nowMs = options.nowMs ?? Date.now();
  if (account.oauthTokenFile) {
    let raw: string;
    try {
      raw = io.readFile(account.oauthTokenFile);
    } catch {
      return { status: "broken", reason: `${account.oauthTokenFile} unreadable` };
    }
    // The same parse the launch uses, so the probe and doctor call a file
    // broken exactly when a launch would refuse it — including the common
    // `claude setup-token > file` capture of the whole screen.
    const read = parseSetupTokenFile(raw, account.oauthTokenFile);
    if ("token" in read) return { status: "ok", detail: "setup-token present" };
    return { status: "broken", reason: read.error };
  }
  if (account.oauthTokenRef) {
    // Refs are validated by the async resolver path; sync check can't see them.
    return { status: "unknown" };
  }
  const dir = account.native ? "~/.claude" : account.configDir;
  if (!dir) return { status: "unknown" };
  const path = `${dir.replace(/\/+$/, "")}/.credentials.json`;
  if (io.platform !== "darwin") {
    return (
      assessCredentialsJson(io, path, proof, nowMs) ?? {
        status: "broken",
        reason: `${path} unreadable`,
        source: path,
      }
    );
  }
  const service = account.native
    ? CLAUDE_KEYCHAIN_SERVICE
    : keychainServiceForConfigDir(io.expandHome(dir));
  return (
    assessKeychain(io, service, proof, nowMs) ??
    assessCredentialsJson(io, path, proof, nowMs) ?? {
      status: "broken",
      reason: `keychain has no Claude Code credentials for ${
        account.native ? "the default login" : dir
      } and ${path} unreadable`,
    }
  );
}
