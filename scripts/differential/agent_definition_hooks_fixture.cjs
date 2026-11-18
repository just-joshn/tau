'use strict';
// Authored fixture only. This file is not executed by the static preparer.
const fs = require('node:fs');
const [mode, log, kind] = process.argv.slice(2);
if (mode === 'ready') {
  process.stdout.write('owned-agent-definition-hooks-ready');
} else if (mode === 'hook' && log && kind) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', part => { text += part; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(text);
      fs.appendFileSync(log, JSON.stringify({event: 'input', pid: process.pid, kind, input}) + '\n');
      process.stdout.write('{}');
      fs.appendFileSync(log, JSON.stringify({event: 'exit', pid: process.pid, kind, code: 0}) + '\n');
    } catch (error) {
      fs.appendFileSync(log, JSON.stringify({event: 'fixture-error', pid: process.pid, kind, message: String(error)}) + '\n');
      process.exitCode = 3;
    }
  });
} else {
  process.stderr.write('Owned fixture mode and explicit log/kind arguments are required.');
  process.exitCode = 3;
}
