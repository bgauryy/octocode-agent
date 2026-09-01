import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { correlationId, packetId, sessionId, workerId, type WorkerSpawnPacket, type WorkerTerminalPacket } from '@octocodeai/agent-core';
import { closeOctocodeDb, listWorkerLifecycleEvents, agentDbPath, openOctocodeDb } from '@octocodeai/octocode-awareness/mcp-state';
import { NativeAwarenessWorkerLedger } from '../src/native-worker-ledger.js';

describe('native Awareness worker ledger adapter', () => {
  it('persists correlated lifecycle and redacts raw prompts while retaining bounded handback', async () => {
    const env = { OCTOCODE_HOME: path.join(os.tmpdir(), `octocode-worker-ledger-${crypto.randomUUID()}`) };
    const ledger = new NativeAwarenessWorkerLedger({ workspace: '/workspace', env, now: () => 1_700_000_000_000 });
    const spawn: WorkerSpawnPacket = {
      schemaVersion: 1, type: 'worker.spawn', packetId: packetId('packet:spawn'), workerId: workerId('worker:1'),
      correlationId: correlationId('correlation:1'), sessionId: sessionId('session:1'), redaction: 'sensitive',
      prompt: 'private delegated task', promptSnapshotId: 'a'.repeat(64), workspace: { mode: 'shared' },
      capabilities: { tools: ['localSearch'], models: [{ providerId: 'openai', modelId: 'gpt-5' }], maxTurns: 4 },
    };
    const terminal: WorkerTerminalPacket = {
      schemaVersion: 1, type: 'worker.terminal', packetId: packetId('packet:terminal'), workerId: spawn.workerId,
      correlationId: spawn.correlationId, sessionId: spawn.sessionId, redaction: 'sensitive', outcome: 'succeeded',
      handback: { text: 'bounded result', ignored: { arbitrary: true } },
    };
    await ledger.append(spawn);
    await ledger.append(terminal);

    const dbPath = agentDbPath(env);
    const db = openOctocodeDb(dbPath);
    try {
      const events = listWorkerLifecycleEvents(db, { workspace: '/workspace', sessionId: 'session:1' });
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('private delegated task');
      expect(events[0]?.payload).toMatchObject({ promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), promptBytes: 22 });
      expect(events[1]?.payload).toMatchObject({ outcome: 'succeeded', handback: { text: 'bounded result' } });
      expect(JSON.stringify(events)).not.toContain('arbitrary');
    } finally {
      closeOctocodeDb(dbPath);
    }
  });

  it('keeps complete bounded handback data in durability instead of applying UI truncation', async () => {
    const env = { OCTOCODE_HOME: path.join(os.tmpdir(), `octocode-worker-ledger-${crypto.randomUUID()}`) };
    const ledger = new NativeAwarenessWorkerLedger({ workspace: '/workspace', env });
    const text = `start:${'x'.repeat(20_000)}:end`;
    await ledger.append({
      schemaVersion: 1,
      type: 'worker.terminal',
      packetId: packetId('packet:complete-handback'),
      workerId: workerId('worker:complete-handback'),
      correlationId: correlationId('correlation:complete-handback'),
      sessionId: sessionId('session:complete-handback'),
      redaction: 'sensitive',
      outcome: 'succeeded',
      handback: { text },
    });

    const dbPath = agentDbPath(env);
    const db = openOctocodeDb(dbPath);
    try {
      const [event] = listWorkerLifecycleEvents(db, {
        workspace: '/workspace',
        sessionId: 'session:complete-handback',
      });
      expect(event?.payload).toMatchObject({
        handback: { text, textTruncated: false },
      });
    } finally {
      closeOctocodeDb(dbPath);
    }
  });
});
