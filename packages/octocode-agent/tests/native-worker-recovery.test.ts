import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeOctocodeDb,
  listWorkerLifecycleEvents,
  octocodeDbPath,
  openOctocodeDb,
} from '@octocodeai/octocode-awareness/mcp-state';
import { WorkerSupervisor, correlationId, packetId, sessionId, workerId, type WorkerLedgerEntry, type WorkerSpawnPacket } from '@octocodeai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAwarenessWorkerLedger } from '../src/native-worker-ledger.js';
import { recoverNativeWorkerOrphans } from '../src/native-worker-recovery.js';
import { NativeWorkerProcessPort, createNodeNativeWorkerProcessAdapter, type NativeWorkerProcessIdentity } from '../src/native-workers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native worker restart recovery', () => {
  it('refuses to claim recovery for legacy nonterminal workers without durable process identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const ledger = new NativeAwarenessWorkerLedger({ workspace, env, now: () => Date.parse('2026-08-28T12:00:00.000Z') });
    await ledger.append({
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      redaction: 'sensitive', prompt: 'private prompt', promptSnapshotId: 'prompt-digest', workspace: { mode: 'shared' },
      capabilities: { tools: [], models: [], maxTurns: 1 },
    });
    await ledger.append({
      schemaVersion: 1, type: 'worker.state', packetId: packetId('state-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      redaction: 'sensitive', state: 'running',
    });

    const recovered = await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1', env, now: () => Date.parse('2026-08-28T12:05:00.000Z') });
    expect(recovered).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain('private prompt');
    expect(await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1', env })).toEqual([]);

    const dbPath = octocodeDbPath(env);
    const db = openOctocodeDb(dbPath);
    try {
      const events = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session-1', limit: 20 });
      expect(events.map((event) => event.type)).toEqual(['worker.spawn', 'worker.state']);
    } finally {
      closeOctocodeDb(dbPath);
    }
  });

  it('does not rewrite workers that already reached a terminal state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-terminal-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const ledger = new NativeAwarenessWorkerLedger({ workspace, env });
    await ledger.append({
      schemaVersion: 1, type: 'worker.terminal', packetId: packetId('terminal-1'),
      workerId: workerId('worker-1'), correlationId: correlationId('correlation-1'), sessionId: sessionId('session-1'),
      redaction: 'sensitive', outcome: 'succeeded',
    });
    expect(await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-1', env })).toEqual([]);
  });

  it('does not signal a reused PID whose durable identity no longer matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-reuse-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const ledger = new NativeAwarenessWorkerLedger({ workspace, env });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-reuse'), workerId: workerId('worker-reuse'),
      correlationId: correlationId('correlation-reuse'), sessionId: sessionId('session-reuse'), redaction: 'sensitive',
      prompt: 'work', promptSnapshotId: 'digest', workspace: { mode: 'shared' }, capabilities: { tools: [], models: [], maxTurns: 1 },
    };
    const identity: NativeWorkerProcessIdentity = { pid: 4242, startToken: 'old', commandSha256: 'a'.repeat(64), ownershipTokenSha256: 'b'.repeat(64), verification: 'linux-proc' };
    await ledger.append(spawn); await ledger.recordProcess(spawn, identity);
    const signal = vi.fn();
    const receipts = await recoverNativeWorkerOrphans({
      workspace, sessionId: 'session-reuse', env,
      process: { exists: () => true, signal, probe: () => ({ ...identity, startToken: 'new' }) },
    });
    expect(signal).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({ termination: 'identity-replaced' })]);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('spawns through the production supervisor/port and restart recovery leaves no live child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-recovery-real-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const durable = new NativeAwarenessWorkerLedger({ workspace, env });
    let parentAlive = true;
    let childIdentity: NativeWorkerProcessIdentity | undefined;
    const ledger = { append: async (entry: WorkerLedgerEntry) => { if (parentAlive || entry.type !== 'worker.terminal') await durable.append(entry); } };
    const script = `let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const req=JSON.parse(line);process.stdout.write(JSON.stringify({protocolVersion:1,requestId:req.requestId,ok:true})+'\\n')}});setInterval(()=>{},1000);`;
    const port = new NativeWorkerProcessPort({
      process: createNodeNativeWorkerProcessAdapter(), command: process.execPath, argvPrefix: ['-e', script], cwd: workspace, env: {},
      onProcessStarted: async (packet, identity) => { childIdentity = identity; await durable.recordProcess(packet, identity); },
    });
    const supervisor = new WorkerSupervisor({ port, ledger, maxActive: 1 });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('spawn-real'), workerId: workerId('worker-real'),
      correlationId: correlationId('correlation-real'), sessionId: sessionId('session-real'), redaction: 'sensitive',
      prompt: 'stay alive', promptSnapshotId: 'digest', workspace: { mode: 'shared' }, capabilities: { tools: [], models: [], maxTurns: 1 },
    };
    await supervisor.spawn(spawn);
    for (let index = 0; index < 100 && supervisor.status(spawn.workerId)?.state !== 'running'; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(supervisor.status(spawn.workerId)?.state).toBe('running');
    expect(childIdentity).toBeDefined();
    parentAlive = false;

    const receipts = await recoverNativeWorkerOrphans({ workspace, sessionId: 'session-real', env, termGraceMs: 500, killGraceMs: 500, pollMs: 10 });
    expect(receipts).toEqual([expect.objectContaining({ workerId: 'worker-real', termination: expect.stringMatching(/terminated|killed/) })]);
    for (let index = 0; index < 100; index += 1) {
      try { process.kill(childIdentity!.pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { break; }
    }
    expect(() => process.kill(childIdentity!.pid, 0)).toThrow();
    const db = openOctocodeDb(octocodeDbPath(env));
    try {
      const events = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session-real', limit: 20 });
      expect(events.map((event) => event.type)).toContain('worker.process');
      expect(events.filter((event) => event.type === 'worker.terminal')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('OCTOCODE_WORKER_OWNERSHIP_TOKEN');
    } finally { closeOctocodeDb(octocodeDbPath(env)); }
  });
});
