/**
 * A base environment for tests that spawn the shim.
 *
 * Every such test used `...process.env`, which is fine on a developer box and
 * wrong on any box where the suite is run BY a multi-clawd-managed Claude
 * session — including, inevitably, an agent maintaining this repo. Those
 * processes already carry `MULTI_CLAWD_SESSION_DIRS`, `MULTI_CLAWD_ACCOUNT_ID`,
 * `MULTI_CLAWD_RETRY_ACCOUNTS` and `CLAUDE_CONFIG_DIR`, so the child under test
 * inherited the LIVE pool's configuration: `tests/session-handover.test.ts`
 * failed because the shim searched the operator's real `~/.claude` and copied a
 * genuine session transcript into a temp dir (observed 27 Sep 2026).
 *
 * A test must see exactly the environment it sets, so everything that steers
 * either half of this plugin is stripped first.
 */
const STRIPPED_PREFIXES = ["MULTI_CLAWD_", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_", "ANTHROPIC_"];

export function cleanShimEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
