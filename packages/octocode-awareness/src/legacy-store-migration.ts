import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentDbPath } from '@octocodeai/octocode-shared/paths';
import { AGENT_APPLICATION_ID, initOctocodeSchema } from '@octocodeai/octocode-shared/schema';
import { DatabaseSync } from '@octocodeai/octocode-shared/sqlite';
import { openAwarenessStore } from './coordination/open.js';
import { AWARENESS_COORDINATION_RELATIONS, canonicalColumns, normalizeSchemaSql } from './db-introspection.js';
import { rebuildFts } from './db-maintenance.js';
import { AWARENESS_APPLICATION_ID, globalAwarenessDatabasePath } from './storage-scope.js';
import { appendWorkerLifecycleEvent } from './worker-lifecycle-ledger.js';

type SqlValue = null | number | bigint | string | Uint8Array;

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

export interface LegacyStoreMigrationOptions {
  sourcePath?: string;
  targetPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LegacyStoreMigrationReceipt {
  ok: true;
  migrated: true;
  source_path: string;
  target_path: string;
  source_application_id: number;
  target_application_id: number;
  table_count: number;
  total_rows: number;
  row_counts: Record<string, number>;
  integrity_check: 'ok';
  foreign_key_violations: 0;
  source_unchanged: true;
}

const FTS_TABLE_PATTERN = /^memories_fts(?:_.+)?$/;
const OPTIONAL_AWARENESS_TABLES = new Set(['worker_lifecycle_events']);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function applicationId(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id);
}

function userTables(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
}

function tableShape(db: DatabaseSync, table: string): ColumnShape[] {
  return db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all() as unknown as ColumnShape[];
}

function tableSql(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
  if (!row?.sql) throw new Error(`source relation ${table} has no table DDL`);
  return normalizeSchemaSql(row.sql);
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number | bigint };
  return Number(row.count);
}

function dataVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
}

function removeMigrationFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      rmSync(candidate, { force: true });
    } catch {
      // Preserve the original migration failure; a future run uses a fresh unique path.
    }
  }
}

function agentTables(): Set<string> {
  const db = new DatabaseSync(':memory:');
  try {
    initOctocodeSchema(db);
    return new Set(userTables(db));
  } finally {
    db.close();
  }
}

function requiredAwarenessTables(): Set<string> {
  return new Set([
    ...canonicalColumns().keys(),
    ...[...AWARENESS_COORDINATION_RELATIONS].filter((name) => !OPTIONAL_AWARENESS_TABLES.has(name)),
  ]);
}

function assertSourceContract(source: DatabaseSync): { awarenessTables: string[] } {
  const sourceId = applicationId(source);
  if (sourceId !== AGENT_APPLICATION_ID) {
    throw new Error(`legacy source application_id ${sourceId} is not the Agent mixed-store identity ${AGENT_APPLICATION_ID}`);
  }
  const tables = userTables(source);
  const tableSet = new Set(tables);
  const requiredAgent = agentTables();
  const requiredAwareness = requiredAwarenessTables();
  const allowed = new Set([...requiredAgent, ...requiredAwareness, ...OPTIONAL_AWARENESS_TABLES]);
  const unknown = tables.filter((name) => !allowed.has(name) && !FTS_TABLE_PATTERN.test(name));
  if (unknown.length > 0) throw new Error(`unrecognized source relation(s): ${unknown.join(', ')}`);
  const missingAgent = [...requiredAgent].filter((name) => !tableSet.has(name));
  const missingAwareness = [...requiredAwareness].filter((name) => !tableSet.has(name));
  if (missingAgent.length > 0 || missingAwareness.length > 0) {
    throw new Error(`legacy mixed source schema is incomplete (missing: ${[...missingAgent, ...missingAwareness].join(', ')})`);
  }
  const triggersOrViews = source.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
  if (triggersOrViews.length > 0) {
    throw new Error(`unrecognized source schema object(s): ${triggersOrViews.map(({ type, name }) => `${type}:${name}`).join(', ')}`);
  }
  const integrity = source.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`legacy source integrity_check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`);
  }
  const foreignKeys = source.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) throw new Error(`legacy source foreign_key_check failed with ${foreignKeys.length} row(s)`);
  return {
    awarenessTables: [...requiredAwareness, ...[...OPTIONAL_AWARENESS_TABLES].filter((name) => tableSet.has(name))].sort(),
  };
}

function assertEmptyTarget(path: string): void {
  if (!existsSync(path)) return;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw new Error(`migration target is nonempty or not a readable SQLite database: ${path}`);
  }
  try {
    throw new Error(`migration target already exists; refusing to overwrite or merge: ${path}`);
  } finally {
    db.close();
  }
}

function ensureOptionalTargetTables(target: DatabaseSync, awarenessTables: string[]): void {
  if (!awarenessTables.includes('worker_lifecycle_events')) return;
  appendWorkerLifecycleEvent(target, {
    packetId: '__migration_schema_probe__',
    workspace: '/',
    sessionId: '__migration__',
    workerId: '__migration__',
    correlationId: '__migration__',
    type: 'migration.schema-probe',
    redaction: 'internal',
    createdAt: '1970-01-01T00:00:00.000Z',
    payload: {},
  });
  target.prepare('DELETE FROM worker_lifecycle_events WHERE packet_id = ?').run('__migration_schema_probe__');
}

function assertMatchingTableSchemas(source: DatabaseSync, target: DatabaseSync, tables: string[]): void {
  for (const table of tables) {
    if (JSON.stringify(tableShape(source, table)) !== JSON.stringify(tableShape(target, table))) {
      throw new Error(`legacy source schema mismatch for Awareness relation ${table}`);
    }
    if (tableSql(source, table) !== tableSql(target, table)) {
      throw new Error(`legacy source DDL mismatch for Awareness relation ${table}`);
    }
  }
}

function copyTable(source: DatabaseSync, target: DatabaseSync, table: string): number {
  const columns = tableShape(source, table).filter(({ hidden }) => hidden === 0).map(({ name }) => name);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const select = source.prepare(`SELECT ${quotedColumns} FROM ${quoteIdentifier(table)}`);
  select.setReadBigInts(true);
  const insert = target.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  let copied = 0;
  for (const row of select.iterate() as Iterable<Record<string, SqlValue>>) {
    insert.run(...columns.map((column) => row[column] ?? null));
    copied += 1;
  }
  return copied;
}

export function migrateLegacyMixedAwarenessStore(
  options: LegacyStoreMigrationOptions = {},
): LegacyStoreMigrationReceipt {
  const env = options.env ?? process.env;
  const sourcePath = resolve(options.sourcePath ?? agentDbPath(env));
  const targetPath = resolve(options.targetPath ?? globalAwarenessDatabasePath(env));
  if (sourcePath === targetPath) throw new Error('legacy source and Awareness target must be different files');
  if (!existsSync(sourcePath)) throw new Error(`legacy source does not exist: ${sourcePath}`);

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const temporaryTargetPath = `${targetPath}.migration-${process.pid}-${randomUUID()}`;
  let target: DatabaseSync | undefined;
  let sourceTransaction = false;
  let published = false;
  try {
    source.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON');
    const sourceVersion = dataVersion(source);
    source.exec('BEGIN');
    sourceTransaction = true;
    const { awarenessTables } = assertSourceContract(source);
    assertEmptyTarget(targetPath);

    const targetStore = openAwarenessStore({ workspace: process.cwd(), dbPath: temporaryTargetPath });
    targetStore.close();
    target = new DatabaseSync(temporaryTargetPath);
    target.exec('PRAGMA foreign_keys = ON');
    ensureOptionalTargetTables(target, awarenessTables);
    assertMatchingTableSchemas(source, target, awarenessTables);
    const targetRows = awarenessTables.reduce((sum, table) => sum + countRows(target!, table), 0);
    if (targetRows !== 0) throw new Error(`migration target is nonempty; refusing to overwrite or merge: ${targetPath}`);

    const rowCounts: Record<string, number> = {};
    let began = false;
    try {
      target.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
      began = true;
      for (const table of awarenessTables) rowCounts[table] = copyTable(source, target, table);
      if (userTables(target).includes('memories_fts')) rebuildFts(target);
      for (const table of awarenessTables) {
        const targetCount = countRows(target, table);
        const sourceCount = countRows(source, table);
        if (targetCount !== sourceCount || targetCount !== rowCounts[table]) {
          throw new Error(`row-count verification failed for ${table}: source=${sourceCount}, target=${targetCount}`);
        }
      }
      const foreignKeys = target.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeys.length > 0) throw new Error(`target foreign_key_check failed with ${foreignKeys.length} row(s)`);
      const integrity = target.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`target integrity_check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`);
      }
      target.exec('COMMIT');
      began = false;
    } catch (error) {
      if (began) {
        try { target.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      }
      throw error;
    } finally {
      target.exec('PRAGMA foreign_keys = ON');
    }

    source.exec('COMMIT');
    sourceTransaction = false;
    if (dataVersion(source) !== sourceVersion) {
      throw new Error('legacy source changed during migration; stop all writers and retry');
    }

    // Consolidate the temporary database before its atomic same-directory publish.
    target.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE');
    target.close();
    target = undefined;
    // A same-directory hard-link publish is atomic and fails if another process
    // creates the destination after the initial target check.
    linkSync(temporaryTargetPath, targetPath);
    published = true;
    removeMigrationFiles(temporaryTargetPath);
    return {
      ok: true,
      migrated: true,
      source_path: sourcePath,
      target_path: targetPath,
      source_application_id: AGENT_APPLICATION_ID,
      target_application_id: AWARENESS_APPLICATION_ID,
      table_count: awarenessTables.length,
      total_rows: Object.values(rowCounts).reduce((sum, count) => sum + count, 0),
      row_counts: rowCounts,
      integrity_check: 'ok',
      foreign_key_violations: 0,
      source_unchanged: true,
    };
  } finally {
    if (sourceTransaction) {
      try { source.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
    }
    target?.close();
    source.close();
    if (!published) removeMigrationFiles(temporaryTargetPath);
  }
}
