import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listProjectSessions, listSessions, nativeSessionsDir, resolveSessionNavigation } from '../src/sessions.js';

const temporaryDirectories: string[] = [];
function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-sessions-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function writeSession(root: string, id: string, cwd: string, timestamp: number, parentSessionId?: string): string {
  const file = path.join(root, `${encodeURIComponent(id)}.json`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    sessionId: id,
    revision: parentSessionId === undefined ? '2' : '3',
    events: [
      { schemaVersion: 1, sessionId: id, eventId: `${id}:1`, revision: '1', sequence: 1, timestamp, visibility: 'internal', event: { type: 'session.created' } },
      { schemaVersion: 1, sessionId: id, eventId: `${id}:2`, revision: '2', sequence: 2, timestamp, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.cwd', value: cwd } },
      ...(parentSessionId === undefined ? [] : [
        { schemaVersion: 1, sessionId: id, eventId: `${id}:3`, revision: '3', sequence: 3, timestamp, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.parent', value: parentSessionId } },
      ]),
    ],
  }));
  fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
  return file;
}

describe('native session inventory', () => {
  it('uses the canonical agent sessions directory', () => {
    expect(nativeSessionsDir({ OCTOCODE_HOME: '/tmp/octocode-home' })).toBe('/tmp/octocode-home/agent/sessions');
  });

  it('lists native transactional records newest-first and filters by cwd', () => {
    const root = temporaryRoot();
    writeSession(root, 'native:older', '/workspace/a', 1_000);
    writeSession(root, 'native:newer', '/workspace/a', 2_000);
    writeSession(root, 'native:other', '/workspace/b', 3_000);

    expect(listSessions(root).map((session) => session.uuid)).toEqual(['native:other', 'native:newer', 'native:older']);
    expect(listProjectSessions('/workspace/a', root).map((session) => session.uuid)).toEqual(['native:newer', 'native:older']);
  });

  it('resolves durable parent and newest-child navigation within the current workspace', () => {
    const root = temporaryRoot();
    writeSession(root, 'parent', '/workspace/a', 1_000);
    writeSession(root, 'older-child', '/workspace/a', 2_000, 'parent');
    writeSession(root, 'newer-child', '/workspace/a', 3_000, 'parent');
    writeSession(root, 'foreign-child', '/workspace/b', 4_000, 'parent');

    expect(resolveSessionNavigation('newer-child', 'parent', '/workspace/a', root)).toBe('parent');
    expect(resolveSessionNavigation('parent', 'child', '/workspace/a', root)).toBe('newer-child');
    expect(resolveSessionNavigation('parent', 'child', '/workspace/b', root)).toBeNull();
    expect(resolveSessionNavigation('parent', 'parent', '/workspace/a', root)).toBeNull();
  });

  it('skips corrupt and mismatched records', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'corrupt.json'), '{bad json');
    fs.writeFileSync(path.join(root, 'wrong.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'different', revision: '0', events: [] }));
    const invalidEventFile = writeSession(root, 'invalid-event', '/workspace/a', 1_000);
    const invalidRecord = JSON.parse(fs.readFileSync(invalidEventFile, 'utf8')) as { events: Array<{ event: { type: string } }> };
    invalidRecord.events[1]!.event.type = 'future.event';
    fs.writeFileSync(invalidEventFile, JSON.stringify(invalidRecord));
    expect(listSessions(root)).toEqual([]);
  });
});
