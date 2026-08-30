import {
  correlationId,
  packetId,
  sessionId,
  workerId,
  type WorkerCommand,
  type WorkerController,
} from '@octocodeai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeWorkerEditorProjection,
  NativeWorkerTransportProjection,
  toNativeWorkerEditorUpdate,
} from '../src/native-worker-projection.js';

const session = sessionId('session-1');
const correlation = correlationId('correlation-1');
const id = workerId('worker-1');

function controller(execute: (command: WorkerCommand) => Promise<unknown>): WorkerController {
  return { execute: vi.fn(execute) };
}

function createProjection(
  execute: (command: WorkerCommand) => Promise<unknown>,
  options: Partial<ConstructorParameters<typeof NativeWorkerTransportProjection>[1]> = {},
): NativeWorkerTransportProjection {
  return new NativeWorkerTransportProjection(controller(execute), {
    activeSessionId: session,
    promptSnapshotId: 'digest',
    capabilities: { tools: ['read'], models: [{ providerId: 'openai', modelId: 'gpt-5' }], maxTurns: 4 },
    authorize: async () => true,
    ...options,
  });
}

describe('native worker transport projection', () => {
  it('projects correlated status safely for RPC and editor consumers', async () => {
    const execute = vi.fn(async () => ({
      workerId: id,
      correlationId: correlation,
      sessionId: session,
      state: 'failed',
      queueDepth: 0,
      capabilities: { tools: ['read'], models: [], maxTurns: 1 },
      terminal: {
        outcome: 'failed',
        reason: 'provider-secret-body',
        handback: { text: `${'x'.repeat(5000)}super-secret`, events: [{ token: 'super-secret' }] },
      },
    }));
    const projection = createProjection(execute);

    const response = await projection.execute({
      protocolVersion: 1,
      projection: 'worker',
      requestId: 'request-1',
      sessionId: session,
      correlationId: correlation,
      command: { type: 'status', workerId: id },
    });

    expect(response).toMatchObject({
      protocolVersion: 1,
      requestId: 'request-1',
      ok: true,
      data: { action: 'status', worker: { workerId: 'worker-1', correlationId: 'correlation-1', state: 'failed' } },
    });
    expect(JSON.stringify(response)).not.toContain('super-secret');
    expect(JSON.stringify(response)).not.toContain('provider-secret-body');
    expect(JSON.stringify(response)).not.toContain('events');
    expect(toNativeWorkerEditorUpdate(response)).toMatchObject({ kind: 'worker', requestId: 'request-1', action: 'status' });
  });

  it('rejects correlation confusion before a mutating command reaches the controller', async () => {
    const execute = vi.fn(async (command: WorkerCommand) => command.type === 'status' ? ({
      workerId: id, correlationId: correlationId('other'), sessionId: session, state: 'running', queueDepth: 0,
      capabilities: { tools: [], models: [], maxTurns: 1 },
    }) : undefined);
    const transport = createProjection(execute);
    const response = await transport.execute({
      protocolVersion: 1, projection: 'worker', requestId: 'request-2', sessionId: session, correlationId: correlation,
      command: { type: 'abort', workerId: id, reason: 'stop' },
    });
    expect(response).toMatchObject({ ok: false, error: { category: 'correlation' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('denies recursive worker capabilities before spawn', async () => {
    const execute = vi.fn(async () => undefined);
    const transport = createProjection(execute);
    const response = await transport.execute({
      protocolVersion: 1, projection: 'worker', requestId: 'request-3', sessionId: session, correlationId: correlation,
      command: {
        type: 'spawn',
        packet: {
          schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn'), workerId: id,
          correlationId: correlation, sessionId: session, redaction: 'sensitive', prompt: 'task', promptSnapshotId: 'digest',
          workspace: { mode: 'shared' }, capabilities: { tools: ['worker'], models: [], maxTurns: 1 },
        },
      },
    });
    expect(response).toMatchObject({ ok: false, error: { category: 'recursion' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('filters list results to the addressed session', async () => {
    const transport = createProjection(async () => [
      { workerId: id, correlationId: correlation, sessionId: session, state: 'running', queueDepth: 0, capabilities: { tools: [], models: [], maxTurns: 1 } },
      { workerId: workerId('other'), correlationId: correlationId('other'), sessionId: sessionId('session-2'), state: 'running', queueDepth: 0, capabilities: { tools: [], models: [], maxTurns: 1 } },
    ]);
    const response = await transport.execute({ protocolVersion: 1, projection: 'worker', requestId: 'request-4', sessionId: session, command: { type: 'list' } });
    expect(response).toMatchObject({ ok: true, data: { action: 'list', workers: [{ workerId: 'worker-1' }] } });
  });

  it('binds every request to the active runtime session', async () => {
    const execute = vi.fn(async () => []);
    const response = await createProjection(execute).execute({
      protocolVersion: 1,
      projection: 'worker',
      requestId: 'wrong-session',
      sessionId: sessionId('caller-selected-session'),
      command: { type: 'list' },
    });
    expect(response).toMatchObject({ projection: 'worker', ok: false, error: { category: 'correlation' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed for mutation without explicit process approval', async () => {
    const execute = vi.fn(async () => undefined);
    const transport = createProjection(execute, { authorize: undefined });
    const response = await transport.execute({
      protocolVersion: 1, projection: 'worker', requestId: 'denied', sessionId: session, correlationId: correlation,
      command: {
        type: 'spawn',
        packet: {
          schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-denied'), workerId: id,
          correlationId: correlation, sessionId: session, redaction: 'sensitive', prompt: 'task', promptSnapshotId: 'digest',
          workspace: { mode: 'shared' }, capabilities: { tools: ['read'], models: [], maxTurns: 1 },
        },
      },
    });
    expect(response).toMatchObject({ projection: 'worker', ok: false, error: { category: 'approval' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects caller-selected prompt and capability escalation before authorization', async () => {
    const execute = vi.fn(async () => undefined);
    const authorize = vi.fn(async () => true);
    const transport = createProjection(execute, { authorize });
    const response = await transport.execute({
      protocolVersion: 1, projection: 'worker', requestId: 'escalated', sessionId: session, correlationId: correlation,
      command: {
        type: 'spawn',
        packet: {
          schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-escalated'), workerId: id,
          correlationId: correlation, sessionId: session, redaction: 'sensitive', prompt: 'task', promptSnapshotId: 'caller-digest',
          workspace: { mode: 'shared' }, capabilities: { tools: ['filesystem.write'], models: [{ providerId: 'other', modelId: 'model' }], maxTurns: 99 },
        },
      },
    });
    expect(response).toMatchObject({ projection: 'worker', ok: false, error: { category: 'capability' } });
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('routes an in-envelope mutation through the explicit process approval contract', async () => {
    const snapshot = {
      workerId: id, correlationId: correlation, sessionId: session, state: 'queued', queueDepth: 0,
      capabilities: { tools: ['read'], models: [], maxTurns: 1 },
    };
    const execute = vi.fn(async () => snapshot);
    const authorize = vi.fn(async () => true);
    const command: WorkerCommand = {
      type: 'spawn',
      packet: {
        schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-approved'), workerId: id,
        correlationId: correlation, sessionId: session, redaction: 'sensitive', prompt: 'task', promptSnapshotId: 'digest',
        workspace: { mode: 'shared' }, capabilities: { tools: ['read'], models: [], maxTurns: 1 },
      },
    };
    const response = await createProjection(execute, { authorize }).execute({
      protocolVersion: 1, projection: 'worker', requestId: 'approved', sessionId: session, correlationId: correlation, command,
    });
    expect(response).toMatchObject({ projection: 'worker', ok: true, data: { action: 'spawn' } });
    expect(authorize).toHaveBeenCalledWith({
      sessionId: session,
      command,
      policy: { effect: 'process', trust: 'workspace', approval: 'on-request' },
    });
    expect(execute).toHaveBeenCalledWith(command);
  });

  it('uses the guarded transport projection as the editor command and event boundary', async () => {
    const execute = vi.fn(async () => ({
      workerId: id, correlationId: correlation, sessionId: session, state: 'queued', queueDepth: 0,
      capabilities: { tools: ['read'], models: [], maxTurns: 1 },
    }));
    const authorize = vi.fn(async () => true);
    const editor = createNativeWorkerEditorProjection(createProjection(execute, { authorize }));
    const result = await editor.execute({
      protocolVersion: 1, projection: 'worker', requestId: 'editor-spawn', sessionId: session, correlationId: correlation,
      command: {
        type: 'spawn', packet: {
          schemaVersion: 1, type: 'worker.spawn', packetId: packetId('editor-spawn'), workerId: id,
          correlationId: correlation, sessionId: session, redaction: 'sensitive', prompt: 'task', promptSnapshotId: 'digest',
          workspace: { mode: 'shared' }, capabilities: { tools: ['read'], models: [], maxTurns: 1 },
        },
      },
    });
    expect(result.response).toMatchObject({ ok: true, data: { action: 'spawn' } });
    expect(result.update).toMatchObject({ kind: 'worker', requestId: 'editor-spawn', action: 'spawn' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
