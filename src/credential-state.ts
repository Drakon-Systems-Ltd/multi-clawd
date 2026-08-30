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
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseStoredState,
  mergeHealthStates,
  clearCredentialFailure,
  type AccountHealthState,
} from "./shim-core.js";

/** Per-account health state written by the shim, read by the steering hook. */
export function healthStateFile(accountId: string): string {
  return join(homedir(), ".openclaw", "state", "multi-clawd", `${accountId}.json`);
}

/**
 * Clear a recorded credential failure for one account. Returns true only when
 * a failure was actually present and has been cleared, so callers can stay
 * silent on the common no-op.
 */
export function clearAccountCredentialFailure(accountId: string): boolean {
  const file = healthStateFile(accountId);
  let state: AccountHealthState;
  try {
    state = parseStoredState(readFileSync(file, "utf8")) ?? { accountId, windows: {} };
  } catch {
    return false; // nothing recorded → nothing to clear
  }
  if (state.credential?.status !== "failed") return false;
  const cleared = mergeHealthStates(state, clearCredentialFailure(state, Date.now()), Date.now());
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cleared, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
