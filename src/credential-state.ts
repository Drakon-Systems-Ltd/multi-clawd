/**
 * Per-account credential-state file access, deliberately free of the
 * `openclaw` peer.
 *
 * This lives apart from index.ts for one reason: the CLI needs it. `multi-clawd`
 * installs globally, `openclaw` is a peerDependency, and on a machine where the
 * peer is not resolvable from the CLI's own directory every import of
 * index.ts throws ERR_MODULE_NOT_FOUND. `login` used to reach into index.ts for
 * the single call below and died in a peer-free global install while reporting
 * a missing build. Nothing here may import `openclaw`, directly or
 * transitively — tests/cli-peer-independence.test.ts enforces it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { persistHealthState, readHealthStateFile } from "./health-journal.js";
import {
  clearCredentialFailure,
} from "./shim-core.js";

/** Per-account health state written by the shim, read by the steering hook. */
export function healthStateFile(accountId: string): string {
  return join(homedir(), ".openclaw", "state", "multi-clawd", `${accountId}.json`);
}

/**
 * The usage poll's own per-account file (v1.10.1). Written ONLY by the poll,
 * as a whole snapshot each tick; readers merge it with the shim's health file
 * newest-wins. Keeping the poll out of the shim's file is what removes the
 * lost-update race between the two read-merge-write paths.
 */
export function usageStateFile(accountId: string): string {
  return join(homedir(), ".openclaw", "state", "multi-clawd", `${accountId}.usage.json`);
}

/**
 * Clear a recorded credential failure for one account. Returns true only when
 * a failure was actually present and has been cleared, so callers can stay
 * silent on the common no-op. A pending failure is included in that check.
 */
export function clearAccountCredentialFailure(accountId: string, file = healthStateFile(accountId)): boolean {
  const state = readHealthStateFile(file);
  if (state?.credential?.status !== "failed") return false;
  persistHealthState(file, clearCredentialFailure(state, Date.now()));
  return readHealthStateFile(file)?.credential?.status === "ok";
}
