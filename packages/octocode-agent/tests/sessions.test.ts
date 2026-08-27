import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listProjectSessions, listSessions, nativeSessionsDir } from '../src/sessions.js';

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

function writeSession(root: string, id: string, cwd: string, timestamp: number): string {
  const file = path.join(root, `${encodeURIComponent(id)}.json`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    sessionId: id,
    revision: '2',
    events: [
      { schemaVersion: 1, sessionId: id, eventId: `${id}:1`, revision: '1', sequence: 1, timestamp, visibility: 'internal', event: { type: 'session.created' } },
      { schemaVersion: 1, sessionId: id, eventId: `${id}:2`, revision: '2', sequence: 2, timestamp, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.cwd', value: cwd } },
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

  it('skips corrupt and mismatched records', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'corrupt.json'), '{bad json');
    fs.writeFileSync(path.join(root, 'wrong.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'different', revision: '0', events: [] }));
    expect(listSessions(root)).toEqual([]);
  });
});
