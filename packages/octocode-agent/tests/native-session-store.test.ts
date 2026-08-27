import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransactionalSessionStore, importLegacySession, revision, sessionId } from '@octocodeai/agent-core';

import { FileSessionRecordPort, JsonlLegacySessionSource } from '../src/native-session-store.js';

describe('native filesystem session store', () => {
  it('commits atomically and rejects stale durable revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    await port.commit(id, revision('0'), revision('1'), JSON.stringify({ schemaVersion: 1, sessionId: id, revision: revision('1'), events: [] }));
    await expect(port.commit(id, revision('0'), revision('2'), JSON.stringify({ schemaVersion: 1, sessionId: id, revision: revision('2'), events: [] }))).rejects.toThrow(/revision/i);
    expect((await port.read(id))?.recovered).toBe(false);
  });

  it('recovers a valid backup after primary corruption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    const first = JSON.stringify({ schemaVersion: 1, sessionId: id, revision: revision('1'), events: [] });
    await port.commit(id, revision('0'), revision('1'), first);
    await port.commit(id, revision('1'), revision('2'), JSON.stringify({ schemaVersion: 1, sessionId: id, revision: revision('2'), events: [] }));
    fs.writeFileSync(port.pathFor(id), '{corrupt');
    const recovered = await port.read(id);
    expect(recovered).toEqual({ content: first, recovered: true });
  });

  it('imports a legacy JSONL source without changing its bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    fs.writeFileSync(sourceFile, '{"type":"session","name":"old"}\n{"type":"message","role":"user","content":"hello"}\n');
    const before = fs.readFileSync(sourceFile);
    const destination = new TransactionalSessionStore(new FileSessionRecordPort(path.join(dir, 'native')));
    const receipt = await importLegacySession(new JsonlLegacySessionSource(sourceFile), destination, sessionId('imported'));
    expect(receipt.imported).toBe(2);
    expect(fs.readFileSync(sourceFile)).toEqual(before);
  });
});
