/**
 * db.ts — the single shared local SQLite store.
 *
 * One file, `<home>/octocode.sqlite3`, opened once per process and cached by
 * resolved path. It holds the agent/session-owned tables plus whatever local
 * coordination tables their owners create idempotently on the same connection
 * (e.g. Awareness's plans/tasks/locks). Awareness is deliberately NOT
 * here — it keeps its own file and strict schema contract (see paths.ts).
 *
 * The low-level `node:sqlite` runtime (warning-filtered `DatabaseSync`, BUSY
 * retry, WAL checkpoint) lives in sqlite.ts; version-gated journal selection in
 * sqlite-version.ts. Requires Node >=22.13.0.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { octocodeDbPath } from './paths.js';
import { initOctocodeSchema } from './schema.js';
import {
  DatabaseSync,
  SQLITE_BUSY_DEADLINE_MS,
  withSqliteBusyRetry,
} from './sqlite.js';
import { journalModeForSqliteVersion } from './sqlite-version.js';

// Cache one connection per resolved path so tests and multiple homes stay
// isolated while the common (single-home) case reuses one handle.
const _cache = new Map<string, DatabaseSync>();

/**
 * Open (or reuse) the shared local DB, apply connection PRAGMAs, and ensure the
 * agent/session schema exists. This is the "init in process running" entry
 * point — call it once at startup; later callers get the cached connection.
 */
export function openOctocodeDb(
  dbPath: string = octocodeDbPath(),
): DatabaseSync {
  const resolved = resolve(dbPath);
  const cached = _cache.get(resolved);
  if (cached) return cached;

  if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  try {
    // busy_timeout first so the version read can't lose a first-open race.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_DEADLINE_MS}`);
    const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const journalMode = journalModeForSqliteVersion(versionRow.version);
    // journal_mode is a write and may race a first opener → bounded BUSY retry.
    withSqliteBusyRetry(() => db.exec(`PRAGMA journal_mode = ${journalMode}`));
    db.exec('PRAGMA foreign_keys = ON');
    initOctocodeSchema(db);
    _cache.set(resolved, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Close and drop the cached connection for a path (primarily for tests). */
export function closeOctocodeDb(dbPath: string = octocodeDbPath()): void {
  const resolved = resolve(dbPath);
  const db = _cache.get(resolved);
  if (!db) return;
  try {
    db.close();
  } finally {
    _cache.delete(resolved);
  }
}
