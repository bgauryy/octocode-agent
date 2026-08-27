import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMemoryRecall } from '../../src/memory-hardening.js';
import { openAwarenessStore } from '../../src/coordination/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('verified memory hardening', () => {
  it('requires provenance, filters expired entries, and explains recall', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'memory-hardening-'));
    roots.push(workspace);
    const aw = openAwarenessStore({ workspace, dbPath: join(workspace, 'awareness.sqlite3') });
    try {
      const active = aw.storeVerifiedMemory({ label: 'build', text: 'Run workspace verify', sourceDigest: 'sha256:docs', verifiedAt: '2026-08-26T00:00:00.000Z', validUntil: '2026-09-01T00:00:00.000Z', importance: 8 });
      aw.storeVerifiedMemory({ label: 'old', text: 'Old command', sourceDigest: 'sha256:old', verifiedAt: '2026-08-01T00:00:00.000Z', validUntil: '2026-08-20T00:00:00.000Z' });
      const recalled = aw.recallVerifiedMemory({ now: '2026-08-26T00:00:00.000Z' });
      expect(recalled.map((memory) => memory.memoryId)).toEqual([active.memoryId]);
      expect(recalled[0]?.explanation).toContain('source=sha256:docs');
    } finally { aw.close(); }
  });

  it('blocks secret-like content before persistence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'memory-secret-'));
    roots.push(workspace);
    const aw = openAwarenessStore({ workspace, dbPath: join(workspace, 'awareness.sqlite3') });
    try {
      expect(() => aw.storeVerifiedMemory({ label: 'credential', text: 'api_key=supersecretvalue', sourceDigest: 'sha256:x' })).toThrow(/secret-like/);
      expect(aw.recallVerifiedMemory()).toEqual([]);
    } finally { aw.close(); }
  });

  it('measures precision, recall, stale recall, and false-recall cost', () => {
    expect(evaluateMemoryRecall([{ expectedIds: ['a', 'b'], returnedIds: ['a', 'wrong', 'stale'], staleIds: ['stale'], falseRecallWeight: 2 }]))
      .toEqual({ version: 1, precision: 1 / 3, recall: 1 / 2, staleRecallRate: 1 / 3, falseRecallCost: 4 });
  });
});
