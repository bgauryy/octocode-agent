import {
  assertCanonicalRelationContract,
  assertCanonicalSchemaFingerprint,
} from './db-introspection.js';
import {
  assertDatabaseIntegrity,
  DatabaseSync,
  inspectSchemaState,
  SchemaState,
  withSqliteBusyRetry,
} from './db-runtime.js';
import { AGENT_APPLICATION_ID } from '@octocodeai/octocode-shared/schema';
import { FTS_SCHEMA_DDL, SCHEMA_DDL, SCHEMA_INDEX_DDL } from './db-schema.js';
import { hasFts, rebuildFts } from './db-maintenance.js';

export function initDb(db: DatabaseSync): void {
  initializeDb(db);
}

export function initializeDb(db: DatabaseSync, knownState?: SchemaState): void {
  const state = knownState ?? inspectSchemaState(db);
  if (state === 'canonical') {
    if (!db.isTransaction) db.exec('PRAGMA foreign_keys = ON');
    assertDatabaseIntegrity(db);
    return;
  }
  if (state === 'agent-host') {
    initializeAgentModule(db);
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
  db.exec(`PRAGMA application_id = ${AGENT_APPLICATION_ID}`);
}

export function initializeAgentModule(db: DatabaseSync): void {
  if (db.isTransaction) {
    throw new Error('cannot initialize the Awareness module inside a caller-owned transaction');
  }
  let began = false;
  try {
    withSqliteBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    began = true;
    const lockedState = inspectSchemaState(db);
    if (lockedState === 'agent-host') {
      db.exec(SCHEMA_DDL);
      db.exec(SCHEMA_INDEX_DDL);
      try { db.exec(FTS_SCHEMA_DDL); } catch { /* FTS5 is optional. */ }
      if (hasFts(db)) rebuildFts(db);
    } else if (lockedState !== 'canonical') {
      throw new Error(`refusing Awareness module initialization from schema state ${lockedState}`);
    }
    assertCanonicalRelationContract(db);
    assertCanonicalSchemaFingerprint(db);
    assertDatabaseIntegrity(db);
    db.exec(`PRAGMA application_id = ${AGENT_APPLICATION_ID}`);
    db.exec('COMMIT');
    began = false;
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    throw error;
  }
}
