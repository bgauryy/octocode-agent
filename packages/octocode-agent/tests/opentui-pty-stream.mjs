import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { createCliRenderer } from '@opentui/core';

import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';

const EVENT_COUNT = 10_000;
const MESSAGE_COUNT = 100;

function stty(args) {
  const result = spawnSync('stty', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`stty ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function terminalMode() {
  return stty(['-g']);
}

function terminalSize() {
  const match = /^(\d+)\s+(\d+)$/u.exec(stty(['size']));
  if (!match) throw new Error('stty size returned an unsupported value');
  return { rows: Number(match[1]), columns: Number(match[2]) };
}

function setTerminalSize(size) {
  stty(['rows', String(size.rows), 'cols', String(size.columns)]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function streamChunk(index) {
  return index % 2 === 0 ? 'λ🙂' : 'e\u0301';
}

function expectedStream() {
  const messages = Array.from({ length: MESSAGE_COUNT }, () => '');
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    messages[index % MESSAGE_COUNT] += streamChunk(index);
  }
  return messages;
}

function observedStream(snapshot) {
  return snapshot.messages.map((message) => message.segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join(''));
}

async function main() {
  if (process.platform === 'win32') {
    throw new Error('This sensor requires a POSIX pseudo-terminal with stty');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This sensor must run inside a real pseudo-terminal');
  }

  const beforeMode = terminalMode();
  const beforeSize = terminalSize();
  const resized = {
    rows: Math.max(8, Math.min(18, beforeSize.rows === 18 ? 17 : 18)),
    columns: Math.max(20, Math.min(48, beforeSize.columns === 48 ? 47 : 48)),
  };
  let renderer;
  let facade;
  const terminal = createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      renderer = await createCliRenderer({ exitOnCtrlC: false });
      facade = createOpenTuiRendererFacade(renderer, {
        events,
        cwd: process.cwd(),
        alternateOutput: true,
      });
      return {
        render: (state) => facade.render(state),
        alternateOutput: () => facade.alternateOutput?.() ?? '',
        drainAnnouncements: () => facade.drainAnnouncements?.() ?? [],
        async destroy() {
          await facade.destroy();
          renderer.destroy();
        },
      };
    },
  });
  let started = false;
  let snapshotHash;
  let streamIntegrity;
  let resizeProof;
  let resizeMechanism = 'sigwinch';
  let observedResize;
  let failure;

  try {
    await terminal.start();
    started = true;
    terminal.accept({ type: 'runtime-ready' });
    const expectedMessages = expectedStream();
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      terminal.accept({
        type: 'message-started',
        messageId: `pty-stream-${index}`,
        role: 'assistant',
        turnId: 'pty-turn',
      });
    }
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      terminal.accept({
        type: 'message-delta',
        messageId: `pty-stream-${index % MESSAGE_COUNT}`,
        turnId: 'pty-turn',
        text: streamChunk(index),
      });
    }
    setTerminalSize(resized);
    process.kill(process.pid, 'SIGWINCH');
    await new Promise((resolve) => setTimeout(resolve, 75));
    observedResize = terminalSize();
    if (renderer?.width !== resized.columns || renderer?.height !== resized.rows) {
      resizeMechanism = 'explicit-renderer-resize-after-stty';
      renderer?.resize(resized.columns, resized.rows);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const snapshot = terminal.snapshot();
    const observedMessages = observedStream(snapshot);
    const expectedContent = expectedMessages.join('\n');
    const observedContent = observedMessages.join('\n');
    streamIntegrity = {
      expectedMessageCount: MESSAGE_COUNT,
      observedMessageCount: observedMessages.length,
      expectedCodeUnits: expectedContent.length,
      observedCodeUnits: observedContent.length,
      expectedSha256: sha256(expectedContent),
      observedSha256: sha256(observedContent),
    };
    if (expectedMessages.length !== observedMessages.length
      || !expectedMessages.every((message, index) => observedMessages[index] === message)) {
      throw new Error('10,000-event Unicode stream content/hash/length mismatch');
    }
    const rail = renderer?.root.findDescendantById('octocode-agent-rail');
    const composer = renderer?.root.findDescendantById('octocode-agent-composer');
    resizeProof = {
      rendererWidth: renderer?.width,
      rendererHeight: renderer?.height,
      composerVisible: composer?.visible !== false,
      railVisible: rail?.visible,
    };
    if (resizeProof.rendererWidth !== resized.columns
      || resizeProof.rendererHeight !== resized.rows
      || resizeProof.composerVisible !== true
      || resizeProof.railVisible !== false) {
      throw new Error(`responsive layout did not apply after resize: ${JSON.stringify(resizeProof)}`);
    }
    snapshotHash = sha256(JSON.stringify(snapshot));
  } catch (error) {
    failure = error;
  } finally {
    if (started) {
      try {
        await terminal.stop();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      setTerminalSize(beforeSize);
    } catch (error) {
      failure ??= error;
    }
  }

  const afterMode = terminalMode();
  const afterSize = terminalSize();
  const restored = afterMode === beforeMode
    && afterSize.rows === beforeSize.rows
    && afterSize.columns === beforeSize.columns;
  if (!restored && failure === undefined) failure = new Error('terminal mode or size was not restored exactly');

  const report = {
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-pty-stream',
    metadata: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ffiEnabled: process.execArgv.includes('--experimental-ffi')
        || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true,
      eventCount: EVENT_COUNT,
      messageCount: MESSAGE_COUNT,
    },
    terminal: {
      beforeSize,
      requestedResize: resized,
      observedResize,
      resizeMechanism,
      afterSize,
      modeRestored: afterMode === beforeMode,
      sizeRestored: afterSize.rows === beforeSize.rows && afterSize.columns === beforeSize.columns,
    },
    integrity: {
      ...(snapshotHash === undefined ? {} : { snapshotSha256: snapshotHash }),
      ...(streamIntegrity === undefined ? {} : { stream: streamIntegrity, streamLossless: true }),
    },
    resizeProof,
    pass: failure === undefined && restored,
    ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    limitations: [
      'Exercises normal lifecycle, sustained Unicode presentation updates, a real stty size change plus SIGWINCH with documented explicit renderer-resize fallback, and exact restoration only.',
      'Does not claim real SIGINT, SIGTERM, renderer-crash, or process-crash coverage.',
      'Requires a POSIX pseudo-terminal with stty and an OpenTUI-supported runtime/FFI route.',
    ],
  };
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  if (!report.pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`\n${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-pty-stream',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
