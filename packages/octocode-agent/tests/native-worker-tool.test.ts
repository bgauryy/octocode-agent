import { describe, expect, it, vi } from 'vitest';
import {
  correlationId,
  packetId,
  sessionId,
  workerId,
  type ToolExecutionInput,
  type WorkerCommand,
  type WorkerController,
  type WorkerSnapshot,
  type WorkerTerminalPacket,
} from '@octocodeai/agent-core';
import { createNativeWorkerTool } from '../src/native-worker-tool.js';

const ids = ['worker-1', 'correlation-1', 'packet-1', 'packet-2', 'packet-3'];

function harness(execute?: (command: WorkerCommand) => Promise<unknown>) {
  const commands: WorkerCommand[] = [];
  const controller: WorkerController = {
    execute: vi.fn(async (command: WorkerCommand) => {
      commands.push(command);
      if (execute) return execute(command);
      if (command.type === 'spawn') return {
        workerId: command.packet.workerId,
        correlationId: command.packet.correlationId,
        sessionId: command.packet.sessionId,
        state: 'queued',
        queueDepth: 0,
        capabilities: command.packet.capabilities,
      } satisfies WorkerSnapshot;
      return undefined;
    }),
  };
  let index = 0;
  const tool = createNativeWorkerTool({
    controller,
    promptSnapshotId: 'prompt:SECRET-SNAPSHOT',
    allowedTools: ['localSearchCode', 'lspGetSemantics'],
    allowedModels: [{ providerId: 'openai', modelId: 'gpt-test' }],
    defaultMaxTurns: 8,
    maxWaitMs: 100,
    idFactory: () => ids[index++] ?? `generated-${index}`,
  });
  const abort = new AbortController();
  const call = (input: unknown, selectedSession = 'session:one') => tool.execute({
    input,
    callId: 'call:one' as never,
    context: {
      sessionId: sessionId(selectedSession),
      cwd: '/trusted/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal: abort.signal,
    },
    signal: abort.signal,
    update: vi.fn(async () => undefined),
  } satisfies ToolExecutionInput);
  return { tool, controller, commands, call, abort };
}

describe('native worker tool', () => {
  it('is a closed, process/on-request trusted-workspace tool that remains plan-allowed', () => {
    const { tool } = harness();
    expect(tool.policy).toEqual({ effects: ['process'], trust: 'workspace', approval: 'on-request', plan: 'allowed' });
    expect(tool.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    for (const branch of tool.inputSchema.oneOf as Array<Record<string, unknown>>) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('constructs spawn and communication packets with frozen internal correlation', async () => {
    const { call, commands } = harness();
    const spawned = await call({
      action: 'spawn',
      task: 'Inspect the parser',
      tools: ['localSearchCode'],
      model: { providerId: 'openai', modelId: 'gpt-test' },
      maxTurns: 5,
    });
    expect(spawned).toMatchObject({ ok: true, content: { action: 'spawn', worker: { workerId: 'worker-1', correlationId: 'correlation-1', state: 'queued' } } });
    expect(commands[0]).toEqual({
      type: 'spawn',
      packet: {
        schemaVersion: 1,
        type: 'worker.spawn',
        workerId: 'worker-1',
        correlationId: 'correlation-1',
        packetId: 'packet-1',
        sessionId: 'session:one',
        redaction: 'sensitive',
        prompt: 'Inspect the parser',
        promptSnapshotId: 'prompt:SECRET-SNAPSHOT',
        workspace: { mode: 'shared' },
        capabilities: { tools: ['localSearchCode'], models: [{ providerId: 'openai', modelId: 'gpt-test' }], maxTurns: 5 },
      },
    });

    await call({ action: 'steer', workerId: 'worker-1', text: 'Focus on callers' });
    expect(commands[1]).toEqual({
      type: 'steer',
      packet: {
        schemaVersion: 1,
        type: 'worker.steer',
        workerId: 'worker-1',
        correlationId: 'correlation-1',
        packetId: 'packet-2',
        sessionId: 'session:one',
        redaction: 'sensitive',
        text: 'Focus on callers',
      },
    });
  });

  it.each(['send', 'steer', 'follow-up', 'status', 'wait', 'abort', 'kill'] as const)('maps %s to the controller without accepting packet identity fields', async (action) => {
    const terminal: WorkerTerminalPacket = {
      schemaVersion: 1,
      type: 'worker.terminal',
      packetId: packetId('terminal'),
      workerId: workerId('worker-1'),
      correlationId: correlationId('correlation-1'),
      sessionId: sessionId('session:one'),
      redaction: 'secret',
      outcome: 'succeeded',
      handback: { secret: 'DO-NOT-RENDER' },
      reason: 'SECRET-REASON',
    };
    const { call, commands } = harness(async (command) => {
      if (command.type === 'spawn') return { workerId: command.packet.workerId, correlationId: command.packet.correlationId, sessionId: command.packet.sessionId, state: 'queued', queueDepth: 0, capabilities: command.packet.capabilities } satisfies WorkerSnapshot;
      if (command.type === 'wait') return terminal;
      if (command.type === 'status') return { workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session:one'), state: 'running', queueDepth: 0, capabilities: { tools: ['SECRET-TOOL'], models: [], maxTurns: 1 } } satisfies WorkerSnapshot;
      return undefined;
    });
    await call({ action: 'spawn', task: 'work' });
    const input = action === 'send' || action === 'steer' || action === 'follow-up'
      ? { action, workerId: 'worker-1', text: 'message' }
      : { action, workerId: 'worker-1', ...(action === 'wait' ? { timeoutMs: 50 } : {}), ...(action === 'abort' || action === 'kill' ? { reason: 'stop' } : {}) };
    const result = await call(input);
    expect(commands.at(-1)?.type).toBe(action);
    expect(JSON.stringify(result)).not.toMatch(/DO-NOT-RENDER|SECRET-REASON|SECRET-SNAPSHOT|SECRET-TOOL/);
  });

  it('bounds inputs, rejects unknown fields and disallows capability escalation or command bypass', async () => {
    const { call, commands } = harness();
    await expect(call({ action: 'spawn', task: '', command: 'rm -rf /' })).rejects.toThrow(/unknown field/i);
    await expect(call({ action: 'spawn', task: 'x'.repeat(16_385) })).rejects.toThrow(/task/i);
    await expect(call({ action: 'spawn', task: 'work', tools: ['bash'] })).rejects.toThrow(/not allowed/i);
    await expect(call({ action: 'spawn', task: 'work', model: { providerId: 'evil', modelId: 'shell' } })).rejects.toThrow(/not allowed/i);
    await expect(call({ action: 'spawn', task: 'work', maxTurns: 101 })).rejects.toThrow(/maxTurns/i);
    expect(commands).toHaveLength(0);
  });

  it('fails closed for worktrees and session-crossing worker access', async () => {
    const { call, commands } = harness();
    await expect(call({ action: 'spawn', task: 'work', workspace: { mode: 'worktree', path: '/tmp/x', baseRevision: 'HEAD' } })).rejects.toThrow(/worktree.*unavailable/i);
    await call({ action: 'spawn', task: 'work' });
    await expect(call({ action: 'status', workerId: 'worker-1' }, 'session:other')).rejects.toThrow(/not found/i);
    expect(commands).toHaveLength(1);
  });

  it('times out bounded waits without exposing controller errors', async () => {
    const { call } = harness(async (command) => {
      if (command.type === 'spawn') return { workerId: command.packet.workerId, correlationId: command.packet.correlationId, sessionId: command.packet.sessionId, state: 'queued', queueDepth: 0, capabilities: command.packet.capabilities } satisfies WorkerSnapshot;
      if (command.type === 'wait') return new Promise(() => undefined);
      throw new Error('SECRET-CONTROLLER-ERROR');
    });
    await call({ action: 'spawn', task: 'work' });
    await expect(call({ action: 'wait', workerId: 'worker-1', timeoutMs: 1 })).rejects.toThrow(/timed out/i);
    await expect(call({ action: 'status', workerId: 'worker-1' })).rejects.not.toThrow(/SECRET-CONTROLLER-ERROR/);
  });

  it('returns only bounded allowlisted worker handback fields', async () => {
    const longText = 'x'.repeat(20_000);
    const { call } = harness(async (command) => {
      if (command.type === 'spawn') return { workerId: command.packet.workerId, correlationId: command.packet.correlationId, sessionId: command.packet.sessionId, state: 'queued', queueDepth: 0, capabilities: command.packet.capabilities } satisfies WorkerSnapshot;
      if (command.type === 'wait') return {
        schemaVersion: 1,
        type: 'worker.terminal',
        packetId: packetId('terminal'),
        workerId: workerId('worker-1'),
        correlationId: correlationId('correlation-1'),
        sessionId: sessionId('session:one'),
        redaction: 'sensitive',
        outcome: 'succeeded',
        handback: { summary: 'Implemented worker lifecycle', text: longText, secret: 'NEVER-PUBLIC', env: { TOKEN: 'NEVER' } },
      } satisfies WorkerTerminalPacket;
      return undefined;
    });
    await call({ action: 'spawn', task: 'work' });
    const result = await call({ action: 'wait', workerId: 'worker-1', timeoutMs: 50 });
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('Implemented worker lifecycle');
    expect(rendered).toContain('"truncated":true');
    expect(rendered).not.toMatch(/NEVER-PUBLIC|TOKEN|env/);
    const handback = (result.content as { worker: { terminal: { handback: { summary: string; text: string } } } }).worker.terminal.handback;
    expect(handback.summary.length + handback.text.length).toBe(16_384);
  });
});
