import type { DatabaseSync } from 'node:sqlite';

export const STORE_OWNERSHIP_V1 = Object.freeze({
  version: 1 as const,
  database: 'octocode.sqlite3',
  tables: {
    plans: { owner: 'plan-domain', adapters: ['coordination', 'awareness-ledger'] },
    tasks: { owner: 'plan-domain', adapters: ['coordination', 'awareness-ledger'] },
    memories: { owner: 'verified-memory', adapters: ['lite-memory', 'awareness-memory'] },
    event_outbox: { owner: 'continuity-outbox', adapters: ['tui', 'rpc', 'hooks'] },
    pending_interactions: { owner: 'interaction-broker', adapters: ['tui', 'rpc'] },
    authorization_receipts: { owner: 'authorization-domain', adapters: ['plan-domain', 'effect-gate'] },
  },
});

export interface StoreConvergenceReportV1 {
  version: 1;
  plans: { total: number; coordinationShape: number; ledgerShape: number; incomplete: number };
  tasks: { total: number; coordinationShape: number; ledgerShape: number; incomplete: number };
  memories: { total: number; verifiedShape: number; legacyShape: number; secretScanPending: number };
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { count: number }).count);

/** Read-only comparison report used during migration/cutover audits. New writes
 * already target the unified tables; this makes residual legacy-shaped rows
 * measurable instead of silently maintaining a second source of truth. */
export function inspectStoreConvergence(db: DatabaseSync): StoreConvergenceReportV1 {
  return {
    version: 1,
    plans: {
      total: count(db, 'SELECT COUNT(*) AS count FROM plans'),
      coordinationShape: count(db, 'SELECT COUNT(*) AS count FROM plans WHERE title IS NOT NULL'),
      ledgerShape: count(db, 'SELECT COUNT(*) AS count FROM plans WHERE name IS NOT NULL'),
      incomplete: count(db, 'SELECT COUNT(*) AS count FROM plans WHERE title IS NULL AND name IS NULL'),
    },
    tasks: {
      total: count(db, 'SELECT COUNT(*) AS count FROM tasks'),
      coordinationShape: count(db, 'SELECT COUNT(*) AS count FROM tasks WHERE paths_json IS NOT NULL'),
      ledgerShape: count(db, 'SELECT COUNT(*) AS count FROM tasks WHERE acceptance_criteria IS NOT NULL OR created_by IS NOT NULL'),
      incomplete: count(db, 'SELECT COUNT(*) AS count FROM tasks WHERE title IS NULL'),
    },
    memories: {
      total: count(db, 'SELECT COUNT(*) AS count FROM memories'),
      verifiedShape: count(db, 'SELECT COUNT(*) AS count FROM memories WHERE verified_at IS NOT NULL AND source_digest IS NOT NULL'),
      legacyShape: count(db, 'SELECT COUNT(*) AS count FROM memories WHERE verified_at IS NULL OR source_digest IS NULL'),
      secretScanPending: count(db, "SELECT COUNT(*) AS count FROM memories WHERE secret_scan_status IS NULL OR secret_scan_status != 'passed'"),
    },
  };
}
