import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { createCliRenderer } from '@opentui/core';

import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';
import { EditorWidget } from '../src/terminal/opentui/widgets/editor.js';
import { PromptInputWidget } from '../src/terminal/opentui/widgets/prompt-input.js';

const EVENT_COUNT = 10_000;
const MESSAGE_COUNT = 100;
const SENSITIVE_VALUES = Object.freeze({
  input: 'pty-sensitive-input-value',
  editor: 'pty-sensitive-editor-value',
});
const RESIZE_STORM = [
  { rows: 18, columns: 40, railVisible: false },
  { rows: 28, columns: 100, railVisible: true },
  { rows: 20, columns: 46, railVisible: false },
  { rows: 32, columns: 120, railVisible: true },
  { rows: 18, columns: 40, railVisible: false },
];

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
  const beforeSigwinchListenerCount = process.listenerCount('SIGWINCH');
  let renderer;
  let facade;
  let facadeDestroyCompleted = false;
  let rendererDestroyCompleted = false;
  const terminal = createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      renderer = await createCliRenderer({ exitOnCtrlC: false });
      facade = createOpenTuiRendererFacade(renderer, {
        events,
        cwd: process.cwd(),
        alternateOutput: true,
        interactionWidgetFactory(interaction) {
          if (interaction.request.type === 'input') {
            return new PromptInputWidget({
              id: `interaction-${interaction.generation}`,
              question: 'API key',
              sensitive: true,
              initialValue: SENSITIVE_VALUES.input,
            });
          }
          if (interaction.request.type === 'editor') {
            return new EditorWidget({
              id: `interaction-${interaction.generation}`,
              label: 'Private key',
              sensitive: true,
              initialValue: SENSITIVE_VALUES.editor,
            });
          }
          throw new Error(`unexpected PTY interaction type: ${interaction.request.type}`);
        },
      });
      return {
        render: (state) => facade.render(state),
        alternateOutput: () => facade.alternateOutput?.() ?? '',
        drainAnnouncements: () => facade.drainAnnouncements?.() ?? [],
        async destroy() {
          await facade.destroy();
          facadeDestroyCompleted = true;
          renderer.destroy();
          rendererDestroyCompleted = true;
        },
      };
    },
  });
  let started = false;
  let snapshotHash;
  let streamIntegrity;
  let resizeProof;
  const sensitiveInputProof = [];
  const resizeObservations = [];
  let activeMode;
  let stopPromiseReused = false;
  let failure;

  try {
    await terminal.start();
    started = true;
    activeMode = terminalMode();
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
    for (const kind of ['input', 'editor']) {
      const abortController = new AbortController();
      const resultPromise = terminal.interact?.(
        kind === 'input'
          ? { type: 'input', message: 'API key' }
          : { type: 'editor', message: 'Private key', initial: SENSITIVE_VALUES.editor },
        abortController.signal,
      );
      if (resultPromise === undefined) throw new Error('PTY terminal omitted interaction support');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const generation = terminal.snapshot().interaction?.generation;
      if (generation === undefined) throw new Error(`sensitive ${kind} interaction was not presented`);
      const controlId = `interaction-${generation}-${kind === 'input' ? 'input' : 'textarea'}`;
      const nativeControlMaterialized = renderer?.root.findDescendantById(controlId) !== undefined;
      const alternateOutput = facade?.alternateOutput?.() ?? '';
      const secret = SENSITIVE_VALUES[kind];
      const secretExposedInAlternateOutput = alternateOutput.includes(secret);
      sensitiveInputProof.push({
        kind,
        controlId,
        nativeControlMaterialized,
        secretExposedInAlternateOutput,
      });
      if (nativeControlMaterialized || secretExposedInAlternateOutput) {
        throw new Error(`sensitive ${kind} input did not fail closed`);
      }
      abortController.abort('PTY sensitive-input assertion complete');
      const result = await resultPromise;
      if (result.status !== 'cancelled') {
        throw new Error(`sensitive ${kind} interaction did not cancel cleanly: ${JSON.stringify(result)}`);
      }
    }
    for (const requested of RESIZE_STORM) {
      setTerminalSize(requested);
      process.kill(process.pid, 'SIGWINCH');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = terminalSize();
      let mechanism = 'sigwinch';
      if (renderer?.width !== requested.columns || renderer?.height !== requested.rows) {
        mechanism = 'explicit-renderer-resize-after-stty';
        renderer?.resize(requested.columns, requested.rows);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const rail = renderer?.root.findDescendantById('octocode-agent-rail');
      const composer = renderer?.root.findDescendantById('octocode-agent-composer');
      const observation = {
        requested: { rows: requested.rows, columns: requested.columns },
        observed,
        mechanism,
        rendererWidth: renderer?.width,
        rendererHeight: renderer?.height,
        composerVisible: composer?.visible !== false,
        railVisible: rail?.visible,
      };
      resizeObservations.push(observation);
      if (observed.rows !== requested.rows
        || observed.columns !== requested.columns
        || observation.rendererWidth !== requested.columns
        || observation.rendererHeight !== requested.rows
        || observation.composerVisible !== true
        || observation.railVisible !== requested.railVisible) {
        throw new Error(`responsive layout did not apply during resize storm: ${JSON.stringify(observation)}`);
      }
    }
    if (resizeObservations.length !== RESIZE_STORM.length) {
      throw new Error(`resize storm was not exercised: expected ${RESIZE_STORM.length} observations, got ${resizeObservations.length}`);
    }
    const finalResize = resizeObservations.at(-1);
    resizeProof = {
      observations: resizeObservations,
      finalRendererWidth: finalResize?.rendererWidth,
      finalRendererHeight: finalResize?.rendererHeight,
      finalComposerVisible: finalResize?.composerVisible,
      finalRailVisible: finalResize?.railVisible,
    };
    snapshotHash = sha256(JSON.stringify(snapshot));
  } catch (error) {
    failure = error;
  } finally {
    if (started) {
      try {
        const stopPromise = terminal.stop();
        stopPromiseReused = terminal.stop() === stopPromise;
        await stopPromise;
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
  const afterSigwinchListenerCount = process.listenerCount('SIGWINCH');
  const restored = afterMode === beforeMode
    && afterSize.rows === beforeSize.rows
    && afterSize.columns === beforeSize.columns;
  if (!restored && failure === undefined) failure = new Error('terminal mode or size was not restored exactly');
  const cleanupProof = {
    stopPromiseReused,
    facadeDestroyCompleted,
    rendererDestroyCompleted,
    beforeSigwinchListenerCount,
    afterSigwinchListenerCount,
    sigwinchListenersRestored: afterSigwinchListenerCount === beforeSigwinchListenerCount,
  };
  if (failure === undefined && (!stopPromiseReused
    || !facadeDestroyCompleted
    || !rendererDestroyCompleted
    || !cleanupProof.sigwinchListenersRestored)) {
    failure = new Error(`terminal cleanup was not fully observable: ${JSON.stringify(cleanupProof)}`);
  }

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
      resizeCount: RESIZE_STORM.length,
    },
    terminal: {
      beforeSize,
      afterSize,
      modeChangedWhileActive: activeMode !== undefined && activeMode !== beforeMode,
      modeRestored: afterMode === beforeMode,
      sizeRestored: afterSize.rows === beforeSize.rows && afterSize.columns === beforeSize.columns,
      cleanup: cleanupProof,
    },
    integrity: {
      ...(snapshotHash === undefined ? {} : { snapshotSha256: snapshotHash }),
      ...(streamIntegrity === undefined ? {} : { stream: streamIntegrity, streamLossless: true }),
    },
    sensitiveInput: {
      contract: 'fail-closed-without-native-control',
      cases: sensitiveInputProof,
      pass: sensitiveInputProof.length === 2
        && sensitiveInputProof.every((proof) => !proof.nativeControlMaterialized
          && !proof.secretExposedInAlternateOutput),
    },
    resizeProof,
    pass: failure === undefined && restored,
    ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    limitations: [
      'Exercises normal lifecycle, sustained Unicode presentation updates, five real stty size changes plus SIGWINCH with documented explicit renderer-resize fallback, and exact restoration only.',
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
