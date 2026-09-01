import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  revision,
  sessionEventId,
  sessionId,
  type SessionEvent,
  type SessionStore,
} from '@octocodeai/agent-core';

import {
  FilePiSessionSnapshotSource,
  importPiSession,
  selectPiSessionMigration,
  type PiSessionSnapshotSource,
} from '../src/native-pi-session-import.js';
import { runPiSessionMigration } from '../src/launcher.js';

const header = {
  type: 'session', version: 3, id: 'pi-session', timestamp: '2026-09-01T00:00:00.000Z', cwd: '/workspace',
};
const entry = (value: Record<string, unknown>) => ({
  timestamp: '2026-09-01T00:00:01.000Z',
  ...value,
});
const jsonl = (...values: readonly unknown[]): Uint8Array =>
  Buffer.from(`${values.map((value) => JSON.stringify(value)).join('\n')}\n`);

function source(...snapshots: readonly Uint8Array[]): PiSessionSnapshotSource {
  let index = 0;
  return {
    sourceId: 'fixture:pi-session',
    readSnapshot: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!),
  };
}

function recordingDestination(): {
  readonly store: SessionStore;
  readonly append: ReturnType<typeof vi.fn>;
  readonly inner: InMemorySessionStore;
} {
  const inner = new InMemorySessionStore();
  const append = vi.fn(inner.append.bind(inner));
  return { inner, append, store: { load: inner.load.bind(inner), append } };
}

describe('native Pi session import', () => {
  it('replays only the active Pi branch with tool calls and never imports thinking text', async () => {
    const bytes = jsonl(
      header,
      entry({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'fix it', timestamp: 1 } }),
      entry({ type: 'message', id: 'stale', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }], timestamp: 2 } }),
      entry({ type: 'message', id: 'a1', parentId: 'u1', message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain of thought' },
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'call-1', name: 'file', arguments: { path: 'a.ts' } },
        ],
        timestamp: 3,
      } }),
      entry({ type: 'message', id: 't1', parentId: 'a1', message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'file',
        content: [{ type: 'text', text: 'contents' }], isError: false, timestamp: 4,
      } }),
      entry({ type: 'message', id: 'a2', parentId: 't1', message: {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 5,
      } }),
    );
    const destination = recordingDestination();

    const receipt = await importPiSession({
      source: source(bytes, bytes), destination: destination.store, destinationId: sessionId('native-import'),
    });
    const loaded = await destination.inner.load(sessionId('native-import'));

    expect(receipt).toMatchObject({
      schemaVersion: 1, piSessionVersion: 3, destinationId: 'native-import', activeLeafId: 'a2',
    });
    expect(destination.append).toHaveBeenCalledOnce();
    expect(loaded.projection.modelContext.map(({ eventId: _, ...message }) => message)).toEqual([
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'call-1', name: 'file', input: { path: 'a.ts' } }] },
      { role: 'tool', content: 'contents', toolCallId: 'call-1' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(JSON.stringify(loaded)).not.toContain('private chain of thought');
    expect(JSON.stringify(loaded)).not.toContain('abandoned');
  });

  it('matches Pi compaction replay order and keeps the source file byte-identical', async () => {
    const bytes = jsonl(
      header,
      entry({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'old', timestamp: 1 } }),
      entry({ type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2 } }),
      entry({ type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'keep me', timestamp: 3 } }),
      entry({ type: 'compaction', id: 'c1', parentId: 'u2', summary: 'bounded summary', firstKeptEntryId: 'u2', tokensBefore: 100 }),
      entry({ type: 'message', id: 'a2', parentId: 'c1', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }], timestamp: 4 } }),
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-import-'));
    const sourceFile = path.join(root, 'pi.jsonl');
    fs.writeFileSync(sourceFile, bytes);
    const before = fs.readFileSync(sourceFile);
    const destination = new InMemorySessionStore();

    try {
      await importPiSession({
        source: new FilePiSessionSnapshotSource(sourceFile),
        destination,
        destinationId: sessionId('native-compacted'),
      });
      const loaded = await destination.load(sessionId('native-compacted'));
      expect(loaded.projection.modelContext.map(({ content, role }) => ({ role, content }))).toEqual([
        {
          role: 'user',
          content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nbounded summary\n</summary>',
        },
        { role: 'user', content: 'keep me' },
        { role: 'assistant', content: 'after' },
      ]);
      expect(fs.readFileSync(sourceFile)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed or changing sources before the single atomic destination append', async () => {
    const malformed = Buffer.from(`${JSON.stringify(header)}\n{"type":"message"\n`);
    const changed = jsonl(header, entry({ type: 'session_info', id: 'n1', parentId: null, name: 'changed' }));

    for (const candidate of [source(malformed, malformed), source(jsonl(header), changed)]) {
      const destination = recordingDestination();
      await expect(importPiSession({
        source: candidate, destination: destination.store, destinationId: sessionId('native-rejected'),
      })).rejects.toThrow(/malformed|changed/i);
      expect(destination.append).not.toHaveBeenCalled();
      expect((await destination.inner.load(sessionId('native-rejected'))).events).toEqual([]);
    }
  });

  it('rejects unsupported image replay and a non-empty destination without partial writes', async () => {
    const bytes = jsonl(
      header,
      entry({ type: 'message', id: 'u1', parentId: null, message: {
        role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], timestamp: 1,
      } }),
    );
    const destination = recordingDestination();
    await expect(importPiSession({
      source: source(bytes, bytes), destination: destination.store, destinationId: sessionId('native-image'),
    })).rejects.toThrow(/image|preserve/i);
    expect(destination.append).not.toHaveBeenCalled();

    const occupied = new InMemorySessionStore();
    const id = sessionId('occupied');
    const created: SessionEvent = {
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('existing'), revision: revision('1'),
      sequence: 1, timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    };
    await occupied.append(id, revision('0'), [created]);
    await expect(importPiSession({
      source: source(jsonl(header), jsonl(header)), destination: occupied, destinationId: id,
    })).rejects.toThrow(/empty|conflict/i);
    expect((await occupied.load(id)).events).toHaveLength(1);
  });
});

describe('release-owned Pi session migration selector', () => {
  it('selects a deterministic canary cohort without reading runtime settings', () => {
    const policy = {
      schemaVersion: 1 as const,
      revision: 'release-2026-09-01',
      mode: 'canary' as const,
      cohortPercent: 25,
      cohortSalt: 'frozen-secret-independent-salt',
    };
    const first = selectPiSessionMigration(policy, 'installation-a');
    expect(selectPiSessionMigration(policy, 'installation-a')).toEqual(first);
    expect(first.bucket).toBeGreaterThanOrEqual(0);
    expect(first.bucket).toBeLessThan(10_000);
    expect(first.selected).toBe(first.bucket < 2_500);
  });

  it('makes rollback and invalid release policy fail closed', () => {
    expect(selectPiSessionMigration({
      schemaVersion: 1, revision: 'release-1', mode: 'rollback', cohortPercent: 100, cohortSalt: 'salt',
    }, 'installation-a')).toMatchObject({ selected: false, reason: 'rollback' });
    expect(() => selectPiSessionMigration({
      schemaVersion: 1, revision: 'release-1', mode: 'canary', cohortPercent: 101, cohortSalt: 'salt',
    }, 'installation-a')).toThrow(/cohort/i);
  });

  it('keeps the CLI migration path source-blind when rollback is selected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-selector-'));
    const policyFile = path.join(root, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({
      schemaVersion: 1,
      revision: 'release-rollback',
      mode: 'rollback',
      cohortPercent: 100,
      cohortSalt: 'release-salt',
    }));
    const createClient = vi.fn(() => undefined);
    try {
      const result = await runPiSessionMigration([
        'import-pi',
        path.join(root, 'source-does-not-exist.jsonl'),
        'native-destination',
        '--policy',
        policyFile,
        '--installation-id',
        'install-a',
      ], {}, createClient);

      expect(result).toMatchObject({ decision: { selected: false, reason: 'rollback' } });
      expect(result).not.toHaveProperty('receipt');
      expect(createClient).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete CLI migration arguments before reading policy or source', async () => {
    await expect(runPiSessionMigration(['import-pi'], {}, vi.fn()))
      .rejects.toThrow(/Usage: octocode-agent sessions import-pi/u);
  });
});
