import {
  assertCanonicalRelationContract,
  assertCanonicalSchemaFingerprint,
} from './db-introspection.js';
import {
  assertDatabaseIntegrity,
  AWARENESS_APPLICATION_ID,
  DatabaseSync,
  inspectSchemaState,
  SchemaState,
  withSqliteBusyRetry,
} from './db-runtime.js';
import { FTS_SCHEMA_DDL, HOOK_RECEIPTS_DDL, SCHEMA_DDL, SCHEMA_INDEX_DDL } from './db-schema.js';
import { hasFts, rebuildFts } from './db-maintenance.js';

export function initDb(db: DatabaseSync): void {
  initializeDb(db);
}

export function initializeDb(db: DatabaseSync, knownState?: SchemaState): void {
  const state = knownState ?? inspectSchemaState(db);
  if (state === 'canonical') {
    if (!db.isTransaction) db.exec('PRAGMA foreign_keys = ON');
    return;
  }
  if (state === 'prior-hook-receipts') {
    migratePriorHookReceiptSchema(db);
    return;
  }
  if (state === 'prior-lifecycle-constraints') {
    migratePriorLifecycleConstraintSchema(db);
    return;
  }
  if (db.isTransaction) {
    throw new Error('cannot initialize canonical Awareness inside a caller-owned transaction');
  }

  db.exec('PRAGMA foreign_keys = OFF');
  let began = false;
  try {
    withSqliteBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    began = true;
    const lockedState = inspectSchemaState(db);
    if (lockedState === 'fresh') initializeFreshDb(db);
    db.exec('COMMIT');
    began = false;
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function migratePriorHookReceiptSchema(db: DatabaseSync): void {
  if (db.isTransaction) {
    throw new Error('cannot migrate canonical Awareness inside a caller-owned transaction');
  }
  let began = false;
  try {
    withSqliteBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    began = true;
    const lockedState = inspectSchemaState(db);
    if (lockedState === 'prior-hook-receipts') db.exec(HOOK_RECEIPTS_DDL);
    else if (lockedState !== 'canonical') throw new Error(`refusing hook receipt migration from schema state ${lockedState}`);
    assertCanonicalRelationContract(db);
    assertCanonicalSchemaFingerprint(db);
    assertDatabaseIntegrity(db);
    db.exec('COMMIT');
    began = false;
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    throw error;
  }
}

export function migratePriorLifecycleConstraintSchema(db: DatabaseSync): void {
  if (db.isTransaction) {
    throw new Error('cannot migrate canonical Awareness inside a caller-owned transaction');
  }
  let began = false;
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    withSqliteBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    began = true;
    const lockedState = inspectSchemaState(db);
    if (lockedState === 'prior-lifecycle-constraints') {
      db.exec(`
        ALTER TABLE task_events RENAME TO task_events_prior_lifecycle;
        CREATE TABLE task_events (
          event_id   TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          run_id     TEXT REFERENCES task_runs(run_id) ON DELETE SET NULL,
          agent_id   TEXT NOT NULL,
          event_type TEXT NOT NULL
                     CHECK(event_type IN ('CREATED','DEPENDENCY_ADDED','CLAIMED','SUBMITTED','BLOCKED','RELEASED','CLAIM_EXPIRED','VERIFIED','VERIFICATION_FAILED')),
          message    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO task_events(event_id, task_id, run_id, agent_id, event_type, message, created_at)
          SELECT event_id, task_id, run_id, agent_id, event_type, message, created_at
          FROM task_events_prior_lifecycle;
        DROP TABLE task_events_prior_lifecycle;

        ALTER TABLE signal_reads RENAME TO signal_reads_prior_lifecycle;
        ALTER TABLE signals RENAME TO signals_prior_lifecycle;
        CREATE TABLE signals (
          signal_id      TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          artifact       TEXT,
          repo           TEXT,
          ref            TEXT,
          from_agent     TEXT NOT NULL,
          to_agent       TEXT,
          kind           TEXT NOT NULL,
          subject        TEXT NOT NULL,
          body           TEXT,
          files_json     TEXT NOT NULL DEFAULT '[]',
          refs_json      TEXT NOT NULL DEFAULT '[]',
          thread_id      TEXT NOT NULL,
          reply_to       TEXT,
          importance     INTEGER NOT NULL DEFAULT 5,
          status         TEXT NOT NULL DEFAULT 'open'
                         CHECK(status IN ('open','resolved')),
          resolved_at    TEXT,
          created_at     TEXT NOT NULL
        );
        INSERT INTO signals(
          signal_id, workspace_path, artifact, repo, ref, from_agent, to_agent, kind, subject, body,
          files_json, refs_json, thread_id, reply_to, importance, status, resolved_at, created_at
        )
          SELECT signal_id, workspace_path, artifact, repo, ref, from_agent, to_agent, kind, subject, body,
            files_json, refs_json, thread_id, reply_to, importance, status, resolved_at, created_at
          FROM signals_prior_lifecycle;
        DROP TABLE signals_prior_lifecycle;

        CREATE TABLE signal_reads (
          signal_id TEXT NOT NULL,
          agent_id  TEXT NOT NULL,
          read_at   TEXT NOT NULL,
          PRIMARY KEY (signal_id, agent_id),
          FOREIGN KEY(signal_id) REFERENCES signals(signal_id) ON DELETE CASCADE
        );
        INSERT INTO signal_reads(signal_id, agent_id, read_at)
          SELECT signal_id, agent_id, read_at FROM signal_reads_prior_lifecycle;
        DROP TABLE signal_reads_prior_lifecycle;
      `);
      db.exec(SCHEMA_INDEX_DDL);
      db.exec('PRAGMA foreign_keys = ON');
    } else if (lockedState !== 'canonical') {
      throw new Error(`refusing lifecycle-constraint migration from schema state ${lockedState}`);
    }
    assertCanonicalRelationContract(db);
    assertCanonicalSchemaFingerprint(db);
    db.exec('COMMIT');
    began = false;
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function initializeFreshDb(db: DatabaseSync): void {
  db.exec(SCHEMA_DDL);
  db.exec(SCHEMA_INDEX_DDL);

  try {
    db.exec(FTS_SCHEMA_DDL);
  } catch {
    /* FTS5 is optional in the embedded SQLite build. */
  }
  if (hasFts(db)) rebuildFts(db);

  assertCanonicalRelationContract(db);
  assertCanonicalSchemaFingerprint(db);
  assertDatabaseIntegrity(db);
  db.exec(`PRAGMA application_id = ${AWARENESS_APPLICATION_ID}`);
}
