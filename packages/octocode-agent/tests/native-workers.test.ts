import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  WorkerSupervisor,
  correlationId,
  packetId,
  sessionId,
  workerId,
  type WorkerLedgerEntry,
  type WorkerSpawnPacket,
} from '@octocodeai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeWorkerProcessPort,
  createNodeNativeWorkerProcessAdapter,
  type NativeWorkerProcessAdapter,
  type NativeWorkerProcessHandle,
  type NativeWorkerProcessResult,
  type NativeWorkerProcessSpec,
} from '../src/native-workers.js';
import type {
  NativeWorkerMessageJournal,
  NativeWorkerMessageStageInput,
} from '../src/native-rust-worker-messages.js';
import {
  decodeNativeWorkerBootstrapPacketV1,
  type NativeWorkerPromptCustomizationV1,
} from '../src/native-worker-bootstrap.js';
import type { NativeResolvedPortableCustomizationDescriptorV1 } from '../src/native-portable-customization.js';
import { workerAuthorityFixture } from './worker-authority-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function eventLine(text: string, sequence = 1): string {
  return `${JSON.stringify({
    protocolVersion: 1,
    sequence,
    event: {
      schemaVersion: 1, eventVersion: 1, id: `event-${sequence}`, type: 'message.delta', phase: 'notification',
      sessionId: 'worker-session', timestamp: sequence, cwd: '/tmp', mode: 'rpc',
      trust: { workspace: 'trusted', managedOnly: false },
      payload: { type: 'text', text, requestId: `request-${sequence}`, messageId: `message-${sequence}` },
    },
  })}\n`;
}

class FakeProcess implements NativeWorkerProcessHandle {
  readonly pid: number;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly exit;
  readonly writes: string[] = [];
  readonly endInput = vi.fn(async () => undefined);
  readonly abort = vi.fn();
  readonly kill = vi.fn();
  readonly completion = deferred<NativeWorkerProcessResult>();
  autoRespond = true;
  #eventSequence = 0;

  constructor(pid: number) {
    this.pid = pid;
    this.exit = this.completion.promise;
  }

  async write(line: string): Promise<void> {
    this.writes.push(line);
    const request = JSON.parse(line) as { requestId: string; command: { type: string } };
    if (!this.autoRespond) return;
    if (request.command.type === 'input.submit') this.stdout.push(eventLine(`result-${this.pid - 99}`, ++this.#eventSequence));
    this.stdout.push(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true })}\n`);
  }

  complete(result: NativeWorkerProcessResult): void {
    this.stdout.push(null);
    this.stderr.push(null);
    this.completion.resolve(result);
  }
}

class FakeProcessAdapter implements NativeWorkerProcessAdapter {
  readonly specs: NativeWorkerProcessSpec[] = [];
  readonly processes: FakeProcess[] = [];

  spawn(spec: NativeWorkerProcessSpec): NativeWorkerProcessHandle {
    this.specs.push(spec);
    const process = new FakeProcess(100 + this.processes.length);
    this.processes.push(process);
    return process;
  }
}

function spawnPacket(id: string, prompt = `task-${id}`): WorkerSpawnPacket {
  const resolvedWorkerId = workerId(id);
  const resolvedCorrelationId = correlationId(`correlation-${id}`);
  const resolvedSessionId = sessionId('parent-session');
  return {
    schemaVersion: 1,
    type: 'worker.spawn',
    packetId: packetId(`spawn-${id}`),
    workerId: resolvedWorkerId,
    correlationId: resolvedCorrelationId,
    sessionId: resolvedSessionId,
    authority: workerAuthorityFixture({ workerId: resolvedWorkerId, correlationId: resolvedCorrelationId, sessionId: resolvedSessionId }),
    redaction: 'sensitive',
    prompt,
    promptSnapshotId: `prompt-${id}`,
    workspace: { mode: 'shared' },
    capabilities: { tools: [], models: [], maxTurns: 1 },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(options: {
  maxActive?: number;
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  messageJournal?: NativeWorkerMessageJournal;
  workerCustomization?: NativeResolvedPortableCustomizationDescriptorV1;
  workerPromptCustomization?: NativeWorkerPromptCustomizationV1;
} = {}) {
  const process = new FakeProcessAdapter();
  const ledger: WorkerLedgerEntry[] = [];
  const port = new NativeWorkerProcessPort({
    process,
    command: '/usr/bin/node',
    argvPrefix: ['/opt/agent with spaces.mjs'],
    cwd: '/tmp',
    env: options.env,
    envAllowlist: options.envAllowlist,
    messageJournal: options.messageJournal,
    workerCustomization: options.workerCustomization,
    workerPromptCustomization: options.workerPromptCustomization,
  });
  const supervisor = new WorkerSupervisor({
    port,
    maxActive: options.maxActive ?? 2,
    ledger: { append: async (entry) => { ledger.push(entry); } },
  });
  return { process, port, supervisor, ledger };
}

describe('native worker process port', () => {
  it('acknowledges a staged worker message only after the matching child RPC response', async () => {
    const staged: NativeWorkerMessageStageInput[] = [];
    const allowStage = deferred<void>();
    const ack = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const messageJournal: NativeWorkerMessageJournal = {
      abandonSession: async () => ({ abandoned: 0 }),
      openMailbox: async () => ({} as never),
      listMailbox: async () => ({} as never),
      stage: vi.fn(async (input) => {
        staged.push(input);
        await allowStage.promise;
        return { message: {} as never, command: input.command, sequence: 1, markWritten: async () => undefined, extend: async () => undefined, ack, release, uncertain: async () => undefined, deadLetter: async () => undefined };
      }),
    };
    const { process, supervisor } = fixture({ messageJournal });
    const spawning = supervisor.spawn(spawnPacket('journaled'));
    await tick();
    process.processes[0]!.autoRespond = false;
    allowStage.resolve();
    await spawning;
    await tick();

    expect(staged.map(({ command }) => command)).toEqual([
      { type: 'input.submit', text: 'task-journaled' },
    ]);
    expect(ack).not.toHaveBeenCalled();
    const request = JSON.parse(process.processes[0]!.writes[0]!) as { requestId: string };
    process.processes[0]!.stdout.push(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true })}\n`);
    await tick();
    expect(ack).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    process.processes[0]!.complete({ code: 0, signal: null });
    await supervisor.wait(workerId('journaled'), spawnPacket('journaled').authority);
  });

  it('marks a written staged Rust message uncertain when the child exits without a response', async () => {
    const ack = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const uncertain = vi.fn(async () => undefined);
    const allowStage = deferred<void>();
    const messageJournal: NativeWorkerMessageJournal = {
      abandonSession: async () => ({ abandoned: 0 }),
      openMailbox: async () => ({} as never),
      listMailbox: async () => ({} as never),
      stage: vi.fn(async (input) => {
        await allowStage.promise;
        return { message: {} as never, command: input.command, sequence: 1, markWritten: async () => undefined, extend: async () => undefined, ack, release, uncertain, deadLetter: async () => undefined };
      }),
    };
    const { process, port } = fixture({ messageJournal });
    process.processes.length = 0;
    const spawning = port.spawn(spawnPacket('release-on-exit'), new AbortController().signal);
    await tick();
    process.processes[0]!.autoRespond = false;
    allowStage.resolve();
    const handle = await spawning;
    process.processes[0]!.complete({ code: 9, signal: null });

    await expect(handle.completion).resolves.toMatchObject({ outcome: 'failed' });
    expect(uncertain).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('marks written prompt and cancel leases uncertain after graceful abort ends the child', async () => {
    const allowFirstStage = deferred<void>();
    let stageCount = 0;
    const ack = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const uncertain = vi.fn(async () => undefined);
    const messageJournal: NativeWorkerMessageJournal = {
      abandonSession: async () => ({ abandoned: 0 }),
      openMailbox: async () => ({} as never),
      listMailbox: async () => ({} as never),
      stage: vi.fn(async (input) => {
        stageCount += 1;
        if (stageCount === 1) await allowFirstStage.promise;
        return { message: {} as never, command: input.command, sequence: stageCount, markWritten: async () => undefined, extend: async () => undefined, ack, release, uncertain, deadLetter: async () => undefined };
      }),
    };
    const { process, port } = fixture({ messageJournal });
    const spawning = port.spawn(spawnPacket('release-on-abort'), new AbortController().signal);
    await tick();
    process.processes[0]!.autoRespond = false;
    allowFirstStage.resolve();
    const handle = await spawning;

    await handle.abort('stop');
    process.processes[0]!.complete({ code: null, signal: 'SIGTERM' });

    await expect(handle.completion).resolves.toMatchObject({ outcome: 'aborted' });
    expect(uncertain).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('preserves invocation order when concurrent durable staging resolves out of order', async () => {
    const allowFirstSend = deferred<void>();
    let stageCount = 0;
    const messageJournal: NativeWorkerMessageJournal = {
      abandonSession: async () => ({ abandoned: 0 }),
      openMailbox: async () => ({} as never),
      listMailbox: async () => ({} as never),
      stage: vi.fn(async (input) => {
        stageCount += 1;
        if (stageCount === 2) await allowFirstSend.promise;
        return {
          message: {} as never,
          command: input.command,
          sequence: stageCount,
          markWritten: async () => undefined,
          extend: async () => undefined,
          ack: async () => undefined,
          release: async () => undefined,
          uncertain: async () => undefined,
          deadLetter: async () => undefined,
        };
      }),
    };
    const { process, port } = fixture({ messageJournal });
    const handle = await port.spawn(spawnPacket('ordered-inputs'), new AbortController().signal);

    const first = handle.send({
      schemaVersion: 1, type: 'worker.steer', packetId: packetId('ordered-first'),
      workerId: workerId('ordered-inputs'), correlationId: correlationId('correlation-ordered-inputs'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('ordered-inputs').authority, redaction: 'sensitive', text: 'first',
    });
    await tick();
    const second = handle.send({
      schemaVersion: 1, type: 'worker.follow-up', packetId: packetId('ordered-second'),
      workerId: workerId('ordered-inputs'), correlationId: correlationId('correlation-ordered-inputs'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('ordered-inputs').authority, redaction: 'sensitive', text: 'second',
    });
    await tick();
    allowFirstSend.resolve();
    await Promise.all([first, second]);

    expect(process.processes[0]!.writes.map((line) => JSON.parse(line).command)).toEqual([
      { type: 'input.submit', text: 'task-ordered-inputs' },
      { type: 'input.steer', text: 'first' },
      { type: 'input.follow-up', text: 'second' },
    ]);
    process.processes[0]!.complete({ code: 0, signal: null });
  });

  it('captures structured completion through the core supervisor', async () => {
    const { process, supervisor } = fixture();
    const packet = spawnPacket('worker-1');
    await supervisor.spawn(packet);
    expect(() => supervisor.status(packet.workerId, {
      ...packet.authority,
      ownershipGeneration: packet.authority.ownershipGeneration + 1,
    })).toThrow('Worker authority does not match the owning spawn');
    await tick();
    process.processes[0]!.complete({ code: 0, signal: null });

    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({
      outcome: 'succeeded',
      correlationId: 'correlation-worker-1',
      handback: { text: 'result-1', exitCode: 0, signal: null, events: [expect.any(Object)] },
    });
    expect(supervisor.status(workerId('worker-1'), spawnPacket('worker-1').authority)).toMatchObject({ state: 'succeeded' });
  });

  it('reports process failure without exposing prompt, stderr, argv, or environment', async () => {
    const { process, supervisor } = fixture({ env: { OPENAI_API_KEY: 'super-secret', SAFE: 'value' } });
    await supervisor.spawn(spawnPacket('worker-1', 'private task body'));
    await tick();
    process.processes[0]!.complete({ code: 7, signal: null });

    const terminal = await supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority);
    expect(terminal).toMatchObject({ outcome: 'failed', reason: 'Worker exited with code 7' });
    expect(JSON.stringify(terminal)).not.toContain('super-secret');
    expect(JSON.stringify(terminal)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(terminal)).not.toContain('private task body');
    expect(JSON.stringify(terminal)).not.toContain('/opt/agent with spaces.mjs');
  });

  it('builds an immutable shell-free argv/env boundary with prompt digest and cache key', async () => {
    const { process, supervisor } = fixture({ env: { TOKEN: 'secret', OMIT: 'nope' }, envAllowlist: ['TOKEN'] });
    const prompt = '$(touch /tmp/never) ; echo unsafe';
    await supervisor.spawn(spawnPacket('worker-1', prompt));
    await tick();

    expect(process.specs[0]).toMatchObject({
      command: '/usr/bin/node',
      cwd: fs.realpathSync('/tmp'),
      shell: false,
      args: ['/opt/agent with spaces.mjs', '--mode', 'rpc', '--no-session'],
      env: {
        TOKEN: 'secret',
        OCTOCODE_NATIVE_WORKER: '1',
        OCTOCODE_AGENT_ID: 'native-agent:worker:worker-1',
        OCTOCODE_WORKER_CORRELATION_ID: 'correlation-worker-1',
        OCTOCODE_EXPECTED_PROMPT_SHA256: 'prompt-worker-1',
        OCTOCODE_WORKER_ALLOWED_TOOLS: '[]',
        OCTOCODE_WORKER_ALLOWED_MODELS: '[]',
        OCTOCODE_WORKER_MAX_TURNS: '1',
      },
    });
    expect(process.specs[0]!.env).not.toHaveProperty('OMIT');
    expect(process.specs[0]!.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(process.specs[0]!.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(process.specs[0])).toBe(true);
    expect(Object.isFrozen(process.specs[0]!.args)).toBe(true);
    expect(Object.isFrozen(process.specs[0]!.env)).toBe(true);
  });

  it('does not propagate the retired API prompt environment transport', async () => {
    const workerPromptCustomization: NativeWorkerPromptCustomizationV1 = {
      schemaVersion: 1,
      id: 'com.acme.prompt',
      productPolicyOverlay: { mode: 'append', content: 'Use Acme terminology.' },
    };
    const { process, supervisor } = fixture({
      env: { OCTOCODE_AGENT_API_PROMPT_V1: 'retired', OMIT: 'nope' },
      workerPromptCustomization,
    });

    await supervisor.spawn(spawnPacket('worker-api-prompt'));
    await tick();

    expect(process.specs[0]!.env).not.toHaveProperty('OCTOCODE_AGENT_API_PROMPT_V1');
    expect(process.specs[0]!.env).not.toHaveProperty('OMIT');
    expect(decodeNativeWorkerBootstrapPacketV1(process.specs[0]!.bootstrap!))
      .toMatchObject({ promptCustomization: workerPromptCustomization });
  });

  it('binds portable customization to the dedicated bootstrap frame and cache identity', async () => {
    const workerCustomization: NativeResolvedPortableCustomizationDescriptorV1 = {
      schemaVersion: 1,
      id: 'com.acme.portable',
      entrypoint: {
        kind: 'module',
        moduleUrl: 'file:///tmp/customization.mjs',
        exportName: 'activate',
        integrity: `sha256-${'a'.repeat(64)}`,
      },
      config: { enabled: true },
      workerContributions: ['tool:review'],
      manifestSha256: 'b'.repeat(64),
    };
    const withCustomization = fixture({ workerCustomization });
    const withoutCustomization = fixture();
    const packet = spawnPacket('portable-worker');

    await withCustomization.supervisor.spawn(packet);
    await withoutCustomization.supervisor.spawn(packet);
    await tick();

    const spec = withCustomization.process.specs[0]!;
    const bootstrap = decodeNativeWorkerBootstrapPacketV1(spec.bootstrap!);
    expect(spec.env.OCTOCODE_NATIVE_WORKER_BOOTSTRAP_FD).toBe('3');
    expect(bootstrap).toMatchObject({
      workerId: 'portable-worker',
      correlationId: 'correlation-portable-worker',
      promptSnapshotId: 'prompt-portable-worker',
      customization: { manifestSha256: 'b'.repeat(64) },
    });
    expect(spec.cacheKey).not.toBe(withoutCustomization.process.specs[0]!.cacheKey);
  });

  it('keys portable worker processes by the complete resolved descriptor', async () => {
    const base: NativeResolvedPortableCustomizationDescriptorV1 = {
      schemaVersion: 1,
      id: 'com.acme.portable',
      entrypoint: {
        kind: 'module', moduleUrl: 'file:///tmp/customization.mjs', exportName: 'activate',
        integrity: `sha256-${'a'.repeat(64)}`,
      },
      config: { mode: 'one' },
      workerContributions: [],
      manifestSha256: 'b'.repeat(64),
    };
    const one = fixture({ workerCustomization: base });
    const two = fixture({ workerCustomization: { ...base, config: { mode: 'two' } } });
    const packet = spawnPacket('cache-identity');
    await one.supervisor.spawn(packet);
    await two.supervisor.spawn(packet);
    await tick();
    expect(one.process.specs[0]!.cacheKey).not.toBe(two.process.specs[0]!.cacheKey);
  });

  it('keys worker processes by the resolved worker working directory', async () => {
    const left = fs.mkdtempSync('/tmp/octocode-worker-cache-left-');
    const right = fs.mkdtempSync('/tmp/octocode-worker-cache-right-');
    try {
      const one = fixture();
      const two = fixture();
      const packet = spawnPacket('worktree-cache');
      await one.port.spawn({
        ...packet, workspace: { mode: 'worktree', path: left, baseRevision: 'fixture' },
      }, new AbortController().signal);
      await two.port.spawn({
        ...packet, workspace: { mode: 'worktree', path: right, baseRevision: 'fixture' },
      }, new AbortController().signal);
      await tick();
      expect(one.process.specs[0]!.cacheKey).not.toBe(two.process.specs[0]!.cacheKey);
    } finally {
      fs.rmSync(left, { recursive: true, force: true });
      fs.rmSync(right, { recursive: true, force: true });
    }
  });

  it('forwards model credentials without forwarding legacy environment-based model discovery', async () => {
    const { process, supervisor } = fixture({
      env: {
        OCTOCODE_MODEL_API_KEY: 'fixture-key',
        OCTOCODE_MODEL_ENDPOINT: 'http://127.0.0.1:43123/v1',
        OCTOCODE_MODEL_PROTOCOL: 'openai-chat-completions',
        OCTOCODE_MODEL: 'fixture-model',
        OMIT: 'nope',
      },
    });

    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();

    expect(process.specs[0]!.env).toMatchObject({
      OCTOCODE_MODEL_API_KEY: 'fixture-key',
    });
    expect(process.specs[0]!.env).not.toHaveProperty('OCTOCODE_MODEL_ENDPOINT');
    expect(process.specs[0]!.env).not.toHaveProperty('OCTOCODE_MODEL_PROTOCOL');
    expect(process.specs[0]!.env).not.toHaveProperty('OCTOCODE_MODEL');
    expect(process.specs[0]!.env).not.toHaveProperty('OMIT');
  });

  it('never propagates worker authorization into a child process', async () => {
    const process = new FakeProcessAdapter();
    const port = new NativeWorkerProcessPort({
      process,
      command: '/usr/bin/node',
      argvPrefix: ['/opt/agent.mjs'],
      cwd: '/tmp',
    });
    const supervisor = new WorkerSupervisor({ port, maxActive: 1 });
    const packet = {
      ...spawnPacket('leaf-child'),
      capabilities: { tools: [], models: [], maxTurns: 1 },
    };

    await supervisor.spawn(packet);
    await tick();

    expect(process.specs[0]).toMatchObject({
      args: ['/opt/agent.mjs', '--mode', 'rpc', '--no-session'],
      env: {
        OCTOCODE_NATIVE_WORKER: '1',
        OCTOCODE_NATIVE_WORKER_DEPTH: '1',
        OCTOCODE_NATIVE_WORKER_MAX_DEPTH: '1',
      },
    });
  });

  it('rejects recursive worker capability at the configured depth cap', async () => {
    const process = new FakeProcessAdapter();
    const port = new NativeWorkerProcessPort({
      process,
      command: '/usr/bin/node',
      argvPrefix: ['/opt/agent.mjs'],
      cwd: '/tmp',
      workerDepth: 0,
      maxWorkerDepth: 1,
    });

    await expect(port.spawn({
      ...spawnPacket('nested-cap'),
      capabilities: { tools: ['worker'], models: [], maxTurns: 1 },
    }, new AbortController().signal)).rejects.toThrow(/depth cap/i);
    expect(process.specs).toHaveLength(0);
  });

  it('leaves bounded concurrency and queued cleanup solely to WorkerSupervisor', async () => {
    const { process, supervisor } = fixture({ maxActive: 1 });
    await supervisor.spawn(spawnPacket('worker-1'));
    const queued = await supervisor.spawn(spawnPacket('worker-2'));
    await tick();
    expect(queued.state).toBe('queued');
    expect(process.processes).toHaveLength(1);

    process.processes[0]!.complete({ code: 0, signal: null });
    await supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority);
    await tick();
    expect(process.processes).toHaveLength(2);
    expect(supervisor.status(workerId('worker-2'), spawnPacket('worker-2').authority)).toMatchObject({ state: 'running' });
  });

  it('maps live input and graceful cancel before TERM, with force kill owned by core', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    await supervisor.send({
      schemaVersion: 1, type: 'worker.send', packetId: packetId('send'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('worker-1').authority, redaction: 'sensitive', text: 'new turn',
    });
    await supervisor.steer({
      schemaVersion: 1, type: 'worker.steer', packetId: packetId('steer'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('worker-1').authority, redaction: 'sensitive', text: 'redirect',
    });
    await supervisor.followUp({
      schemaVersion: 1, type: 'worker.follow-up', packetId: packetId('follow-up'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('worker-1').authority, redaction: 'sensitive', text: 'next task',
    });
    await supervisor.abort(workerId('worker-1'), spawnPacket('worker-1').authority, 'stop');
    expect(process.processes[0]!.abort).toHaveBeenCalledTimes(1);
    expect(process.processes[0]!.writes.map((line) => JSON.parse(line).command)).toEqual([
      { type: 'input.submit', text: 'task-worker-1' },
      { type: 'input.submit', text: 'new turn' },
      { type: 'input.steer', text: 'redirect' },
      { type: 'input.follow-up', text: 'next task' },
      { type: 'input.cancel', reason: 'stop' },
    ]);
    process.processes[0]!.complete({ code: null, signal: 'SIGTERM' });
    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({ outcome: 'aborted' });

    await supervisor.spawn(spawnPacket('worker-2'));
    await tick();
    await supervisor.kill(workerId('worker-2'), spawnPacket('worker-2').authority, 'force');
    expect(process.processes[1]!.kill).toHaveBeenCalledTimes(1);
    process.processes[1]!.complete({ code: null, signal: 'SIGKILL' });
    await expect(supervisor.wait(workerId('worker-2'), spawnPacket('worker-2').authority)).resolves.toMatchObject({ outcome: 'killed' });
  });

  it('ends RPC input exactly once when wait joins a live worker', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn(spawnPacket('join'));
    await tick();

    const first = supervisor.wait(workerId('join'), spawnPacket('join').authority);
    const second = supervisor.wait(workerId('join'), spawnPacket('join').authority);
    await tick();
    expect(process.processes[0]!.endInput).toHaveBeenCalledOnce();
    process.processes[0]!.complete({ code: 0, signal: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: 'succeeded' }),
      expect.objectContaining({ outcome: 'succeeded' }),
    ]);
  });

  it('fails closed for worktree mode and resolves all waiters with one terminal ledger entry', async () => {
    const { process, supervisor, ledger } = fixture();
    await expect(supervisor.spawn({
      ...spawnPacket('worktree'),
      workspace: { mode: 'worktree', path: '/tmp/worktree', baseRevision: 'abc' },
    })).rejects.toThrow('worktree isolation is unavailable');

    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    const first = supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority);
    const second = supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority);
    process.processes[0]!.complete({ code: 0, signal: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: 'succeeded' }),
      expect.objectContaining({ outcome: 'succeeded' }),
    ]);
    expect(ledger.filter((entry) => entry.type === 'worker.terminal' && entry.workerId === 'worker-1')).toHaveLength(1);
  });

  it('fails terminal output on malformed or non-monotonic RPC stdout', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    process.processes[0]!.stdout.push(eventLine('duplicate', 1));
    process.processes[0]!.complete({ code: 0, signal: null });
    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({
      outcome: 'failed', reason: 'Worker RPC event sequence is invalid',
    });
    expect(process.processes[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing failure error', (requestId: string) => ({ protocolVersion: 1, requestId, ok: false })],
    ['contradictory success branch', (requestId: string) => ({ protocolVersion: 1, requestId, ok: true, error: { category: 'validation' } })],
    ['extra response key', (requestId: string) => ({ protocolVersion: 1, requestId, ok: true, extra: true })],
    ['malformed event payload', (_requestId: string) => ({ protocolVersion: 1, sequence: 2, event: { type: 'message.delta' } })],
  ])('fails closed and settles once for %s', async (_name, malformed) => {
    const { process, supervisor, ledger } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    const child = process.processes[0]!;
    child.autoRespond = false;
    const send = supervisor.send({
      schemaVersion: 1, type: 'worker.send', packetId: packetId('send-malformed'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), authority: spawnPacket('worker-1').authority, redaction: 'sensitive', text: 'next',
    });
    await tick();
    const requestId = (JSON.parse(child.writes.at(-1)!) as { requestId: string }).requestId;
    child.stdout.push(`${JSON.stringify(malformed(requestId))}\n`);

    await expect(send).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdout.push(`${JSON.stringify(malformed(requestId))}\n`);
    child.complete({ code: 0, signal: null });
    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({ outcome: 'failed' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(ledger.filter((entry) => entry.type === 'worker.terminal' && entry.workerId === 'worker-1')).toHaveLength(1);
  });

  it('rejects an otherwise valid response with unknown correlation exactly once', async () => {
    const { process, supervisor, ledger } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    const child = process.processes[0]!;
    child.stdout.push(`${JSON.stringify({ protocolVersion: 1, requestId: 'unknown-request', ok: true })}\n`);
    child.stdout.push(`${JSON.stringify({ protocolVersion: 1, requestId: 'unknown-request', ok: true })}\n`);
    child.complete({ code: 0, signal: null });

    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({
      outcome: 'failed', reason: 'Worker RPC response correlation is invalid',
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(ledger.filter((entry) => entry.type === 'worker.terminal' && entry.workerId === 'worker-1')).toHaveLength(1);
  });

  it('rejects oversized capability metadata before spawning a process', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn({
      ...spawnPacket('worker-1'),
      capabilities: { tools: Array.from({ length: 129 }, (_, index) => `tool-${index}`), models: [], maxTurns: 1 },
    });
    await expect(supervisor.wait(workerId('worker-1'), spawnPacket('worker-1').authority)).resolves.toMatchObject({ outcome: 'failed' });
    expect(process.processes).toHaveLength(0);
  });

  it('provides a drain-aware writable stdin pipe in the real Node process adapter', async () => {
    const adapter = createNodeNativeWorkerProcessAdapter();
    const handle = adapter.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdin.once("data", data => { process.stdout.write(data); process.exit(0); })'],
      cwd: fs.realpathSync('/tmp'),
      env: Object.freeze({}),
      shell: false,
      promptDigest: 'digest',
      cacheKey: 'cache',
      ownershipToken: 'ownership-token',
      containmentGeneration: 'containment-generation',
    });
    await handle.write('ping\n');
    let stdout = '';
    for await (const chunk of handle.stdout) stdout += chunk.toString();
    await expect(handle.exit).resolves.toMatchObject({ code: 0 });
    expect(stdout).toBe('ping\n');
  });
});
