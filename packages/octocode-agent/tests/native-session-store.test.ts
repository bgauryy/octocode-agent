import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransactionalSessionStore, importLegacySession, revision, sessionEventId, sessionId, type SessionEvent } from '@octocodeai/agent-core';

import { FileSessionRecordPort, JsonlLegacySessionSource } from '../src/native-session-store.js';

function storedRecord(id: string, revisionValue: string): string {
  const count = Number(revisionValue);
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: id,
    revision: revisionValue,
    events: Array.from({ length: count }, (_, index) => {
      const sequence = index + 1;
      return {
        schemaVersion: 1,
        sessionId: id,
        eventId: `${id}:${sequence}`,
        revision: String(sequence),
        sequence,
        timestamp: sequence,
        visibility: 'internal',
        event: sequence === 1
          ? { type: 'session.created' }
          : { type: 'custom.appended', kind: 'test.marker', value: sequence },
      };
    }),
  });
}

describe('native filesystem session store', () => {
  const event = (id: ReturnType<typeof sessionId>, sequence: number, visibility: SessionEvent['visibility'] = 'internal'): SessionEvent => ({
    schemaVersion: 1,
    sessionId: id,
    eventId: sessionEventId(`${id}:${sequence}`),
    revision: revision(String(sequence)),
    sequence,
    timestamp: sequence,
    visibility,
    event: sequence === 1 ? { type: 'session.created' } : { type: 'custom.appended', kind: 'test.marker', value: sequence },
  });

  it('commits atomically and rejects stale durable revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    fs.chmodSync(dir, 0o755);
    const id = sessionId('session-1');
    await port.commit(id, revision('0'), revision('1'), storedRecord(id, '1'));
    await expect(port.commit(id, revision('0'), revision('2'), storedRecord(id, '2'))).rejects.toThrow(/revision/i);
    expect((await port.read(id))?.recovered).toBe(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(port.pathFor(id)).mode & 0o777).toBe(0o600);
  });

  it('admits only one concurrent writer for the same durable revision', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    await port.commit(id, revision('0'), revision('1'), storedRecord(id, '1'));

    const results = await Promise.allSettled([
      port.commit(id, revision('1'), revision('2'), storedRecord(id, '2')),
      port.commit(id, revision('1'), revision('2'), storedRecord(id, '2')),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({ reason: { category: 'session-conflict' } });
  });

  it('fails closed without changing the primary when a session lock already exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    const first = storedRecord(id, '1');
    await port.commit(id, revision('0'), revision('1'), first);
    fs.writeFileSync(port.lockPathFor(id), 'held', { mode: 0o600 });

    await expect(port.commit(id, revision('1'), revision('2'), storedRecord(id, '2'))).rejects.toMatchObject({ category: 'session-conflict' });
    expect(fs.readFileSync(port.pathFor(id), 'utf8')).toBe(first);
  });

  it('reclaims only a dead process lock and never removes an unowned live lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-lock-recovery');
    await port.commit(id, revision('0'), revision('1'), storedRecord(id, '1'));
    fs.writeFileSync(port.lockPathFor(id), JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, token: 'dead-owner', createdAt: 1 }), { mode: 0o600 });

    await expect(port.commit(id, revision('1'), revision('2'), storedRecord(id, '2'))).resolves.toBeUndefined();

    fs.writeFileSync(port.lockPathFor(id), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'live-owner', createdAt: Date.now() }), { mode: 0o600 });
    await expect(port.commit(id, revision('2'), revision('3'), storedRecord(id, '3'))).rejects.toMatchObject({ category: 'session-conflict' });
    expect(JSON.parse(fs.readFileSync(port.lockPathFor(id), 'utf8')).token).toBe('live-owner');
  });

  it('appends atomic segments and checkpoints with bounded diagnostic retention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir, { checkpointEvery: 2, maxDiagnostics: 1 });
    const store = new TransactionalSessionStore(port);
    const id = sessionId('session-checkpoint');
    await store.append(id, revision('0'), [event(id, 1)]);
    await store.append(id, revision('1'), [event(id, 2, 'diagnostics')]);
    await store.append(id, revision('2'), [event(id, 3, 'diagnostics')]);
    await store.append(id, revision('3'), [event(id, 4, 'diagnostics')]);
    await store.append(id, revision('4'), [event(id, 5)]);

    expect(JSON.parse(fs.readFileSync(port.pathFor(id), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      revision: '5',
      retention: { omittedDiagnostics: 2, maxDiagnostics: 1 },
    });
    const loaded = await store.load(id);
    expect(loaded.projection.revision).toBe(revision('5'));
    expect(loaded.events.filter(({ visibility }) => visibility === 'diagnostics')).toHaveLength(1);
  });

  it('recovers when a crash leaves an already-applied segment beside its checkpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir, { checkpointEvery: 2 });
    const store = new TransactionalSessionStore(port);
    const id = sessionId('session-checkpoint-crash');
    await store.append(id, revision('0'), [event(id, 1)]);
    await store.append(id, revision('1'), [event(id, 2)]);
    await store.append(id, revision('2'), [event(id, 3)]);

    fs.mkdirSync(port.segmentDirectoryFor(id), { recursive: true });
    fs.writeFileSync(path.join(port.segmentDirectoryFor(id), '0000000000000002-0000000000000002.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      expectedRevision: revision('1'),
      nextRevision: revision('2'),
      events: [event(id, 2)],
    }));

    const recovered = await new TransactionalSessionStore(port).load(id);
    expect(recovered.projection.revision).toBe(revision('3'));
    expect(recovered.events).toHaveLength(3);
  });

  it('recovers a valid backup after primary corruption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    const first = storedRecord(id, '1');
    await port.commit(id, revision('0'), revision('1'), first);
    await port.commit(id, revision('1'), revision('2'), storedRecord(id, '2'));
    fs.writeFileSync(port.pathFor(id), '{corrupt');
    const recovered = await port.read(id);
    expect(recovered).toEqual({ content: first, recovered: true });
  });

  it('recovers a valid backup when the primary is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    const first = storedRecord(id, '1');
    await port.commit(id, revision('0'), revision('1'), first);
    await port.commit(id, revision('1'), revision('2'), storedRecord(id, '2'));
    fs.unlinkSync(port.pathFor(id));

    const recovered = await port.read(id);

    expect(recovered).toEqual({ content: first, recovered: true });
    expect(fs.readFileSync(port.pathFor(id), 'utf8')).toBe(first);
  });

  it('does not promote a backup with an invalid event union', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-'));
    const port = new FileSessionRecordPort(dir);
    const id = sessionId('session-1');
    const corruptPrimary = '{corrupt';
    const invalidBackup = JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      revision: '1',
      events: [{
        schemaVersion: 1,
        sessionId: id,
        eventId: 'bad:1',
        revision: '1',
        sequence: 1,
        timestamp: 1,
        visibility: 'internal',
        event: { type: 'future.event' },
      }],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(port.pathFor(id), corruptPrimary);
    fs.writeFileSync(port.backupPathFor(id), invalidBackup);

    await expect(port.read(id)).rejects.toThrow(/session record/i);
    expect(fs.readFileSync(port.pathFor(id), 'utf8')).toBe(corruptPrimary);
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
