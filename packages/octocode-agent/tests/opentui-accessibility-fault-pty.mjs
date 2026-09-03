import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCliRenderer } from '@opentui/core';

import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import { formatPresentationFrame } from '../src/terminal/opentui/presentation.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';

const RESIZE_STORM = Object.freeze([
  [18, 40], [19, 41], [20, 46], [24, 72], [28, 100],
  [16, 36], [32, 120], [18, 40],
]);
const PUBLIC_MARKERS = Object.freeze([
  'Accessible user message',
  'Accessible assistant result',
  'indexed-search',
  'compile-check',
  'Approval required for safe action',
  'Implement terminal matrix',
  'reviewer',
  'safe public failure',
]);
const PRIVATE_MARKERS = Object.freeze([
  'terminal-secret-value',
  'private-worker-route',
  'private worker prompt',
]);

function stty(args) {
  const result = spawnSync('stty', args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
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

function setTerminalSize(rows, columns) {
  stty(['rows', String(rows), 'cols', String(columns)]);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function immediate() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  if (process.platform === 'win32') throw new Error('This sensor requires a POSIX pseudo-terminal');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This sensor must run inside a real pseudo-terminal');
  }

  const beforeMode = terminalMode();
  const beforeSize = terminalSize();
  const beforeSigwinchListeners = process.listenerCount('SIGWINCH');
  const tempRoot = await mkdtemp(join(tmpdir(), 'octocode-terminal-fault-'));
  const tempArtifact = join(tempRoot, 'owned-artifact.txt');
  await writeFile(tempArtifact, 'temporary terminal sensor resource');

  let renderer;
  let facade;
  let activeMode;
  let accessibleOutput = '';
  let semanticFrame = '';
  let rendererFailure;
  let facadeDestroyCount = 0;
  let rendererDestroyCount = 0;
  let childCrash;
  let interruptedStreamObserved = false;
  let failure;
  const resizeObservations = [];
  const terminal = createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      renderer = await createCliRenderer({ exitOnCtrlC: false });
      facade = createOpenTuiRendererFacade(renderer, {
        events,
        cwd: process.cwd(),
        alternateOutput: true,
        reducedMotion: true,
      });
      return {
        render(state) {
          if (state.notifications.some(({ message }) => message === 'INJECT_RENDER_EXCEPTION')) {
            throw new Error('injected renderer exception');
          }
          facade.render(state);
        },
        alternateOutput: () => facade.alternateOutput?.() ?? '',
        drainAnnouncements: () => facade.drainAnnouncements?.() ?? [],
        async destroy() {
          await facade.destroy();
          facadeDestroyCount += 1;
          renderer.destroy();
          rendererDestroyCount += 1;
        },
      };
    },
  });

  try {
    await terminal.start();
    activeMode = terminalMode();
    terminal.accept({ type: 'runtime-ready' });
    terminal.accept({ type: 'turn-started', turnId: 'accessible-turn' });
    terminal.accept({
      type: 'user-message',
      messageId: 'accessible-user',
      turnId: 'accessible-turn',
      text: 'Accessible user message',
    });
    terminal.accept({
      type: 'message-started',
      messageId: 'accessible-assistant',
      role: 'assistant',
      turnId: 'accessible-turn',
    });
    terminal.accept({
      type: 'message-delta',
      messageId: 'accessible-assistant',
      turnId: 'accessible-turn',
      text: 'Accessible assistant result api_key=terminal-secret-value',
    });
    terminal.accept({
      type: 'plan-changed',
      plan: {
        authority: 'runtime',
        planId: 'terminal-matrix',
        scope: { sessionId: 'public-session', workspace: '/private/workspace' },
        revision: 1,
        phase: 'active',
        steps: [
          { id: 'matrix', text: 'Implement terminal matrix', status: 'doing' },
          { id: 'verify', text: 'Verify accessible output', status: 'todo' },
        ],
      },
    });
    terminal.accept({
      type: 'runtime-widgets-changed',
      snapshots: {
        statusNotifications: [{
          authority: 'runtime',
          slot: 'permission',
          id: 'approval-required',
          message: 'Approval required for safe action',
          lifecycle: 'active',
        }],
      },
    });
    terminal.accept({ type: 'tool-started', callId: 'search-attempt-1', name: 'indexed-search' });
    terminal.accept({
      type: 'tool-progress', callId: 'search-attempt-1', name: 'indexed-search',
      message: 'seven files', current: 7, total: 10,
    });
    terminal.accept({
      type: 'tool-progress', callId: 'search-attempt-1', name: 'indexed-search',
      message: 'reordered three files', current: 3, total: 10,
    });
    terminal.accept({
      type: 'tool-cancelled', callId: 'search-attempt-1', name: 'indexed-search',
      message: 'cancelled by user',
    });
    terminal.accept({ type: 'tool-started', callId: 'search-attempt-2', name: 'indexed-search' });
    terminal.accept({
      type: 'tool-ended', callId: 'search-attempt-2', name: 'indexed-search', result: 'retry completed',
    });
    terminal.accept({ type: 'tool-started', callId: 'compile-failure', name: 'compile-check' });
    terminal.accept({
      type: 'tool-failed', callId: 'compile-failure', name: 'compile-check',
      message: 'safe public failure', category: 'process',
    });
    terminal.accept({
      type: 'worker-changed',
      worker: {
        workerId: 'private-worker-route', agentType: 'reviewer', state: 'running',
        taskLabel: 'private worker prompt', timestamp: 1_000,
      },
    });
    terminal.accept({
      type: 'notification', key: 'provider', severity: 'info', message: 'Provider request started',
    });
    terminal.accept({
      type: 'notification', key: 'discovery', severity: 'info', message: 'MCP discovery started',
    });
    terminal.accept({
      type: 'notification', key: 'provider', severity: 'success', message: 'Provider request completed',
    });
    await immediate();

    semanticFrame = formatPresentationFrame(terminal.snapshot());
    accessibleOutput = facade?.alternateOutput?.() ?? '';
    for (const marker of PUBLIC_MARKERS) {
      if (!accessibleOutput.includes(marker)) {
        throw new Error(`accessible projection omitted ${JSON.stringify(marker)}: ${accessibleOutput.slice(-4_000)}`);
      }
    }
    for (const marker of PRIVATE_MARKERS) {
      if (accessibleOutput.includes(marker)) {
        throw new Error(`accessible projection exposed ${JSON.stringify(marker)}`);
      }
    }
    if (/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/u.test(accessibleOutput)) {
      throw new Error('accessible projection contained terminal control sequences');
    }
    for (const marker of PUBLIC_MARKERS.filter((value) => value !== 'Approval required for safe action')) {
      if (!semanticFrame.includes(marker) && !accessibleOutput.includes(marker)) {
        throw new Error(`semantic and accessible projections lost ${JSON.stringify(marker)}`);
      }
    }

    for (const [rows, columns] of RESIZE_STORM) {
      setTerminalSize(rows, columns);
      process.kill(process.pid, 'SIGWINCH');
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (renderer?.width !== columns || renderer?.height !== rows) renderer?.resize(columns, rows);
      await immediate();
      const observed = terminalSize();
      resizeObservations.push({ rows, columns, observed, renderer: { width: renderer?.width, height: renderer?.height } });
      if (observed.rows !== rows || observed.columns !== columns
        || renderer?.width !== columns || renderer?.height !== rows) {
        throw new Error(`resize storm mismatch at ${rows}x${columns}`);
      }
    }

    const crashingChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const crashingPid = crashingChild.pid;
    crashingChild.kill('SIGKILL');
    const [exitCode, exitSignal] = await once(crashingChild, 'close');
    childCrash = {
      pid: crashingPid,
      exitCode,
      exitSignal,
      processGone: crashingPid === undefined || !processExists(crashingPid),
    };
    if (!childCrash.processGone || exitSignal !== 'SIGKILL') {
      throw new Error(`injected child process crash did not settle cleanly: ${JSON.stringify(childCrash)}`);
    }

    const interruptedMessage = terminal.snapshot().messages.find(
      ({ id }) => id === 'accessible-assistant',
    );
    interruptedStreamObserved = interruptedMessage?.status === 'streaming'
      && interruptedMessage.segments.some(({ text }) => text.includes('Accessible assistant result'));
    if (!interruptedStreamObserved) {
      throw new Error('stream interruption precondition was not observable before renderer failure');
    }

    const observedFailure = new Promise((resolve) => terminal.subscribeFailure?.(resolve));
    terminal.accept({
      type: 'notification', key: 'renderer-fault', severity: 'error', message: 'INJECT_RENDER_EXCEPTION',
    });
    rendererFailure = await observedFailure;
    if (!(rendererFailure instanceof Error) || rendererFailure.message !== 'injected renderer exception') {
      throw new Error(`renderer exception was not reported: ${String(rendererFailure)}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      const first = terminal.stop();
      const second = terminal.stop();
      if (second !== first) throw new Error('concurrent shutdown did not reuse the stop promise');
      await Promise.all([first, second]);
    } catch (error) {
      failure ??= error;
    }
    try {
      setTerminalSize(beforeSize.rows, beforeSize.columns);
    } catch (error) {
      failure ??= error;
    }
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
    }
  }

  const afterMode = terminalMode();
  const afterSize = terminalSize();
  const afterSigwinchListeners = process.listenerCount('SIGWINCH');
  const restoration = {
    modeChangedWhileActive: activeMode !== undefined && activeMode !== beforeMode,
    modeRestored: afterMode === beforeMode,
    sizeRestored: afterSize.rows === beforeSize.rows && afterSize.columns === beforeSize.columns,
    sigwinchListenersRestored: afterSigwinchListeners === beforeSigwinchListeners,
    facadeDestroyExactlyOnce: facadeDestroyCount === 1,
    rendererDestroyExactlyOnce: rendererDestroyCount === 1,
    tempResourcesRemoved: !(await pathExists(tempRoot)),
    childProcessesRemoved: childCrash?.processGone === true,
  };
  if (failure === undefined && Object.values(restoration).some((value) => value !== true)) {
    failure = new Error(`restoration matrix incomplete: ${JSON.stringify(restoration)}`);
  }

  const report = {
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-accessibility-fault-matrix',
    platform: process.platform,
    arch: process.arch,
    ffiEnabled: process.execArgv.includes('--experimental-ffi')
      || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true,
    accessibility: {
      projection: 'append-only-semantic',
      publicMarkers: PUBLIC_MARKERS.map((marker) => ({ marker, observed: accessibleOutput.includes(marker) })),
      privateMarkersAbsent: PRIVATE_MARKERS.every((marker) => !accessibleOutput.includes(marker)),
      controlSequencesAbsent: !/\u001b/u.test(accessibleOutput),
      semanticParity: true,
    },
    notifications: {
      burstOrdering: terminal.snapshot().notifications.map(({ key }) => key),
      cancellation: true,
      distinctRetry: true,
    },
    faults: {
      rendererExceptionReported: rendererFailure instanceof Error,
      childProcessCrash: childCrash,
      interruptedStream: interruptedStreamObserved,
      resizeStormCount: resizeObservations.length,
      concurrentShutdown: true,
    },
    restoration,
    pass: failure === undefined,
    ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
  };
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  if (!report.pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`\n${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-accessibility-fault-matrix',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
