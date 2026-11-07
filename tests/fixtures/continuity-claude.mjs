import { appendFileSync } from 'node:fs';
const log = (event) => appendFileSync(process.env.CONTINUITY_LOG, event + '\n');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const mode = process.env.CONTINUITY_MODE;
const sibling = process.env.MULTI_CLAWD_ACCOUNT_ID === 'two';
process.stdin.resume();
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(99); });
process.on('exit', () => log(sibling ? 'sibling-exit' : 'original-exit'));
if (sibling) {
  log('sibling-start');
  emit({ type: 'result', is_error: mode === 'exhaustion', result: mode === 'exhaustion' ? 'API Error: Repeated 529 Overloaded errors' : 'sibling success', api_error_status: mode === 'exhaustion' ? 529 : undefined });
  process.exitCode = mode === 'exhaustion' ? 1 : 0;
} else {
  log('original-start');
  const limit = mode === 'limit';
  // #126: a billing refusal is the CLI's typed `error: "billing_error"` kind on the synthetic notice (HTTP 400).
  const billing = mode === 'billing';
  emit({ type: 'assistant', is_api_error_message: true, error: limit ? 'rate_limit' : billing ? 'billing_error' : 'server_error', api_error_status: limit ? 429 : billing ? 400 : 529, api_error: limit ? 'usage_limit_reached' : undefined, message: { model: '<synthetic>', content: [{ type: 'text', text: limit ? "You've reached your Fable 5 limit." : billing ? 'Credit balance too low · Add funds: https://platform.claude.com/settings/billing' : 'API Error: Repeated 529 Overloaded errors' }] } });
  if (mode === 'cap') process.stdout.write('x'.repeat(270000));
  setTimeout(() => {
    if (mode !== 'notice-only' && mode !== 'cap') emit({ type: 'result', is_error: mode !== 'success', result: mode === 'auth' ? 'Failed to authenticate' : mode === 'success' ? 'original success' : 'terminal failure' });
    log('terminal');
    process.stdout.end();
    // EOF is deliberately earlier than process completion.
    setTimeout(() => { log('cleanup'); process.exitCode = mode === 'success' ? 0 : 1; }, 150);
  }, 1000);
}
