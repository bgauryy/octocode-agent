import type { DatabaseSync } from 'node:sqlite';

export const STORE_OWNERSHIP_V1 = Object.freeze({
  version: 1 as const,
  database: 'agent/agent.sqlite3',
  tables: {
    plans: { owner: 'coordination-plan-domain', adapters: ['coordination'] },
    awareness_plans: { owner: 'advanced-plan-domain', adapters: ['awareness-ledger'] },
    tasks: { owner: 'coordination-task-domain', adapters: ['coordination'] },
    awareness_tasks: { owner: 'advanced-task-domain', adapters: ['awareness-ledger'] },
    memories: { owner: 'verified-memory', adapters: ['lite-memory'] },
    awareness_memories: { owner: 'advanced-memory', adapters: ['awareness-memory'] },
    event_outbox: { owner: 'continuity-outbox', adapters: ['tui', 'rpc', 'hooks'] },
    pending_interactions: { owner: 'interaction-broker', adapters: ['tui', 'rpc'] },
    authorization_receipts: { owner: 'authorization-domain', adapters: ['plan-domain', 'effect-gate'] },
  },
});

export interface StoreConvergenceReportV1 {
  version: 1;
  plans: { total: number; coordinationShape: number; ledgerShape: number; incomplete: number };
  tasks: { total: number; coordinationShape: number; ledgerShape: number; incomplete: number };
  memories: { total: number; verifiedShape: number; advancedShape: number; secretScanPending: number };
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { count: number }).count);
const hasTable = (db: DatabaseSync, table: string): boolean => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND name = ?",
).get(table));
const countWhenPresent = (db: DatabaseSync, table: string, sql: string): number => hasTable(db, table) ? count(db, sql) : 0;

/** Read-only ownership report for the two memory table families in the unified store. */
export function inspectStoreConvergence(db: DatabaseSync): StoreConvergenceReportV1 {
  const coordinationPlans = countWhenPresent(db, 'plans', 'SELECT COUNT(*) AS count FROM plans');
  const advancedPlans = countWhenPresent(db, 'awareness_plans', 'SELECT COUNT(*) AS count FROM awareness_plans');
  const coordinationTasks = countWhenPresent(db, 'tasks', 'SELECT COUNT(*) AS count FROM tasks');
  const advancedTasks = countWhenPresent(db, 'awareness_tasks', 'SELECT COUNT(*) AS count FROM awareness_tasks');
  const verifiedMemories = countWhenPresent(db, 'memories', 'SELECT COUNT(*) AS count FROM memories');
  const advancedMemories = countWhenPresent(db, 'awareness_memories', 'SELECT COUNT(*) AS count FROM awareness_memories');
  return {
    version: 1,
    plans: {
      total: coordinationPlans + advancedPlans,
      coordinationShape: coordinationPlans,
      ledgerShape: advancedPlans,
      incomplete: 0,
    },
    tasks: {
      total: coordinationTasks + advancedTasks,
      coordinationShape: coordinationTasks,
      ledgerShape: advancedTasks,
      incomplete: 0,
    },
    memories: {
      total: verifiedMemories + advancedMemories,
      verifiedShape: verifiedMemories,
      advancedShape: advancedMemories,
      secretScanPending: hasTable(db, 'memories')
        ? count(db, "SELECT COUNT(*) AS count FROM memories WHERE secret_scan_status IS NULL OR secret_scan_status != 'passed'")
        : 0,
    },
  };
}
