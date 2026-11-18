/* Authored fixture only; no application modules imported. */
const fs = require('node:fs');
const [mode, logPath, scenario] = process.argv.slice(2);
if (mode === 'ready') {
  fs.appendFileSync(logPath, JSON.stringify({event: 'ready', pid: process.pid}) + '\n');
  process.stdout.write('owned-skill-hook-ready');
  process.exit(0);
}
const log = row => fs.appendFileSync(logPath, JSON.stringify({pid: process.pid, ...row}) + '\n');
log({event: 'start'});
process.on('exit', code => log({event: 'exit', code}));
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) process.exit(3); });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { process.exitCode = 3; return; }
  const invocation = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'input').length + 1;
  log({event: 'input', invocation, input, originEnvironment: {CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null, CLAUDE_SKILL_DIR: process.env.CLAUDE_SKILL_DIR ?? null}});
  if (invocation > 3) { process.stderr.write('OWNED_SKILL_HOOK_BOUND'); process.exitCode = 3; return; }
  if (scenario === 'pre-once' && invocation === 1) {
    process.stderr.write('OWNED_SKILL_PRE_BLOCK_FIRST'); process.exitCode = 2; return;
  }
  const output = {hookEventName: input.hook_event_name, additionalContext: 'OWNED_SKILL_HOOK_CONTEXT_' + invocation};
  if (input.hook_event_name === 'PreToolUse') output.permissionDecision = 'allow';
  process.stdout.write(JSON.stringify({hookSpecificOutput: output}) + '\n');
});
