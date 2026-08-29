import { spawnSync } from 'node:child_process';

import { createDefaultOpenTuiTerminal } from '../src/terminal/opentui/renderer.ts';

function terminalMode() {
  const result = spawnSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`stty failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const before = terminalMode();
const terminal = createDefaultOpenTuiTerminal({
  cwd: process.cwd(),
  alternateOutput: true,
});

try {
  await terminal.start();
  terminal.accept({ type: 'runtime-ready' });
  terminal.accept({ type: 'user-message', messageId: 'pty-user', text: 'Check PTY restoration' });
  terminal.accept({
    type: 'message-started',
    messageId: 'pty-assistant',
    role: 'assistant',
    turnId: 'pty-turn',
  });
  terminal.accept({
    type: 'message-delta',
    messageId: 'pty-assistant',
    turnId: 'pty-turn',
    text: 'Accessible output is available.',
  });
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  await terminal.stop();
}

const after = terminalMode();
if (after !== before) throw new Error(`terminal mode was not restored: ${before} -> ${after}`);
process.stdout.write('\nOCTOCODE_PTY_RESTORED\n');
