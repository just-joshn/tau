// Independently authored deterministic MCP peer. No recovered modules imported.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [logPath, interaction] = process.argv.slice(2);
const log = (event) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + '\n');
log({ event: 'start' });
process.on('exit', code => log({ event: 'exit', code }));
process.on('SIGTERM', () => { log({ event: 'signal', signal: 'SIGTERM' }); process.exit(0); });
const lines = createInterface({ input: process.stdin });
lines.on('close', () => { log({ event: 'stdin-close' }); process.exit(0); });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { log({ event: 'invalid-json' }); return; }
  log({ event: 'request', message });
  if (message.id === undefined) return;
  let result, error;
  if (message.method === 'server/discover') error = { code: -32601, message: 'Independent legacy fixture' };
  else if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'disposable-fixture', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Return deterministic disposable fixture data.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...(interaction === 'required' ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}) }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture text' },
    { type: 'resource', resource: { uri: 'fixture://entry', mimeType: 'text/plain', text: 'fixture resource' } }], structuredContent: { answer: 42 }, isError: false };
  else if (message.method === 'ping') result = {};
  else error = { code: -32601, message: 'Unknown method' };
  const response = { jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) };
  log({ event: 'response', message: response });
  process.stdout.write(JSON.stringify(response) + '\n');
});
