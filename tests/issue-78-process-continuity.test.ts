import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanShimEnv } from './shim-env';

function run(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-78-'));
  const log = join(dir, 'events');
  const siblingState = join(dir, 'two.json');
  if (mode === 'no-idle') writeFileSync(siblingState, JSON.stringify({ accountId: 'two', credential: { status: 'failed', reason: 'fixture', seenAt: Date.now() }, windows: {} }));
  const res = spawnSync(process.execPath, [join(__dirname, '../dist/shim.js'), '-p', '--output-format', 'stream-json', '--model', 'claude-fable-5-1'], {
    input: 'fixture prompt\n', encoding: 'utf8',
    env: cleanShimEnv({ HOME: dir, OPENCLAW_STATE_DIR: dir, CLAUDE_CONFIG_DIR: dir,
      MULTI_CLAWD_CLAUDE_BIN: JSON.stringify([process.execPath, join(__dirname, 'fixtures/continuity-claude.mjs')]),
      MULTI_CLAWD_ACCOUNT_ID: 'one', MULTI_CLAWD_STATE_FILE: join(dir, 'one.json'),
      MULTI_CLAWD_RETRY_ACCOUNTS: JSON.stringify([{ id: 'two', stateFile: siblingState, env: { CLAUDE_CONFIG_DIR: join(dir, 'two') } }]),
      MULTI_CLAWD_HOLD_MAX_MS: mode === 'timeout' ? '100' : '5000',
      CONTINUITY_MODE: mode, CONTINUITY_LOG: log }),
  });
  return { res, events: readFileSync(log, 'utf8').trim().split('\n') };
}

test.each(['transient', 'limit', 'exhaustion'])('%s waits for terminal failure and natural close before replay', (mode) => {
  const { res, events } = run(mode);
  expect(events).toEqual(['original-start', 'terminal', 'cleanup', 'original-exit', 'sibling-start', 'sibling-exit']);
  expect(res.status).toBe(mode === 'exhaustion' ? 1 : 0);
  expect(res.stdout).not.toContain('<synthetic>');
  expect(res.stdout).toContain(mode === 'exhaustion' ? '529' : 'sibling success');
});

test.each(['success', 'auth', 'notice-only', 'timeout', 'cap', 'no-idle'])('%s preserves original completion without replay', (mode) => {
  const { res, events } = run(mode);
  expect(events).toEqual(['original-start', 'terminal', 'cleanup', 'original-exit']);
  expect(res.stdout).toContain('<synthetic>');
  expect(res.status).toBe(mode === 'success' ? 0 : 1);
  if (mode === 'success') expect(res.stdout).toContain('original success');
  if (mode === 'cap') expect(res.stdout).toContain('x'.repeat(270000));
});
