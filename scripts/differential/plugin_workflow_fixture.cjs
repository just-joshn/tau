// Independently authored fixture. No recovered module or external service is used.
const fs = require('node:fs');
const [mode, logPath, caseName] = process.argv.slice(2);
if (mode === 'ready') {
  process.stdout.write('owned-plugin-workflow-ready');
} else {
  const log = value => fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ppid: process.ppid, case: caseName, mode, ...value }) + '\n');
  log({ event: 'start', root: process.env.CLAUDE_PLUGIN_ROOT, data: process.env.CLAUDE_PLUGIN_DATA });
  process.on('exit', code => log({ event: 'exit', code }));
  process.on('SIGTERM', () => { log({ event: 'signal', signal: 'SIGTERM' }); process.exit(0); });
  if (mode === 'hook') {
    let raw = '';
    process.stdin.on('data', data => { raw += data; if (raw.length > 1048576) process.exit(9); });
    process.stdin.on('end', () => {
      log({ event: 'input', input: JSON.parse(raw) });
      process.stdout.write('{}');
    });
  } else if (mode === 'mcp') {
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('close', () => { log({ event: 'stdin-close' }); process.exit(0); });
    lines.on('line', line => {
      if (line.length > 1048576) process.exit(9);
      const message = JSON.parse(line); log({ event: 'request', message });
      if (message.id === undefined) return;
      let result, error;
      if (message.method === 'server/discover') error = { code: -32601, message: 'Owned legacy fixture' };
      else if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned-plugin-fixture', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return the owned local plugin marker.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
      else if (message.method === 'tools/call' && message.params?.name === 'echo' && message.params?.arguments?.value === 'OWNED_PLUGIN_ECHO_INPUT') result = { content: [{ type: 'text', text: 'OWNED_PLUGIN_ECHO_REPLY' }], structuredContent: { marker: 'OWNED_PLUGIN_ECHO_STRUCTURED' }, isError: false };
      else if (message.method === 'ping') result = {};
      else error = { code: -32601, message: 'Unknown owned fixture operation' };
      const response = { jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) };
      log({ event: 'response', message: response }); process.stdout.write(JSON.stringify(response) + '\n');
    });
  } else process.exit(8);
}
