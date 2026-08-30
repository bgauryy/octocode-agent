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
      capabilities: { tools: ['localSearchCode'], models: [{ providerId: 'openai', modelId: 'gpt-5' }], maxTurns: 4 },
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
});
