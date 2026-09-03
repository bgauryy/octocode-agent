import { describe, expect, it, vi } from 'vitest';
import {
  correlationId,
  packetId,
  sessionId,
  workerId,
  type ToolAdmissionContextV1,
  type ToolExecutionInput,
  type WorkerCommand,
  type WorkerController,
  type WorkerSnapshot,
  type WorkerTerminalPacket,
} from '@octocodeai/agent-core';
import {
  createNativeWorkerTool,
  type NativeWorkerToolOptions,
} from '../src/native-worker-tool.js';
import type { NativePlanWorkerOwnershipPort } from '../src/native-plan.js';
import type { NativeWorkerDagSchedulerPort } from '../src/native-worker-dag-scheduler.js';

const ids = ['worker-1', 'correlation-1', 'packet-1', 'packet-2', 'packet-3'];
const admission: ToolAdmissionContextV1 = {
  schemaVersion: 1,
  effectAdmissionId: 'effect:worker:1',
  receiptDigest: 'receipt:worker:1',
  trustRevision: 'trust:1',
  permissionMode: 'default',
  policyRevision: 1,
  planRevision: 1,
  workerAuthorityRoot: {
    rootAgentId: 'root:1',
    workspaceId: 'workspace:1',
    workspaceGeneration: 1,
    ownershipGeneration: 1,
  },
};
const terminalAuthority = {
  schemaVersion: 1 as const,
  workerId: workerId('worker-1'),
  correlationId: correlationId('correlation-1'),
  rootAgentId: 'root:1',
  parentSessionId: sessionId('session:one'),
  workspaceId: 'workspace:1',
  workspaceGeneration: 1,
  trustRevision: 'trust:1',
  permissionMode: 'default' as const,
  capabilityDigest: 'capabilities:1',
  planRevision: 1,
  effectAdmissionId: 'effect:worker:1',
  ownershipGeneration: 1,
};

function harness(
  execute?: (command: WorkerCommand) => Promise<unknown>,
  planOwnership?: NativePlanWorkerOwnershipPort,
  dependencyScheduler?: NativeWorkerDagSchedulerPort,
  overrides: Partial<NativeWorkerToolOptions> = {},
) {
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
    allowedTools: ['octocode', 'localSearch', 'lspGetSemantics'],
    allowedOctocodeTools: ['localSearch', 'lspGetSemantics'],
    allowedModels: [{ providerId: 'openai', modelId: 'gpt-test' }],
    defaultMaxTurns: 8,
    maxWaitMs: 100,
    ...(planOwnership === undefined ? {} : { planOwnership }),
    ...(dependencyScheduler === undefined ? {} : { dependencyScheduler }),
    idFactory: () => ids[index++] ?? `generated-${index}`,
    ...overrides,
  });
  const abort = new AbortController();
  const call = (
    input: unknown,
    selectedSession = 'session:one',
    admitted: ToolAdmissionContextV1 | null = admission,
  ) => tool.execute({
    input,
    callId: 'call:one' as never,
    context: {
      sessionId: sessionId(selectedSession),
      cwd: '/trusted/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      ...(admitted === null ? {} : { admission: admitted }),
      signal: abort.signal,
    },
    signal: abort.signal,
    update: vi.fn(async () => undefined),
  } satisfies ToolExecutionInput);
  return { tool, controller, commands, call, abort };
}

describe('native worker tool', () => {
  it('tells the root model that children are leaf-only', () => {
    const { tool } = harness();
    expect(tool.description).toContain('Root-only');
    expect(tool.description).toContain('Children never receive this tool');
  });

  it('runs an admitted dependency schedule with immutable leaf-only packets', async () => {
    let admittedPacket: ReturnType<Parameters<NativeWorkerDagSchedulerPort['run']>[0]['packet']> | undefined;
    const dependencyScheduler: NativeWorkerDagSchedulerPort = {
      run: vi.fn(async (request) => {
        admittedPacket = request.packet(
          { itemId: 'step:1:1', prompt: 'Build it', dependsOn: [] },
          'dag-worker-1',
        );
        return {
          graphId: 'plan-dag',
          state: 'succeeded' as const,
          items: [{ itemId: 'step:1:1', state: 'succeeded' as const }],
        };
      }),
    };
    const { call } = harness(undefined, undefined, dependencyScheduler);

    await expect(call({
      action: 'schedule',
      tools: ['octocode'],
      octocodeTools: ['localSearch'],
      model: { providerId: 'openai', modelId: 'gpt-test' },
      maxTurns: 5,
      maxParallel: 2,
    })).resolves.toMatchObject({
      content: {
        action: 'schedule',
        schedule: { graphId: 'plan-dag', state: 'succeeded' },
      },
    });
    expect(dependencyScheduler.run).toHaveBeenCalledWith(expect.objectContaining({
      scope: { sessionId: 'session:one', workspace: '/trusted/workspace' },
      maxParallel: 2,
    }));
    expect(admittedPacket).toMatchObject({
      type: 'worker.spawn',
      workerId: 'dag-worker-1',
      prompt: 'Build it',
      presentation: { planStepId: 'step:1:1' },
      capabilities: {
        tools: ['octocode'],
        octocodeTools: ['localSearch'],
        models: [{ providerId: 'openai', modelId: 'gpt-test' }],
        maxTurns: 5,
      },
      authority: {
        rootAgentId: 'root:1',
        workspaceId: 'workspace:1',
        effectAdmissionId: 'effect:worker:1',
      },
    });
    expect(admittedPacket?.capabilities.tools).not.toContain('worker');
    expect(Object.isFrozen(admittedPacket)).toBe(true);
    expect(Object.isFrozen(admittedPacket?.capabilities)).toBe(true);
  });

  it('fails closed when dependency scheduling has no durable production binding', async () => {
    const { call, commands } = harness();
    await expect(call({ action: 'schedule' })).rejects.toThrow(/scheduling is unavailable/i);
    expect(commands).toHaveLength(0);
  });

  it('binds a worker to one plan step, exposes ownership, and releases without auto-completing on terminal success', async () => {
    const planOwnership: NativePlanWorkerOwnershipPort = {
      claim: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'active' as const })),
      release: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'released' as const })),
    };
    const terminal: WorkerTerminalPacket = {
      schemaVersion: 1, type: 'worker.terminal', packetId: packetId('terminal'), workerId: workerId('worker-1'),
      correlationId: correlationId('correlation-1'), sessionId: sessionId('session:one'), redaction: 'sensitive', outcome: 'succeeded',
      authority: terminalAuthority,
    };
    const { call } = harness(async (command) => {
      if (command.type === 'spawn') return { workerId: command.packet.workerId, correlationId: command.packet.correlationId, sessionId: command.packet.sessionId, state: 'queued', queueDepth: 0, capabilities: command.packet.capabilities } satisfies WorkerSnapshot;
      if (command.type === 'list') return [{ workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session:one'), state: 'running', queueDepth: 0, capabilities: { tools: [], models: [], maxTurns: 1 } } satisfies WorkerSnapshot];
      if (command.type === 'status') return { workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session:one'), state: 'running', queueDepth: 0, capabilities: { tools: [], models: [], maxTurns: 1 } } satisfies WorkerSnapshot;
      if (command.type === 'wait') return terminal;
      return undefined;
    }, planOwnership);

    expect(await call({ action: 'spawn', task: 'Build it', planStepId: 'step:1:1' })).toMatchObject({
      content: { worker: { planStepId: 'step:1:1', ownershipStatus: 'active' } },
    });
    expect(planOwnership.claim).toHaveBeenCalledWith(expect.objectContaining({
      scope: { sessionId: 'session:one', workspace: '/trusted/workspace' }, planStepId: 'step:1:1', workerId: 'worker-1',
    }));
    expect(await call({ action: 'list' })).toMatchObject({ content: { workers: [{ planStepId: 'step:1:1', ownershipStatus: 'active' }] } });
    expect(await call({ action: 'status', workerId: 'worker-1' })).toMatchObject({ content: { worker: { planStepId: 'step:1:1', ownershipStatus: 'active' } } });
    expect(await call({ action: 'wait', workerId: 'worker-1', timeoutMs: 50 })).toMatchObject({
      content: { worker: { state: 'succeeded', planStepId: 'step:1:1', ownershipStatus: 'released' } },
    });
    expect(planOwnership.release).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed plan step when worker spawn fails', async () => {
    const planOwnership: NativePlanWorkerOwnershipPort = {
      claim: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'active' as const })),
      release: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'released' as const })),
    };
    const { call } = harness(async () => { throw new Error('spawn failed'); }, planOwnership);
    await expect(call({ action: 'spawn', task: 'Build it', planStepId: 'step:1:1' })).rejects.toThrow(/spawn failed/i);
    expect(planOwnership.claim).toHaveBeenCalledTimes(1);
    expect(planOwnership.release).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'kill'] as const)('releases plan-step ownership after %s is acknowledged', async (action) => {
    const planOwnership: NativePlanWorkerOwnershipPort = {
      claim: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'active' as const })),
      release: vi.fn(async ({ planStepId, workerId }) => ({ planStepId, workerId, status: 'released' as const })),
    };
    const { call } = harness(undefined, planOwnership);
    await call({ action: 'spawn', task: 'Build it', planStepId: 'step:1:1' });
    await expect(call({ action, workerId: 'worker-1', reason: 'stop' })).resolves.toMatchObject({ content: { acknowledged: true } });
    expect(planOwnership.release).toHaveBeenCalledTimes(1);
  });

  it('resolves read actions without approval and retains network/process gates for mutations', () => {
    const { tool } = harness();
    expect(tool.policy).toMatchObject({ effects: ['network', 'process'], trust: 'workspace', approval: 'on-request', plan: 'allowed' });
    expect(tool.policy.concurrency?.({ action: 'spawn' })).toEqual({ lane: 'native-worker', maxActive: 4 });
    expect(tool.policy.concurrency?.({ action: 'schedule' })).toEqual({ lane: 'native-worker', maxActive: 4 });
    expect(tool.policy.concurrency?.({ action: 'wait' })).toEqual({ lane: 'native-worker', maxActive: 4 });
    expect(tool.policy.concurrency?.({ action: 'abort' })).toEqual({ lane: 'native-worker', maxActive: 4 });
    expect(tool.policy.concurrency?.({ action: 'send' })).toBeUndefined();
    for (const action of ['list', 'status', 'wait']) {
      expect(tool.policy.resolve?.({ action })).toEqual({ effects: ['read'], trust: 'none', approval: 'never' });
    }
    for (const action of ['spawn', 'schedule', 'send', 'steer', 'follow-up', 'abort', 'kill']) {
      expect(tool.policy.resolve?.({ action })).toEqual({ effects: ['network', 'process'], trust: 'workspace', approval: 'on-request' });
    }
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
      tools: ['octocode'],
      octocodeTools: ['localSearch'],
      model: { providerId: 'openai', modelId: 'gpt-test' },
      maxTurns: 5,
    });
    expect(spawned).toMatchObject({ ok: true, content: { action: 'spawn', worker: { workerId: 'worker-1', correlationId: 'correlation-1', state: 'queued' } } });
    expect(commands[0]).toMatchObject({
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
        capabilities: { tools: ['octocode'], octocodeTools: ['localSearch'], models: [{ providerId: 'openai', modelId: 'gpt-test' }], maxTurns: 5 },
        authority: {
          rootAgentId: 'root:1',
          workspaceId: 'workspace:1',
          effectAdmissionId: 'effect:worker:1',
        },
      },
    });

    await call({ action: 'steer', workerId: 'worker-1', text: 'Focus on callers' });
    expect(commands[1]).toMatchObject({
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
    if (commands[0]?.type !== 'spawn' || commands[1]?.type !== 'steer')
      throw new Error('expected spawn then steer');
    expect(commands[1].packet.authority).toBe(commands[0].packet.authority);
  });

  it('fails closed without admitted host authority and rejects model authority', async () => {
    const { call, commands } = harness();
    await expect(
      call({ action: 'spawn', task: 'work' }, 'session:one', null),
    ).rejects.toThrow(/admission/i);
    await expect(
      call({ action: 'spawn', task: 'work', authority: terminalAuthority }),
    ).rejects.toThrow(/unknown field/i);
    expect(commands).toHaveLength(0);
  });

  it('rejects a control command after the host ownership generation changes', async () => {
    const { call, commands } = harness();
    await call({ action: 'spawn', task: 'work' });
    await expect(
      call(
        { action: 'status', workerId: 'worker-1' },
        'session:one',
        {
          ...admission,
          workerAuthorityRoot: {
            ...admission.workerAuthorityRoot!,
            ownershipGeneration: 2,
          },
        },
      ),
    ).rejects.toThrow(/stale/i);
    expect(commands).toHaveLength(1);
  });

  it('accepts only a host-resolved worktree identity', async () => {
    const resolveWorktree = vi.fn(({ baseRevision }) => ({
      mode: 'worktree' as const,
      path: '/host/worktrees/worker-1',
      baseRevision,
    }));
    const { call, commands } = harness(undefined, undefined, undefined, {
      allowWorktree: true,
      resolveWorktree,
    });
    await expect(
      call({
        action: 'spawn',
        task: 'work',
        workspace: {
          mode: 'worktree',
          path: '/caller/path',
          baseRevision: 'HEAD',
        },
      }),
    ).rejects.toThrow(/unknown field/i);
    await call({
      action: 'spawn',
      task: 'work',
      workspace: { mode: 'worktree', baseRevision: 'HEAD' },
    });
    expect(resolveWorktree).toHaveBeenCalledWith({
      workerId: 'worker-1',
      sessionId: 'session:one',
      baseRevision: 'HEAD',
    });
    expect(commands[0]).toMatchObject({
      type: 'spawn',
      packet: {
        workspace: {
          mode: 'worktree',
          path: '/host/worktrees/worker-1',
          baseRevision: 'HEAD',
        },
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
      authority: terminalAuthority,
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
    const command = commands.at(-1);
    expect(command?.type).toBe(action);
    if (command?.type === 'send' || command?.type === 'steer' || command?.type === 'follow-up')
      expect(command.packet.authority).toBe(
        (commands[0] as Extract<WorkerCommand, { type: 'spawn' }>).packet.authority,
      );
    else if (command?.type === 'status' || command?.type === 'wait' || command?.type === 'abort' || command?.type === 'kill')
      expect(command.authority).toBe(
        (commands[0] as Extract<WorkerCommand, { type: 'spawn' }>).packet.authority,
      );
    expect(JSON.stringify(result)).not.toMatch(/DO-NOT-RENDER|SECRET-REASON|SECRET-SNAPSHOT|SECRET-TOOL/);
  });

  it('bounds inputs, rejects unknown fields and disallows capability escalation or command bypass', async () => {
    const { call, commands } = harness();
    await expect(call({ action: 'spawn', task: '', command: 'rm -rf /' })).rejects.toThrow(/unknown field/i);
    await expect(call({ action: 'spawn', task: 'x'.repeat(16_385) })).rejects.toThrow(/task/i);
    await expect(call({ action: 'spawn', task: 'work', tools: ['bash'] })).rejects.toThrow(/not allowed/i);
    await expect(call({ action: 'spawn', task: 'work', octocodeTools: ['localSearch'] })).rejects.toThrow(/requires the octocode facade/i);
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
        authority: terminalAuthority,
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
