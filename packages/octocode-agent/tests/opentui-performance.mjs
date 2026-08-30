import { createHash } from 'node:crypto';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import { createTestRenderer } from '@opentui/core/testing';

import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';

const EVENT_COUNT = 10_000;
const MESSAGE_COUNT = 100;
const WIDTH = 80;
const HEIGHT = 24;
const RESIZED_WIDTH = 40;
const RESIZED_HEIGHT = 18;

const thresholdDefinitions = Object.freeze({
  firstRenderMs: 'OCTOCODE_TUI_MAX_FIRST_RENDER_MS',
  sustainedEventsMs: 'OCTOCODE_TUI_MAX_STREAM_MS',
  resizeRecoveryMs: 'OCTOCODE_TUI_MAX_RESIZE_MS',
  shutdownMs: 'OCTOCODE_TUI_MAX_SHUTDOWN_MS',
  peakRssBytesSampled: 'OCTOCODE_TUI_MAX_PEAK_RSS_BYTES',
});

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(3));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sampledRss() {
  return process.memoryUsage().rss;
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

function configuredThresholds() {
  const values = {};
  for (const [metric, variable] of Object.entries(thresholdDefinitions)) {
    const raw = process.env[variable];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${variable} must be a finite non-negative number`);
    }
    values[metric] = value;
  }
  return values;
}

async function main() {
  const thresholds = configuredThresholds();
  const rssSamples = [sampledRss()];
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT, footerHeight: 0 });
  let frameCount = 0;
  let facade;
  const terminal = createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      facade = createOpenTuiRendererFacade(setup.renderer, { events });
      return {
        render(state) {
          frameCount += 1;
          facade.render(state);
        },
        alternateOutput: () => facade.alternateOutput?.() ?? '',
        drainAnnouncements: () => facade.drainAnnouncements?.() ?? [],
        destroy: () => facade.destroy(),
      };
    },
  });

  let stopped = false;
  try {
    const firstRenderStart = performance.now();
    await terminal.start();
    await setup.flush();
    const firstRenderMs = elapsedMs(firstRenderStart);
    rssSamples.push(sampledRss());

    const expectedMessages = expectedStream();
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      terminal.accept({ type: 'message-started', messageId: `performance-stream-${index}`, role: 'assistant' });
    }
    const framesBeforeStream = frameCount;
    const streamStart = performance.now();
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      terminal.accept({
        type: 'message-delta',
        messageId: `performance-stream-${index % MESSAGE_COUNT}`,
        text: streamChunk(index),
      });
    }
    await new Promise((resolve) => queueMicrotask(resolve));
    await setup.flush();
    const sustainedEventsMs = elapsedMs(streamStart);
    const streamFrames = frameCount - framesBeforeStream;
    rssSamples.push(sampledRss());

    const resizeStart = performance.now();
    setup.resize(RESIZED_WIDTH, RESIZED_HEIGHT);
    await setup.flush();
    const resizeRecoveryMs = elapsedMs(resizeStart);
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer');
    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail');
    const resizeProof = {
      rendererWidth: setup.renderer.width,
      rendererHeight: setup.renderer.height,
      composerVisible: composer?.visible !== false,
      railVisible: rail?.visible,
    };
    const resizedFrame = setup.captureCharFrame();
    rssSamples.push(sampledRss());

    const stateBeforeStop = terminal.snapshot();
    const observedMessages = observedStream(stateBeforeStop);
    const expectedContent = expectedMessages.join('\n');
    const observedContent = observedMessages.join('\n');
    const streamIntegrity = {
      expectedMessageCount: MESSAGE_COUNT,
      observedMessageCount: observedMessages.length,
      expectedCodeUnits: expectedContent.length,
      observedCodeUnits: observedContent.length,
      expectedSha256: sha256(expectedContent),
      observedSha256: sha256(observedContent),
    };
    const streamLossless = expectedMessages.length === observedMessages.length
      && expectedMessages.every((message, index) => observedMessages[index] === message);
    const stateHash = sha256(JSON.stringify(stateBeforeStop));
    const frameHash = sha256(resizedFrame);
    const shutdownStart = performance.now();
    await terminal.stop();
    stopped = true;
    const shutdownMs = elapsedMs(shutdownStart);
    rssSamples.push(sampledRss());

    const metrics = {
      firstRenderMs,
      sustainedEventsMs,
      sustainedEventsPerSecond: Number(((EVENT_COUNT / sustainedEventsMs) * 1_000).toFixed(3)),
      streamFrames,
      resizeRecoveryMs,
      shutdownMs,
      peakRssBytesSampled: Math.max(...rssSamples),
      resourceMaxRssKb: process.resourceUsage().maxRSS,
    };
    const failures = Object.entries(thresholds).flatMap(([metric, limit]) => (
      metrics[metric] > limit
        ? [{ metric, observed: metrics[metric], limit, variable: thresholdDefinitions[metric] }]
        : []
    ));
    if (!streamLossless) {
      failures.push({ metric: 'streamLossless', observed: streamIntegrity, limit: 'exact content/hash/length match' });
    }
    if (resizeProof.rendererWidth !== RESIZED_WIDTH
      || resizeProof.rendererHeight !== RESIZED_HEIGHT
      || resizeProof.composerVisible !== true
      || resizeProof.railVisible !== false) {
      failures.push({
        metric: 'resizeLayout',
        observed: resizeProof,
        limit: {
          rendererWidth: RESIZED_WIDTH,
          rendererHeight: RESIZED_HEIGHT,
          composerVisible: true,
          railVisible: false,
        },
      });
    }

    const report = {
      schemaVersion: 1,
      sensor: 'octocode-agent-opentui-performance',
      metadata: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ffiEnabled: process.execArgv.includes('--experimental-ffi')
          || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true,
        dimensions: { width: WIDTH, height: HEIGHT },
        resizedDimensions: { width: RESIZED_WIDTH, height: RESIZED_HEIGHT },
        eventCount: EVENT_COUNT,
        messageCount: MESSAGE_COUNT,
      },
      metrics,
      integrity: {
        stream: streamIntegrity,
        streamLossless,
        stateSha256: stateHash,
        resizedFrameSha256: frameHash,
      },
      resizeProof,
      thresholds,
      failures,
      pass: failures.length === 0,
      limitations: [
        'Uses the OpenTUI in-memory test renderer, not a real pseudo-terminal.',
        'Sampled RSS is process-wide; resourceMaxRssKb is the Node process lifetime maximum.',
        'Timing values are host observations and are enforced only when threshold environment variables are set.',
      ],
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.pass) process.exitCode = 1;
  } finally {
    if (!stopped) await terminal.stop().catch(() => undefined);
    setup.renderer.destroy();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-performance',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
