// Authored mock-only protocol rehearsal. Runs no CLI or recovered code.
const fs = require('node:fs');
const [base, caseName, output] = process.argv.slice(2);
const marker = 'OWNED_AGENT_SYSTEM_READER';
const send = async (scope, messages = []) => {
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, system: scope === 'child' ? marker : 'OWNED_READINESS_PARENT', messages }), signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('Owned mock readiness HTTP failed');
  return response.text();
};
const result = (id, text) => [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }];
(async () => {
  await send('parent');
  if (caseName === 'gated-background') {
    fs.writeFileSync(output, 'OWNED_BACKGROUND_INITIAL_OUTPUT');
    const waitingChild = send('child');
    await send('parent', result('owned-background-parent-1', 'output_file: ' + output));
    await waitingChild;
    await send('child', result('owned-background-child-1', 'OWNED_BACKGROUND_FILE'));
    fs.writeFileSync(output, 'OWNED_BACKGROUND_CHILD_FINAL');
    await send('parent', [{ role: 'user', content: [{ type: 'text', text: '<task-notification>OWNED_BACKGROUND_CHILD_FINAL total_tokens: 16</task-notification>' }] }]);
    await send('parent', result('owned-background-output-read', 'OWNED_BACKGROUND_CHILD_FINAL'));
  } else {
    await send('child');
    await send('parent', result('owned-background-parent-1', 'OWNED_DISABLED_CHILD_FINAL'));
  }
  process.stdout.write('owned-background-protocol-ready');
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
