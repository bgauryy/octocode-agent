import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { correlationId, packetId, sessionId, workerId, type WorkerSpawnPacket, type WorkerTerminalPacket } from '@octocodeai/agent-core';
import { connectDb, listWorkerLifecycleEvents, resolveDbPath } from '@octocodeai/octocode-awareness';
import { NativeAwarenessWorkerLedger } from '../src/native-worker-ledger.js';
import { workerAuthorityFixture } from './worker-authority-fixture.js';

let testHome: string;
beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-ledger-home-'));
  vi.stubEnv('OCTOCODE_HOME', testHome);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(testHome, { recursive: true, force: true }); });

describe('native Awareness worker ledger adapter', () => {
  it('persists the redacted process-group identity and ownership generation for restart fencing', async () => {
    const env = { OCTOCODE_HOME: path.join(os.tmpdir(), `octocode-worker-ledger-${crypto.randomUUID()}`) };
    const workspace = path.join(env.OCTOCODE_HOME, 'workspace');
    const ledger = new NativeAwarenessWorkerLedger({ workspace, now: () => 1_700_000_000_000 });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('packet:process'), workerId: workerId('worker:process'),
      correlationId: correlationId('correlation:process'), sessionId: sessionId('session:process'), redaction: 'sensitive',
      authority: workerAuthorityFixture({ workerId: workerId('worker:process'), correlationId: correlationId('correlation:process'), sessionId: sessionId('session:process') }),
      prompt: 'private delegated task', promptSnapshotId: 'a'.repeat(64), workspace: { mode: 'shared' },
      capabilities: { tools: [], models: [], maxTurns: 1 },
    };
    await ledger.recordProcess(spawn, {
      schemaVersion: 1,
      kind: 'posix-process-group',
      pid: 4242,
      processGroupId: 4242,
      generation: 'generation-1',
      startToken: 'start-token',
      commandSha256: 'b'.repeat(64),
      ownershipTokenSha256: 'c'.repeat(64),
      verification: 'linux-proc',
    });

    const dbPath = resolveDbPath(undefined, { workspace });
    const db = connectDb(dbPath);
    try {
      const [event] = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session:process' });
      expect(event?.payload).toEqual({
        schemaVersion: 1,
        kind: 'posix-process-group',
        pid: 4242,
        processGroupId: 4242,
        generation: 'generation-1',
        startToken: 'start-token',
        commandSha256: 'b'.repeat(64),
        ownershipTokenSha256: 'c'.repeat(64),
        verification: 'linux-proc',
      });
      expect(JSON.stringify(event)).not.toContain('private delegated task');
    } finally {
      db.close();
    }
  });

  it('persists correlated lifecycle and redacts raw prompts while retaining bounded handback', async () => {
    const env = { OCTOCODE_HOME: path.join(os.tmpdir(), `octocode-worker-ledger-${crypto.randomUUID()}`) };
    const workspace = path.join(env.OCTOCODE_HOME, 'workspace');
    const ledger = new NativeAwarenessWorkerLedger({ workspace, now: () => 1_700_000_000_000 });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('packet:spawn'), workerId: workerId('worker:1'),
      correlationId: correlationId('correlation:1'), sessionId: sessionId('session:1'), redaction: 'sensitive',
      authority: workerAuthorityFixture({ workerId: workerId('worker:1'), correlationId: correlationId('correlation:1'), sessionId: sessionId('session:1') }),
      prompt: 'private delegated task', promptSnapshotId: 'a'.repeat(64), workspace: { mode: 'shared' },
      capabilities: { tools: ['localSearch'], models: [{ providerId: 'openai', modelId: 'gpt-5' }], maxTurns: 4 },
    };
    const terminal: WorkerTerminalPacket = {
      schemaVersion: 1, type: 'worker.terminal', packetId: packetId('packet:terminal'), workerId: spawn.workerId,
      correlationId: spawn.correlationId, sessionId: spawn.sessionId, redaction: 'sensitive', outcome: 'succeeded',
      authority: spawn.authority,
      handback: { text: 'bounded result', ignored: { arbitrary: true } },
    };
    await ledger.append(spawn);
    await ledger.append(terminal);

    const dbPath = resolveDbPath(undefined, { workspace });
    const db = connectDb(dbPath);
    try {
      const events = listWorkerLifecycleEvents(db, { workspace, sessionId: 'session:1' });
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('private delegated task');
      expect(events[0]?.payload).toMatchObject({ promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), promptBytes: 22 });
      expect(events[1]?.payload).toMatchObject({ outcome: 'succeeded', handback: { text: 'bounded result' } });
      expect(JSON.stringify(events)).not.toContain('arbitrary');
    } finally {
      db.close();
    }
  });

  it('keeps complete bounded handback data in durability instead of applying UI truncation', async () => {
    const env = { OCTOCODE_HOME: path.join(os.tmpdir(), `octocode-worker-ledger-${crypto.randomUUID()}`) };
    const workspace = path.join(env.OCTOCODE_HOME, 'workspace');
    const ledger = new NativeAwarenessWorkerLedger({ workspace });
    const text = `start:${'x'.repeat(20_000)}:end`;
    await ledger.append({
      schemaVersion: 1,
      type: 'worker.terminal',
      packetId: packetId('packet:complete-handback'),
      workerId: workerId('worker:complete-handback'),
      correlationId: correlationId('correlation:complete-handback'),
      sessionId: sessionId('session:complete-handback'),
      authority: workerAuthorityFixture({ workerId: workerId('worker:complete-handback'), correlationId: correlationId('correlation:complete-handback'), sessionId: sessionId('session:complete-handback') }),
      redaction: 'sensitive',
      outcome: 'succeeded',
      handback: { text },
    });

    const dbPath = resolveDbPath(undefined, { workspace });
    const db = connectDb(dbPath);
    try {
      const [event] = listWorkerLifecycleEvents(db, {
        workspace,
        sessionId: 'session:complete-handback',
      });
      expect(event?.payload).toMatchObject({
        handback: { text, textTruncated: false },
      });
    } finally {
      db.close();
    }
  });
});
