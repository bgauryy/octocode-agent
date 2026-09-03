import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectStoreConvergence, insertMemory, openAwareness } from '../src/index.js';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('single-store convergence', () => {
  it('reports both memory modules inside one canonical database', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'store-convergence-'));
    roots.push(workspace);
    const store = openAwareness({ workspace, dbPath: join(workspace, 'awareness.sqlite3') });
    const db = new DatabaseSync(store.dbPath);
    try {
      store.storeVerifiedMemory({ label: 'verified', text: 'Use one store', sourceDigest: 'sha256:source' });
      store.storeMemory({ label: 'compatibility', text: 'compatibility row' });
      insertMemory(db, { taskContext: 'ledger', observation: 'full runtime row', importance: 5, workspacePath: workspace });
      const report = inspectStoreConvergence(db);
      expect(report.memories).toMatchObject({ total: 3, verifiedShape: 2, advancedShape: 1, secretScanPending: 1 });
    } finally { db.close(); store.close(); }
  });

});
