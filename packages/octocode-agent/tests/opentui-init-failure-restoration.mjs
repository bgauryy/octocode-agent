import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCliRenderer } from '@opentui/core';

import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import {
  createInitialPresentationState,
  reducePresentation,
} from '../src/terminal/opentui/presentation.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';

const INITIALIZATION_FAILURE = 'injected OpenTUI initialization failure';

function stty(args) {
  const result = spawnSync('stty', args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`stty ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function terminalSize() {
  const match = /^(\d+)\s+(\d+)$/u.exec(stty(['size']));
  if (!match) throw new Error('stty size returned an unsupported value');
  return { rows: Number(match[1]), columns: Number(match[2]) };
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

async function main() {
  if (process.platform === 'win32') throw new Error('This sensor requires a POSIX pseudo-terminal');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This sensor must run inside a real pseudo-terminal');
  }

  const beforeMode = stty(['-g']);
  const beforeSize = terminalSize();
  const beforeSigwinchListeners = process.listenerCount('SIGWINCH');
  const tempRoot = await mkdtemp(join(tmpdir(), 'octocode-terminal-init-failure-'));
  await writeFile(join(tempRoot, 'owned-artifact.txt'), 'initialization-owned temporary resource');
  const ownedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const ownedChildPid = ownedChild.pid;

  let rendererDestroyCount = 0;
  let observedFailure;
  let failure;
  const failingState = reducePresentation(createInitialPresentationState(), {
    type: 'interaction-requested',
    request: { type: 'confirm', message: 'Initialization rollback probe' },
  });
  const terminal = createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      const renderer = await createCliRenderer({ exitOnCtrlC: false });
      try {
        createOpenTuiRendererFacade(renderer, {
          events,
          initialState: failingState,
          interactionWidgetFactory: () => {
            throw new Error(INITIALIZATION_FAILURE);
          },
        });
      } catch (error) {
        renderer.destroy();
        rendererDestroyCount += 1;
        throw error;
      }
      throw new Error('initialization fault injection did not run');
    },
  });

  try {
    await terminal.start();
    failure = new Error('terminal initialization unexpectedly succeeded');
  } catch (error) {
    observedFailure = error;
    if (!(error instanceof Error) || error.message !== INITIALIZATION_FAILURE) {
      failure = new Error(`unexpected initialization failure: ${String(error)}`);
    }
  } finally {
    try {
      await terminal.stop();
    } catch (error) {
      failure ??= error;
    }
    if (ownedChildPid !== undefined && processExists(ownedChildPid)) ownedChild.kill('SIGTERM');
    if (ownedChild.exitCode === null && ownedChild.signalCode === null) await once(ownedChild, 'close');
    await rm(tempRoot, { recursive: true, force: true });
  }

  const afterMode = stty(['-g']);
  const afterSize = terminalSize();
  const restoration = {
    injectedFailureObserved: observedFailure instanceof Error
      && observedFailure.message === INITIALIZATION_FAILURE,
    rendererDestroyedExactlyOnce: rendererDestroyCount === 1,
    terminalModeRestored: afterMode === beforeMode,
    terminalSizeRestored: afterSize.rows === beforeSize.rows && afterSize.columns === beforeSize.columns,
    sigwinchListenersRestored: process.listenerCount('SIGWINCH') === beforeSigwinchListeners,
    childProcessesRemoved: ownedChildPid === undefined || !processExists(ownedChildPid),
    tempResourcesRemoved: !(await pathExists(tempRoot)),
  };
  if (failure === undefined && Object.values(restoration).some((value) => value !== true)) {
    failure = new Error(`initialization restoration incomplete: ${JSON.stringify(restoration)}`);
  }

  process.stdout.write(`\n${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-init-failure-restoration',
    restoration,
    pass: failure === undefined,
    ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
  })}\n`);
  if (failure !== undefined) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`\n${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-init-failure-restoration',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
