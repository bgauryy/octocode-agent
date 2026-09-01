import { describe, expect, it } from 'vitest';

import {
  createRuntimeKernel,
  parseRpcEvent,
  sessionId,
  type CheckpointEventIngressPort,
  type RuntimeEvent,
} from '../src/index.js';

const transition = {
  schemaVersion: 1,
  attemptId: 'checkpoint-1',
  checkpointId: 'checkpoint-1',
  attemptKind: 'mutation',
  operation: 'edit',
  path: 'src/index.ts',
  before: { kind: 'present', sha256: 'a'.repeat(64), bytes: 4, mode: 0o640 },
  after: { kind: 'present', sha256: 'b'.repeat(64), bytes: 5, mode: 0o640 },
  journalSha256: 'c'.repeat(64),
} as const;

describe('checkpoint event ingress', () => {
  it('admits only valid checkpoint events through durable ordering and runtime subscribers', async () => {
    let ingress!: CheckpointEventIngressPort;
    const durable: RuntimeEvent[] = [];
    const visible: RuntimeEvent[] = [];
    const runtime = createRuntimeKernel({
      sessionId: sessionId('checkpoint-ingress'),
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
      registerCheckpointEventIngress: (port) => { ingress = port; },
      emit: async (event) => { durable.push(event); },
    });
    runtime.subscribe((event) => { visible.push(event); });

    await expect(ingress.emit({ schemaVersion: 1, type: 'checkpoint.prepared', transition })).rejects.toThrow(/not active/i);
    await runtime.start();
    await ingress.emit({ schemaVersion: 1, type: 'checkpoint.prepared', transition });
    await ingress.emit({
      schemaVersion: 1,
      type: 'checkpoint.recovered',
      recovery: {
        schemaVersion: 1,
        attemptId: transition.attemptId,
        checkpointId: transition.checkpointId,
        attemptKind: transition.attemptKind,
        path: transition.path,
        state: 'complete',
        current: transition.after,
        journalSha256: transition.journalSha256,
      },
    });

    const durableCheckpoints = durable.filter((event) => event.type.startsWith('checkpoint.'));
    const visibleCheckpoints = visible.filter((event) => event.type.startsWith('checkpoint.'));
    expect(durableCheckpoints.map(({ type }) => type)).toEqual(['checkpoint.prepared', 'checkpoint.recovered']);
    expect(visibleCheckpoints).toEqual(durableCheckpoints);
    for (const [index, event] of visibleCheckpoints.entries()) {
      expect(parseRpcEvent({ protocolVersion: 1, sequence: index + 1, event }).event).toEqual(event);
    }

    await runtime.stop();
    await expect(ingress.emit({ schemaVersion: 1, type: 'checkpoint.prepared', transition })).rejects.toThrow(/not active/i);
  });

  it('rejects malformed payloads and cannot forge non-checkpoint lifecycle events', async () => {
    let ingress!: CheckpointEventIngressPort;
    const runtime = createRuntimeKernel({
      sessionId: sessionId('checkpoint-ingress-rejection'),
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
      registerCheckpointEventIngress: (port) => { ingress = port; },
    });
    await runtime.start();

    await expect(ingress.emit({
      schemaVersion: 1,
      type: 'checkpoint.prepared',
      transition: { ...transition, path: '/workspace/src/index.ts' },
    })).rejects.toThrow(/path/i);
    await expect(ingress.emit({
      schemaVersion: 1,
      type: 'runtime.failed',
      message: 'forged',
    } as never)).rejects.toThrow(/checkpoint event/i);
    await runtime.stop();
  });
});
