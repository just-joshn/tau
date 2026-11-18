// Independently authored readiness and SubagentStart fixture. No CLI imported.
const fs = require('node:fs');
const [mode, target, extra] = process.argv.slice(2);
if (mode === 'hook') {
  const log = value => fs.appendFileSync(target, JSON.stringify({ pid: process.pid, ppid: process.ppid, ...value }) + '\n');
  log({ event: 'start' }); process.on('exit', code => log({ event: 'exit', code }));
  let raw = ''; process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 1048576) process.exit(9); });
  process.stdin.on('end', () => { log({ event: 'input', input: JSON.parse(raw) }); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'OWNED_CHILD_CAP_START_CONTEXT' } })); });
} else if (mode === 'ready') {
  const caseName = extra;
  const send = async (scope, content = []) => {
    const body = { model: 'claude-sonnet-4-6', stream: true, system: 'OWNED_PROTOCOL_REHEARSAL', messages: [{ role: 'user', content: [...(scope === 'child' ? [{ type: 'text', text: 'OWNED_CHILD_CAP_DELEGATION_ONLY' }] : []), ...content] }] };
    const response = await fetch(target + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Owned rehearsal response rejected');
    return response.text();
  };
  (async () => {
    await send('parent');
    for (let i = 0; i < (caseName === 'builtin-default' ? 2 : 8); i++) await send('child');
    await send('parent');
    if (caseName !== 'builtin-default') await send('parent');
    process.stdout.write('owned-child-workflow-ready');
  })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
} else process.exitCode = 8;
