import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDb, listWorkerLifecycleEvents, resolveDbPath } from '@octocodeai/octocode-awareness';
import { WorkerSupervisor, correlationId, packetId, sessionId, workerId, type WorkerLedgerEntry, type WorkerSpawnPacket } from '@octocodeai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAwarenessWorkerLedger } from '../src/native-worker-ledger.js';
import { recoverNativeWorkerOrphans } from '../src/native-worker-recovery.js';
import { NativeWorkerProcessPort, createNodeNativeWorkerProcessAdapter, type NativeWorkerProcessIdentity } from '../src/native-workers.js';
import { workerAuthorityFixture } from './worker-authority-fixture.js';

const roots: string[] = [];
beforeEach(() => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-recovery-home-'));
  roots.push(testHome);
  vi.stubEnv('OCTOCODE_HOME', testHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native worker restart recovery', () => {
  it('refuses to claim recovery for legacy nonterminal workers without durable process identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const ledger = new NativeAwarenessWorkerLedger({ workspace, now: () => Date.parse('2026-08-28T12:00:00.000Z') });
    await ledger.append({
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      authority: workerAuthorityFixture({ workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1') }),
      redaction: 'sensitive', prompt: 'private prompt', promptSnapshotId: 'prompt-digest', workspace: { mode: 'shared' },
      capabilities: { tools: [], models: [], maxTurns: 1 },
    });
    await ledger.append({
      schemaVersion: 1, type: 'worker.state', packetId: packetId('state-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      authority: workerAuthorityFixture({ workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1') }),
      redaction: 'sensitive', state: 'running',
    });

    const recovered = await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1', now: () => Date.parse('2026-08-28T12:05:00.000Z') });
    expect(recovered).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain('private prompt');
    expect(await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1' })).toEqual([]);

    const dbPath = resolveDbPath(undefined, { workspace });
    const db = connectDb(dbPath);
    try {
      const events = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session-1', limit: 20 });
      expect(events.map((event) => event.type)).toEqual(['worker.spawn', 'worker.state']);
    } finally {
      db.close();
    }
  });

  it('does not rewrite workers that already reached a terminal state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-terminal-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const ledger = new NativeAwarenessWorkerLedger({ workspace });
    await ledger.append({
      schemaVersion: 1, type: 'worker.terminal', packetId: packetId('terminal-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      authority: workerAuthorityFixture({ workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1') }),
      redaction: 'sensitive', outcome: 'succeeded',
    });
    expect(await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1' })).toEqual([]);
  });

  it('does not signal a reused PID whose durable identity no longer matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-reuse-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const ledger = new NativeAwarenessWorkerLedger({ workspace });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-reuse'), workerId: workerId('worker-reuse'),
      correlationId: correlationId('correlation-reuse'), sessionId: sessionId('session-reuse'), redaction: 'sensitive',
      authority: workerAuthorityFixture({ workerId: workerId('worker-reuse'), correlationId: correlationId('correlation-reuse'), sessionId: sessionId('session-reuse') }),
      prompt: 'work', promptSnapshotId: 'digest', workspace: { mode: 'shared' }, capabilities: { tools: [], models: [], maxTurns: 1 },
    };
    const identity: NativeWorkerProcessIdentity = {
      schemaVersion: 1,
      kind: 'posix-process-group',
      pid: 4242,
      processGroupId: 4242,
      generation: 'generation-old',
      startToken: 'old',
      commandSha256: 'a'.repeat(64),
      ownershipTokenSha256: 'b'.repeat(64),
      verification: 'linux-proc',
    };
    await ledger.append(spawn); await ledger.recordProcess(spawn, identity);
    const signal = vi.fn();
    const receipts = await recoverNativeWorkerOrphans({
      workspace, sessionId: 'session-reuse',
      containment: {
        signal,
        report: () => ({ identity, state: 'identity-replaced', members: [identity.pid] }),
        wait: vi.fn(),
      },
    });
    expect(signal).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({ termination: 'identity-replaced' })]);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('spawns through the production supervisor/port and restart recovery leaves no live child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-real-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const durable = new NativeAwarenessWorkerLedger({ workspace });
    let parentAlive = true;
    let childIdentity: NativeWorkerProcessIdentity | undefined;
    const ledger = { append: async (entry: WorkerLedgerEntry) => { if (parentAlive || entry.type !== 'worker.terminal') await durable.append(entry); } };
    const script = `let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const req=JSON.parse(line);process.stdout.write(JSON.stringify({protocolVersion:1,requestId:req.requestId,ok:true})+'\\n')}});setInterval(()=>{},1000);`;
    const workerFixture = path.join(root, 'worker-fixture.mjs');
    fs.writeFileSync(workerFixture, script);
    const port = new NativeWorkerProcessPort({
      process: createNodeNativeWorkerProcessAdapter(), command: process.execPath, argvPrefix: [workerFixture], cwd: workspace, env: {},
      onProcessStarted: async (packet, identity) => { childIdentity = identity; await durable.recordProcess(packet, identity); },
    });
    const supervisor = new WorkerSupervisor({ port, ledger, maxActive: 1 });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-real'), workerId: workerId('worker-real'),
      correlationId: correlationId('correlation-real'), sessionId: sessionId('session-real'), redaction: 'sensitive',
      authority: workerAuthorityFixture({ workerId: workerId('worker-real'), correlationId: correlationId('correlation-real'), sessionId: sessionId('session-real') }),
      prompt: 'stay alive', promptSnapshotId: 'digest', workspace: { mode: 'shared' }, capabilities: { tools: [], models: [], maxTurns: 1 },
    };
    await supervisor.spawn(spawn);
    for (let index = 0; index < 100 && supervisor.status(spawn.workerId, spawn.authority)?.state !== 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(supervisor.status(spawn.workerId, spawn.authority)?.state).toBe('running');
    expect(childIdentity).toBeDefined();
    parentAlive = false;

    const receipts = await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-real', termGraceMs: 500, killGraceMs: 500, pollMs: 10 });
    // Under process-heavy suites the child can exit and its PID can be reused before
    // recovery probes it. Identity replacement is the required fail-closed result;
    // the assertion below still proves that the original child is no longer live.
    expect(receipts).toEqual([expect.objectContaining({
      workerId: 'worker-real',
      termination: expect.stringMatching(/terminated|killed|already-exited|identity-replaced/),
    })]);
    for (let index = 0; index < 100; index += 1) {
      try { process.kill(childIdentity!.pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { break; }
    }
    expect(() => process.kill(childIdentity!.pid, 0)).toThrow();
    const dbPath = resolveDbPath(undefined, { workspace });
    const db = connectDb(dbPath);
    try {
      const events = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session-real', limit: 20 });
      expect(events.map((event) => event.type)).toContain('worker.process');
      expect(events.filter((event) => event.type === 'worker.terminal')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('OCTOCODE_WORKER_OWNERSHIP_TOKEN');
    } finally { db.close(); }
  });
});
