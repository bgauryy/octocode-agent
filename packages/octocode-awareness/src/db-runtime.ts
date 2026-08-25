/**
 * db.ts — SQLite connection, schema init, and utility helpers.
 * Requires Node >=22.13.0 (unflagged node:sqlite built-in).
 *
 * Clean schema scope:
 *   workspace_path is the primary isolation key.
 *   artifact is the optional workspace-local package/service/component slice.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { getOctocodeHome } from '@octocodeai/octocode-shared/paths';
import { utcNow } from './helpers.js';
import { journalModeForSqliteVersion } from './sqlite-runtime.js';
import {
  assertCanonicalRelationContract,
  assertCanonicalSchemaFingerprint,
  isExactPriorHookReceiptSchema,
  isExactPriorLifecycleConstraintSchema,
} from './db-introspection.js';
import { initializeDb } from './db-init.js';

// The low-level `node:sqlite` runtime — warning-filtered `DatabaseSync`, the
// bounded BUSY retry, and the WAL checkpoint — is shared with Awareness Lite.
// Re-exported here so every existing `./db-runtime.js` / `./db.js` importer and
// test keeps its symbols. The shared module has no npm runtime deps.
export {
  DatabaseSync,
  SQLITE_BUSY_RETRY_MS,
  SQLITE_BUSY_DEADLINE_MS,
  SQLITE_WAIT,
  previousWarningListeners,
  sqliteWarningFilter,
  isSqliteBusy,
  withSqliteBusyRetry,
  checkpointWal,
} from '@octocodeai/octocode-shared/sqlite';
import {
  DatabaseSync,
  SQLITE_BUSY_DEADLINE_MS,
  withSqliteBusyRetry,
} from '@octocodeai/octocode-shared/sqlite';

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_DB_NAME = 'awareness.sqlite3';
export const MEMORY_HOME_ENV = 'OCTOCODE_MEMORY_HOME';
/** ASCII "OCT1". Canonical Awareness has one executable schema contract. */
export const AWARENESS_APPLICATION_ID = 0x4f435431;

// ─── Module-level singleton ───────────────────────────────────────────────────

export let _db: DatabaseSync | undefined;
export const _dbCache = new Map<string, DatabaseSync>();

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Resolve the memory home directory from env or platform defaults. */
export function memoryHome(): string {
  // Explicit override wins (used by tests and split-store deployments).
  const configured = process.env[MEMORY_HOME_ENV];
  if (configured?.trim()) return resolve(configured.trim());
  // Otherwise home resolution flows through @octocodeai/config — never
  // reimplemented here: OCTOCODE_AGENT_DIR › OCTOCODE_HOME › platform default
  // (~/.octocode). The Awareness store lives under it, in `memory/`.
  return join(getOctocodeHome(), 'memory');
}

/** Resolve a DB path from an override arg or the default location. */
export function resolveDbPath(dbArg?: string | null): string {
  if (dbArg) return resolve(dbArg);
  return join(memoryHome(), DEFAULT_DB_NAME);
}

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database, initialise the schema, and cache the
 * connection in the module-level singleton so getDb() works after the call.
 */
export function connectDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    // busy_timeout is connection-local and must precede the identity reads: in
    // rollback-journal mode, a concurrent writer may otherwise make this
    // read-only guard fail immediately with SQLITE_BUSY.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_DEADLINE_MS}`);
    // Fail closed before journal mode, foreign-key state, or DDL can touch a
    // foreign store. Canonical OCT1 stores take a strict read-only fast path.
    const schemaState = inspectSchemaState(db);
    const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const journalMode = journalModeForSqliteVersion(versionRow.version);
    // Unsafe embedded SQLite versions use rollback journaling instead of the
    // documented concurrent-WAL path. Changing mode is a write and may race a
    // first opener, so both modes use the same bounded BUSY retry.
    withSqliteBusyRetry(() => db.exec(`PRAGMA journal_mode = ${journalMode}`));
    db.exec('PRAGMA foreign_keys = ON');
    initializeDb(db, schemaState);
    _db = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface SchemaIdentity {
  applicationId: number;
  relations: Array<{ name: string; type: string }>;
}

export type SchemaState = 'fresh' | 'canonical' | 'prior-hook-receipts' | 'prior-lifecycle-constraints';

export function readSchemaIdentity(db: DatabaseSync): SchemaIdentity {
  const application = db.prepare('PRAGMA application_id').get() as { application_id: number };
  const relations = db.prepare(`
    SELECT name, type
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB 'memories_fts_*'
      AND name NOT GLOB 'memory_fts_*'
    ORDER BY name
  `).all() as Array<{ name: string; type: string }>;
  return {
    applicationId: application.application_id ?? 0,
    relations,
  };
}

export function inspectSchemaState(db: DatabaseSync): SchemaState {
  const identity = readSchemaIdentity(db);
  if (identity.applicationId === AWARENESS_APPLICATION_ID) {
    if (isExactPriorHookReceiptSchema(db, identity.relations)) return 'prior-hook-receipts';
    if (isExactPriorLifecycleConstraintSchema(db, identity.relations)) return 'prior-lifecycle-constraints';
    assertCanonicalRelationContract(db, identity.relations);
    assertCanonicalSchemaFingerprint(db);
    return 'canonical';
  }
  if (identity.applicationId !== 0) {
    throw new Error(
      `refusing foreign Awareness application_id ${identity.applicationId}; expected ${AWARENESS_APPLICATION_ID}. Another app owns this DB file — back it up, move it aside, then re-run to create a fresh Awareness store.`,
    );
  }
  if (identity.relations.length === 0) return 'fresh';
  const names = identity.relations.map(({ name }) => name).join(', ');
  throw new Error(`refusing unrecognized or unrelated SQLite store; relations: ${names}. An unrelated DB owns this file — back it up, move it aside, then re-run to create a fresh Awareness store.`);
}

export function assertDatabaseIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  const failures = integrity.filter(({ integrity_check }) => integrity_check !== 'ok');
  if (failures.length > 0) {
    throw new Error(`canonical integrity_check failed: ${failures.map((row) => row.integrity_check).join('; ')}`);
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) {
    throw new Error(`canonical foreign_key_check failed with ${foreignKeys.length} row(s)`);
  }
}

/**
 * Return a cached connection for high-frequency in-process harness operations.
 * Keyed by resolved DB path so tests and multiple workspaces stay isolated.
 */
export function connectCachedDb(dbPath: string): DatabaseSync {
  const resolved = resolve(dbPath);
  const cached = _dbCache.get(resolved);
  if (cached) return cached;
  const db = connectDb(resolved);
  _dbCache.set(resolved, db);
  return db;
}

/**
 * Return the cached database connection. Throws if connectDb() has not been
 * called yet in this process (or if the module was imported but the DB was
 * never opened).
 */
export function getDb(): DatabaseSync {
  if (!_db) throw new Error('Database not connected. Call connectDb() first.');
  return _db;
}

export interface DeliveryFingerprintKey {
  consumerId: string;
  channel: string;
  scopeKey: string;
}

/** Read the last payload fingerprint delivered to one consumer/scope. */
export function getDeliveryFingerprint(
  db: DatabaseSync,
  key: DeliveryFingerprintKey,
): string | null {
  const row = db.prepare(`SELECT fingerprint FROM delivery_state
    WHERE consumer_id = ? AND channel = ? AND scope_key = ?`)
    .get(key.consumerId, key.channel, key.scopeKey) as { fingerprint: string } | undefined;
  return row?.fingerprint ?? null;
}

/** Idempotently record the latest delivered payload fingerprint. */
export function setDeliveryFingerprint(
  db: DatabaseSync,
  params: DeliveryFingerprintKey & { fingerprint: string; deliveredAt?: string },
): void {
  db.prepare(`INSERT INTO delivery_state
      (consumer_id, channel, scope_key, fingerprint, delivered_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(consumer_id, channel, scope_key) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      delivered_at = excluded.delivered_at`)
    .run(params.consumerId, params.channel, params.scopeKey, params.fingerprint, params.deliveredAt ?? utcNow());
}
