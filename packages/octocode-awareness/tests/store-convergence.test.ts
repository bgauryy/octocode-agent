import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectStoreConvergence, insertMemory, listPlans as listLedgerPlans, openAwareness } from '../src/index.js';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('single-store convergence', () => {
  it('supports verified and compatibility memory adapters on one canonical table', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'store-convergence-'));
    roots.push(workspace);
    const store = openAwareness({ workspace, dbPath: join(workspace, 'octocode.sqlite3') });
    const db = new DatabaseSync(store.dbPath);
    try {
      store.storeVerifiedMemory({ label: 'verified', text: 'Use one store', sourceDigest: 'sha256:source' });
      store.storeMemory({ label: 'compatibility', text: 'compatibility row' });
      insertMemory(db, { taskContext: 'ledger', observation: 'full runtime row', importance: 5, workspacePath: workspace });
      const report = inspectStoreConvergence(db);
      expect(report.memories).toMatchObject({ total: 3, verifiedShape: 1, legacyShape: 2, secretScanPending: 2 });
    } finally { db.close(); store.close(); }
  });

  it('migrates a legacy full-runtime store and isolates full and coordination plan readers', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'store-legacy-full-'));
    roots.push(workspace);
    const dbPath = join(workspace, 'octocode.sqlite3');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE plans (
        plan_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        lead_agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED')),
        workspace_path TEXT NOT NULL,
        artifact TEXT,
        doc_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN','IN_PROGRESS','BLOCKED','VERIFY','DONE','FAILED','CANCELLED')),
        priority INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO plans VALUES ('ledger-plan', 'Ledger', 'Keep adapters isolated', 'agent', 'ACTIVE', '${workspace.replaceAll("'", "''")}', NULL, '.octocode/plan/ledger', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z');
      INSERT INTO tasks VALUES ('ledger-task', 'ledger-plan', 'Ledger task', 'reason', 'acceptance', 'OPEN', 0, 'agent', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const store = openAwareness({ workspace, dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(store.listPlans()).toEqual([]);
      const coordinationPlan = store.createPlan({ title: 'Coordination' });
      expect(store.listPlans().map((plan) => plan.planId)).toEqual([coordinationPlan.planId]);
      expect(listLedgerPlans(db).map((plan) => plan.plan_id)).toEqual(['ledger-plan']);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); store.close(); }
  });
});
