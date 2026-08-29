import { describe, expect, it, vi } from 'vitest';
import {
  WorkerSupervisor,
  correlationId,
  packetId,
  sessionId,
  workerId,
  type WorkerHandle,
  type WorkerLedgerEntry,
  type WorkerPacket,
  type WorkerPort,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
} from '../src/index.js';

interface ControlledWorker {
  readonly handle: WorkerHandle;
  readonly packets: WorkerPacket[];
  readonly abort: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
  finish(packet: WorkerTerminalPacket): void;
  crash(error: Error): void;
}

const spawnPacket = (id: string): WorkerSpawnPacket => ({
  schemaVersion: 1,
  type: 'worker.spawn',
  packetId: packetId(`spawn:${id}`),
  workerId: workerId(id),
  correlationId: correlationId(`correlation:${id}`),
  sessionId: sessionId(`session:${id}`),
  prompt: `work ${id}`,
  promptSnapshotId: `prompt:${id}`,
  workspace: { mode: 'shared' },
  redaction: 'sensitive',
  capabilities: { tools: ['localSearchCode'], models: [{ providerId: 'openai', modelId: 'gpt' }], maxTurns: 4 },
});

const terminalPacket = (spawn: WorkerSpawnPacket, outcome: WorkerTerminalPacket['outcome']): WorkerTerminalPacket => ({
  schemaVersion: 1,
  type: 'worker.terminal',
  packetId: packetId(`terminal:${spawn.workerId}`),
  workerId: spawn.workerId,
  correlationId: spawn.correlationId,
  sessionId: spawn.sessionId,
  redaction: spawn.redaction,
  outcome,
  ...(outcome === 'succeeded' ? { handback: { summary: 'done' } } : { reason: outcome }),
});

const controlled = (): ControlledWorker => {
  let resolve!: (packet: WorkerTerminalPacket) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<WorkerTerminalPacket>((accept, fail) => { resolve = accept; reject = fail; });
  const packets: WorkerPacket[] = [];
  const abort = vi.fn(async () => undefined);
  const kill = vi.fn(async () => undefined);
  return {
    packets,
    abort,
    kill,
    handle: { send: async (packet) => { packets.push(packet); }, abort, kill, completion },
    finish: resolve,
    crash: reject,
  };
};

const tick = async (): Promise<void> => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

describe('WorkerSupervisor', () => {
  it('enforces active concurrency and drains queued workers in FIFO order', async () => {
    const workers = new Map<string, ControlledWorker>();
    const starts: string[] = [];
    const port: WorkerPort = { spawn: async (packet) => {
      starts.push(packet.workerId);
      const worker = controlled(); workers.set(packet.workerId, worker); return worker.handle;
    } };
    const supervisor = new WorkerSupervisor({ port, maxActive: 1 });
    const first = spawnPacket('one'); const second = spawnPacket('two');

    await supervisor.spawn(first);
    await supervisor.spawn(second);
    await tick();
    expect(starts).toEqual(['one']);
    expect(supervisor.status(second.workerId)?.state).toBe('queued');

    workers.get('one')?.finish(terminalPacket(first, 'succeeded'));
    await supervisor.wait(first.workerId);
    await tick();
    expect(starts).toEqual(['one', 'two']);
    expect(supervisor.list().map(({ workerId: id }) => id)).toEqual(['one', 'two']);
  });

  it('preserves queued send, steer, and follow-up order until the worker is live', async () => {
    const first = controlled(); const second = controlled();
    let starts = 0;
    const supervisor = new WorkerSupervisor({ port: { spawn: async () => (++starts === 1 ? first.handle : second.handle) }, maxActive: 1 });
    const a = spawnPacket('a'); const b = spawnPacket('b');
    await supervisor.spawn(a); await supervisor.spawn(b); await tick();
    const input = (type: 'worker.send' | 'worker.steer' | 'worker.follow-up', sequence: number): WorkerPacket => ({
      schemaVersion: 1, type, packetId: packetId(`input:${sequence}`), workerId: b.workerId,
      correlationId: b.correlationId, sessionId: b.sessionId, redaction: 'public', text: String(sequence),
    });
    await supervisor.send(input('worker.send', 1));
    await supervisor.steer(input('worker.steer', 2));
    await supervisor.followUp(input('worker.follow-up', 3));
    expect(supervisor.status(b.workerId)?.queueDepth).toBe(3);

    first.finish(terminalPacket(a, 'succeeded'));
    await supervisor.wait(a.workerId); await tick();
    expect(second.packets.map(({ type }) => type)).toEqual(['worker.send', 'worker.steer', 'worker.follow-up']);
    expect(supervisor.status(b.workerId)?.queueDepth).toBe(0);
  });

  it('aborts queued workers without spawning them and normalizes crashes', async () => {
    const live = controlled(); let starts = 0;
    const entries: WorkerLedgerEntry[] = [];
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => { starts += 1; return live.handle; } }, maxActive: 1,
      ledger: { append: async (entry) => { entries.push(entry); } },
    });
    const a = spawnPacket('a'); const b = spawnPacket('b');
    await supervisor.spawn(a); await supervisor.spawn(b); await tick();
    await supervisor.abort(b.workerId, 'not needed');
    expect((await supervisor.wait(b.workerId)).outcome).toBe('aborted');
    expect(starts).toBe(1);

    live.crash(new Error('secret subprocess detail'));
    const terminal = await supervisor.wait(a.workerId);
    expect(terminal).toMatchObject({ outcome: 'failed', reason: 'Worker crashed' });
    expect(JSON.stringify(terminal)).not.toContain('secret subprocess detail');
    expect(entries.filter((entry) => entry.type === 'worker.terminal' && entry.workerId === a.workerId)).toHaveLength(1);
  });

  it('kills reliably and ignores a late terminal packet', async () => {
    const worker = controlled(); const entries: WorkerLedgerEntry[] = [];
    const spawn = spawnPacket('kill');
    const supervisor = new WorkerSupervisor({ port: { spawn: async () => worker.handle }, maxActive: 1, ledger: { append: async (entry) => { entries.push(entry); } } });
    await supervisor.spawn(spawn); await tick();
    await supervisor.kill(spawn.workerId, 'deadline');
    expect((await supervisor.wait(spawn.workerId)).outcome).toBe('killed');
    worker.finish(terminalPacket(spawn, 'succeeded'));
    await tick();
    expect(supervisor.status(spawn.workerId)?.terminal?.outcome).toBe('killed');
    expect(entries.filter(({ type }) => type === 'worker.terminal')).toHaveLength(1);
    expect(worker.kill).toHaveBeenCalledOnce();
  });

  it('rejects packets whose worker, session, or correlation does not match', async () => {
    const worker = controlled(); const spawn = spawnPacket('bound');
    const supervisor = new WorkerSupervisor({ port: { spawn: async () => worker.handle }, maxActive: 1 });
    await supervisor.spawn(spawn); await tick();
    const wrong: WorkerPacket = {
      schemaVersion: 1, type: 'worker.send', packetId: packetId('wrong'), workerId: spawn.workerId,
      correlationId: correlationId('different'), sessionId: spawn.sessionId, redaction: 'public', text: 'nope',
    };
    await expect(supervisor.send(wrong)).rejects.toMatchObject({ category: 'validation' });
    expect(worker.packets).toEqual([]);
  });

  it('performs joined shutdown and escalates workers that do not abort', async () => {
    vi.useFakeTimers();
    try {
      const a = controlled(); const b = controlled(); let starts = 0;
      const supervisor = new WorkerSupervisor({ port: { spawn: async () => (++starts === 1 ? a.handle : b.handle) }, maxActive: 2, shutdownGraceMs: 25 });
      const pa = spawnPacket('a'); const pb = spawnPacket('b');
      await supervisor.spawn(pa); await supervisor.spawn(pb); await tick();
      const shutdown = supervisor.shutdown('exit');
      await tick();
      expect(a.abort).toHaveBeenCalledOnce(); expect(b.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      await shutdown;
      expect(a.kill).toHaveBeenCalledOnce(); expect(b.kill).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({ state: 'stopped', active: 0, queued: 0 });
      await expect(supervisor.spawn(spawnPacket('late'))).rejects.toMatchObject({ category: 'conflict' });
    } finally { vi.useRealTimers(); }
  });

  it('provides one command surface, snapshots prompt identity, and fails closed for worktrees', async () => {
    const worker = controlled(); const original = spawnPacket('command');
    const supervisor = new WorkerSupervisor({ port: { spawn: async (packet) => {
      expect(packet.promptSnapshotId).toBe('prompt:command');
      expect(packet.capabilities.tools).toEqual(['localSearchCode']);
      return worker.handle;
    } }, maxActive: 1 });
    await expect(supervisor.execute({ type: 'spawn', packet: { ...spawnPacket('worktree'), workspace: { mode: 'worktree', path: '/tmp/worktree', baseRevision: 'abc' } } }))
      .rejects.toMatchObject({ category: 'unsupported-capability' });
    const spawned = supervisor.execute({ type: 'spawn', packet: original });
    (original.capabilities.tools as string[]).push('mutated');
    await spawned; await tick();
    expect(await supervisor.execute({ type: 'status', workerId: original.workerId })).toMatchObject({ state: 'running' });
    worker.finish(terminalPacket(original, 'succeeded'));
    expect(await supervisor.execute({ type: 'wait', workerId: original.workerId })).toMatchObject({ outcome: 'succeeded' });
  });

  it('routes worktree preparation and terminal release through the lifecycle port', async () => {
    const worker = controlled();
    const spawn = { ...spawnPacket('isolated'), workspace: { mode: 'worktree' as const, path: '/contained/isolated', baseRevision: 'abc' } };
    const prepare = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const port = { spawn: vi.fn(async () => worker.handle) };
    const supervisor = new WorkerSupervisor({ port, worktrees: { prepare, release }, maxActive: 1 });
    await supervisor.spawn(spawn);
    await tick();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ workerId: spawn.workerId }), expect.any(AbortSignal));
    expect(port.spawn).toHaveBeenCalledOnce();
    const terminal = terminalPacket(spawn, 'succeeded');
    worker.finish(terminal);
    await expect(supervisor.wait(spawn.workerId)).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ workerId: spawn.workerId }), terminal);
  });

  it('settles terminal waiters and continues scheduling when fail-closed worktree cleanup retains state', async () => {
    const firstWorker = controlled();
    const secondWorker = controlled();
    const first = { ...spawnPacket('cleanup-fails'), workspace: { mode: 'worktree' as const, path: '/contained/dirty', baseRevision: 'abc' } };
    const second = spawnPacket('after-cleanup');
    const port = { spawn: vi.fn(async (packet: WorkerSpawnPacket) => packet.workerId === first.workerId ? firstWorker.handle : secondWorker.handle) };
    const supervisor = new WorkerSupervisor({
      port,
      worktrees: { prepare: async () => undefined, release: async () => { throw new Error('dirty worktree retained'); } },
      maxActive: 1,
    });
    await supervisor.spawn(first);
    await supervisor.spawn(second);
    await tick();
    firstWorker.finish(terminalPacket(first, 'succeeded'));
    await expect(supervisor.wait(first.workerId)).resolves.toMatchObject({ outcome: 'succeeded' });
    await tick();
    expect(supervisor.snapshot()).toMatchObject({ state: 'running', active: 1, queued: 0 });
    expect(port.spawn).toHaveBeenCalledTimes(2);
    secondWorker.finish(terminalPacket(second, 'succeeded'));
    await expect(supervisor.wait(second.workerId)).resolves.toMatchObject({ outcome: 'succeeded' });
  });

  it('rolls back an unpublished spawn when its first ledger write fails', async () => {
    const spawn = spawnPacket('ledger-spawn');
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => controlled().handle }, maxActive: 1,
      ledger: { append: async () => { throw new Error('disk unavailable'); } },
    });
    await expect(supervisor.spawn(spawn)).rejects.toMatchObject({ category: 'persistence' });
    expect(supervisor.status(spawn.workerId)).toBeNull();
    expect(supervisor.snapshot()).toMatchObject({ state: 'running', active: 0, queued: 0 });
  });

  it('fails closed when a durable state transition cannot commit', async () => {
    const spawn = spawnPacket('ledger-state'); let processStarts = 0;
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => { processStarts += 1; return controlled().handle; } }, maxActive: 1,
      ledger: { append: async (entry) => { if (entry.type === 'worker.state' && entry.state === 'starting') throw new Error('disk unavailable'); } },
    });
    await supervisor.spawn(spawn); await tick();
    await expect(supervisor.wait(spawn.workerId)).rejects.toMatchObject({ category: 'persistence' });
    expect(processStarts).toBe(0);
    expect(supervisor.snapshot()).toMatchObject({ state: 'failed', active: 0, queued: 0 });
  });

  it('rejects all waiters exactly once when a terminal ledger commit fails', async () => {
    const worker = controlled(); const spawn = spawnPacket('ledger-terminal'); let terminalWrites = 0;
    const supervisor = new WorkerSupervisor({
      port: { spawn: async () => worker.handle }, maxActive: 1,
      ledger: { append: async (entry) => { if (entry.type === 'worker.terminal') { terminalWrites += 1; throw new Error('disk unavailable'); } } },
    });
    await supervisor.spawn(spawn); await tick();
    const first = supervisor.wait(spawn.workerId); const second = supervisor.wait(spawn.workerId);
    worker.finish(terminalPacket(spawn, 'succeeded'));
    await expect(first).rejects.toMatchObject({ category: 'persistence' });
    await expect(second).rejects.toMatchObject({ category: 'persistence' });
    expect(terminalWrites).toBe(1);
    expect(supervisor.status(spawn.workerId)?.state).toBe('failed');
    expect(supervisor.status(spawn.workerId)?.terminal).toBeUndefined();
    expect(worker.kill).toHaveBeenCalledOnce();
  });
});
