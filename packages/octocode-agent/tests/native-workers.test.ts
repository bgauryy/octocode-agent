import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  NativeWorkerWorktreePort,
  NativeWorkerProcessPort,
  createNodeNativeWorkerProcessAdapter,
  type NativeWorkerProcessAdapter,
  type NativeWorkerProcessHandle,
  type NativeWorkerProcessResult,
  type NativeWorkerProcessSpec,
  type NativeGitProcessAdapter,
} from '../src/native-workers.js';

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
      trust: { workspace: 'trusted', managedOnly: false }, payload: { type: 'text', text },
    },
  })}\n`;
}

class FakeProcess implements NativeWorkerProcessHandle {
  readonly pid: number;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly exit;
  readonly writes: string[] = [];
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
  return {
    schemaVersion: 1,
    type: 'worker.spawn',
    packetId: packetId(`spawn-${id}`),
    workerId: workerId(id),
    correlationId: correlationId(`correlation-${id}`),
    sessionId: sessionId('parent-session'),
    redaction: 'sensitive',
    prompt,
    promptSnapshotId: `prompt-${id}`,
    workspace: { mode: 'shared' },
    capabilities: { tools: [], models: [], maxTurns: 1 },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(options: { maxActive?: number; env?: NodeJS.ProcessEnv; envAllowlist?: string[] } = {}) {
  const process = new FakeProcessAdapter();
  const ledger: WorkerLedgerEntry[] = [];
  const port = new NativeWorkerProcessPort({
    process,
    command: '/usr/bin/node',
    argvPrefix: ['/opt/agent with spaces.mjs'],
    cwd: '/tmp',
    env: options.env,
    envAllowlist: options.envAllowlist,
  });
  const supervisor = new WorkerSupervisor({
    port,
    maxActive: options.maxActive ?? 2,
    ledger: { append: async (entry) => { ledger.push(entry); } },
  });
  return { process, port, supervisor, ledger };
}

describe('native worker process port', () => {
  it('captures structured completion through the core supervisor', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    process.processes[0]!.complete({ code: 0, signal: null });

    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({
      outcome: 'succeeded',
      correlationId: 'correlation-worker-1',
      handback: { text: 'result-1', exitCode: 0, signal: null, events: [expect.any(Object)] },
    });
    expect(supervisor.status(workerId('worker-1'))).toMatchObject({ state: 'succeeded' });
  });

  it('reports process failure without exposing prompt, stderr, argv, or environment', async () => {
    const { process, supervisor } = fixture({ env: { OPENAI_API_KEY: 'super-secret', SAFE: 'value' } });
    await supervisor.spawn(spawnPacket('worker-1', 'private task body'));
    await tick();
    process.processes[0]!.complete({ code: 7, signal: null });

    const terminal = await supervisor.wait(workerId('worker-1'));
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

  it('leaves bounded concurrency and queued cleanup solely to WorkerSupervisor', async () => {
    const { process, supervisor } = fixture({ maxActive: 1 });
    await supervisor.spawn(spawnPacket('worker-1'));
    const queued = await supervisor.spawn(spawnPacket('worker-2'));
    await tick();
    expect(queued.state).toBe('queued');
    expect(process.processes).toHaveLength(1);

    process.processes[0]!.complete({ code: 0, signal: null });
    await supervisor.wait(workerId('worker-1'));
    await tick();
    expect(process.processes).toHaveLength(2);
    expect(supervisor.status(workerId('worker-2'))).toMatchObject({ state: 'running' });
  });

  it('maps live input and graceful cancel before TERM, with force kill owned by core', async () => {
    const { process, supervisor } = fixture();
    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    await supervisor.send({
      schemaVersion: 1, type: 'worker.send', packetId: packetId('send'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), redaction: 'sensitive', text: 'new turn',
    });
    await supervisor.steer({
      schemaVersion: 1, type: 'worker.steer', packetId: packetId('steer'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), redaction: 'sensitive', text: 'redirect',
    });
    await supervisor.followUp({
      schemaVersion: 1, type: 'worker.follow-up', packetId: packetId('follow-up'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-worker-1'),
      sessionId: sessionId('parent-session'), redaction: 'sensitive', text: 'next task',
    });
    await supervisor.abort(workerId('worker-1'), 'stop');
    expect(process.processes[0]!.abort).toHaveBeenCalledTimes(1);
    expect(process.processes[0]!.writes.map((line) => JSON.parse(line).command)).toEqual([
      { type: 'input.submit', text: 'task-worker-1' },
      { type: 'input.submit', text: 'new turn' },
      { type: 'input.steer', text: 'redirect' },
      { type: 'input.follow-up', text: 'next task' },
      { type: 'input.cancel', reason: 'stop' },
    ]);
    process.processes[0]!.complete({ code: null, signal: 'SIGTERM' });
    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({ outcome: 'aborted' });

    await supervisor.spawn(spawnPacket('worker-2'));
    await tick();
    await supervisor.kill(workerId('worker-2'), 'force');
    expect(process.processes[1]!.kill).toHaveBeenCalledTimes(1);
    process.processes[1]!.complete({ code: null, signal: 'SIGKILL' });
    await expect(supervisor.wait(workerId('worker-2'))).resolves.toMatchObject({ outcome: 'killed' });
  });

  it('fails closed for worktree mode and resolves all waiters with one terminal ledger entry', async () => {
    const { process, supervisor, ledger } = fixture();
    await expect(supervisor.spawn({
      ...spawnPacket('worktree'),
      workspace: { mode: 'worktree', path: '/tmp/worktree', baseRevision: 'abc' },
    })).rejects.toThrow('worktree isolation is unavailable');

    await supervisor.spawn(spawnPacket('worker-1'));
    await tick();
    const first = supervisor.wait(workerId('worker-1'));
    const second = supervisor.wait(workerId('worker-1'));
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
    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({
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
      sessionId: sessionId('parent-session'), redaction: 'sensitive', text: 'next',
    });
    await tick();
    const requestId = (JSON.parse(child.writes.at(-1)!) as { requestId: string }).requestId;
    child.stdout.push(`${JSON.stringify(malformed(requestId))}\n`);

    await expect(send).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdout.push(`${JSON.stringify(malformed(requestId))}\n`);
    child.complete({ code: 0, signal: null });
    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({ outcome: 'failed' });
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

    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({
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
    await expect(supervisor.wait(workerId('worker-1'))).resolves.toMatchObject({ outcome: 'failed' });
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
    });
    await handle.write('ping\n');
    let stdout = '';
    for await (const chunk of handle.stdout) stdout += chunk.toString();
    await expect(handle.exit).resolves.toMatchObject({ code: 0 });
    expect(stdout).toBe('ping\n');
  });
});

describe('native worker worktree lifecycle', () => {
  it('creates a contained worktree with non-shell git arguments and runs the worker there', async () => {
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const root = fs.mkdtempSync('/tmp/octocode-worker-tests-');
    const target = `${root}/isolated`;
    const physicalTarget = path.join(fs.realpathSync(root), 'isolated');
    const git: NativeGitProcessAdapter = { run: vi.fn(async (cwd, args) => {
      calls.push({ cwd, args });
      if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(target, { recursive: true });
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    }) };
    const worktrees = new NativeWorkerWorktreePort({ repositoryRoot: '/tmp', worktreesRoot: root, git });
    const process = new FakeProcessAdapter();
    const supervisor = new WorkerSupervisor({
      port: new NativeWorkerProcessPort({ process, command: '/usr/bin/node', cwd: '/tmp' }),
      worktrees,
      maxActive: 1,
    });
    const packet = { ...spawnPacket('isolated'), workspace: { mode: 'worktree' as const, path: target, baseRevision: 'HEAD' } };
    await supervisor.spawn(packet);
    await tick();
    expect(calls[0]).toEqual({ cwd: fs.realpathSync('/tmp'), args: ['worktree', 'add', '--detach', physicalTarget, 'HEAD'] });
    expect(process.specs[0]?.cwd).toBe(fs.realpathSync(target));
    expect(calls.every(({ args }) => !args.includes('--shell'))).toBe(true);
    process.processes[0]!.complete({ code: 0, signal: null });
    await expect(supervisor.wait(packet.workerId)).resolves.toMatchObject({ outcome: 'succeeded' });
  });

  it('fails closed for escaping paths and dirty refresh/discard, retaining recoverable worktrees', async () => {
    const git: NativeGitProcessAdapter = { run: vi.fn(async (_cwd, args) => {
      if (args[0] === 'status') return { stdout: ' M changed.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }) };
    const root = '/tmp/octocode-worker-contained';
    fs.mkdirSync('/tmp/octocode-worker-contained/dirty', { recursive: true });
    const worktrees = new NativeWorkerWorktreePort({ repositoryRoot: '/tmp', worktreesRoot: root, git });
    await expect(worktrees.prepare({ ...spawnPacket('escape'), workspace: { mode: 'worktree', path: '/tmp/escape', baseRevision: 'HEAD' } }, new AbortController().signal)).rejects.toThrow('contained');
    const dirty = { ...spawnPacket('dirty'), workspace: { mode: 'worktree' as const, path: `${root}/dirty`, baseRevision: 'HEAD' } };
    await expect(worktrees.prepare(dirty, new AbortController().signal)).rejects.toThrow('dirty');
    await expect(worktrees.recover({ path: `${root}/dirty`, action: 'discard' })).rejects.toThrow('dirty');
    expect(git.run).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['remove']));
  });

  it('rejects relative paths and non-existent targets reached through an escaping symlink ancestor', async () => {
    const root = fs.mkdtempSync('/tmp/octocode-worker-root-');
    const outside = fs.mkdtempSync('/tmp/octocode-worker-outside-');
    fs.symlinkSync(outside, `${root}/link`, 'dir');
    const git: NativeGitProcessAdapter = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) };
    const worktrees = new NativeWorkerWorktreePort({ repositoryRoot: '/tmp', worktreesRoot: root, git });
    const signal = new AbortController().signal;
    await expect(worktrees.prepare({
      ...spawnPacket('relative'), workspace: { mode: 'worktree', path: 'relative/worktree', baseRevision: 'HEAD' },
    }, signal)).rejects.toThrow('absolute');
    await expect(worktrees.prepare({
      ...spawnPacket('symlink'), workspace: { mode: 'worktree', path: `${root}/link/not-created`, baseRevision: 'HEAD' },
    }, signal)).rejects.toThrow('contained');
    expect(git.run).not.toHaveBeenCalled();
  });

  it('revalidates the worktree process cwd against the configured root before spawn', async () => {
    const root = fs.mkdtempSync('/tmp/octocode-worker-cwd-root-');
    const outside = fs.mkdtempSync('/tmp/octocode-worker-cwd-outside-');
    const process = new FakeProcessAdapter();
    const port = new NativeWorkerProcessPort({
      process, command: '/usr/bin/node', cwd: '/tmp', worktreesRoot: root,
    });
    await expect(port.spawn({
      ...spawnPacket('cwd-escape'), workspace: { mode: 'worktree', path: outside, baseRevision: 'HEAD' },
    }, new AbortController().signal)).rejects.toThrow('contained');
    expect(process.specs).toHaveLength(0);
  });

  it('creates and discards a real git worktree when launched from a repository subdirectory', async () => {
    const repository = fs.mkdtempSync('/tmp/octocode-worker-repository-');
    const worktreesRoot = fs.mkdtempSync('/tmp/octocode-worker-real-worktrees-');
    const subdirectory = path.join(repository, 'nested', 'cwd');
    fs.mkdirSync(subdirectory, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Octocode Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });
    const target = path.join(worktreesRoot, 'worker');
    const worktrees = new NativeWorkerWorktreePort({ repositoryRoot: subdirectory, worktreesRoot });
    try {
      await worktrees.prepare({
        ...spawnPacket('real-subdirectory'), workspace: { mode: 'worktree', path: target, baseRevision: 'HEAD' },
      }, new AbortController().signal);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
      await worktrees.recover({ path: target, action: 'discard' });
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(worktreesRoot, { recursive: true, force: true });
    }
  });
});
