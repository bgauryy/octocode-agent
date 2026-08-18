import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AWARENESS_APPLICATION_ID, connectDb } from '../src/db.js';
import { SCHEMA_DDL, SCHEMA_INDEX_DDL } from '../src/db-schema.js';

function priorLifecycleConstraintSchemaDdl(): string {
  return SCHEMA_DDL
    .replace(
      "      event_type TEXT NOT NULL\n                 CHECK(event_type IN ('CREATED','DEPENDENCY_ADDED','CLAIMED','SUBMITTED','BLOCKED','RELEASED','CLAIM_EXPIRED','VERIFIED','VERIFICATION_FAILED')),",
      '      event_type TEXT NOT NULL,',
    )
    .replace(
      "      status         TEXT NOT NULL DEFAULT 'open'\n                     CHECK(status IN ('open','resolved')),",
      "      status         TEXT NOT NULL DEFAULT 'open',",
    );
}

function priorDatabase(path: string, tamper = false): void {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_DDL);
  db.exec(SCHEMA_INDEX_DDL);
  db.exec('DROP TABLE hook_receipts');
  if (tamper) db.exec('ALTER TABLE memories ADD COLUMN tampered TEXT');
  db.exec(`PRAGMA application_id = ${AWARENESS_APPLICATION_ID}`);
  db.close();
}

function priorLifecycleConstraintDatabase(path: string, withUnrelatedForeignKeyDebt = false): void {
  const db = new DatabaseSync(path);
  db.exec(priorLifecycleConstraintSchemaDdl());
  db.exec(SCHEMA_INDEX_DDL);
  db.exec(`
    INSERT INTO plans(plan_id, name, objective, lead_agent_id, status, workspace_path, doc_dir, created_at, updated_at)
      VALUES ('plan_migrate', 'Migrate', 'Migrate lifecycle constraints.', 'lead', 'ACTIVE', '/tmp/repo', '.octocode/plan/migrate', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO tasks(task_id, plan_id, title, reasoning, acceptance_criteria, status, created_by, created_at, updated_at)
      VALUES ('task_migrate', 'plan_migrate', 'Task', 'reason', 'verify', 'OPEN', 'lead', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO task_events(event_id, task_id, agent_id, event_type, message, created_at)
      VALUES ('event_migrate', 'task_migrate', 'lead', 'CREATED', 'created', '2026-01-01T00:00:00Z');
    INSERT INTO signals(signal_id, workspace_path, from_agent, to_agent, kind, subject, thread_id, importance, status, created_at)
      VALUES ('ntf_migrate', '/tmp/repo', 'agent-a', 'agent-b', 'fyi', 'subject', 'ntf_migrate', 5, 'open', '2026-01-01T00:00:00Z');
    INSERT INTO signal_reads(signal_id, agent_id, read_at)
      VALUES ('ntf_migrate', 'agent-b', '2026-01-01T00:00:01Z');
  `);
  if (withUnrelatedForeignKeyDebt) {
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO run_files(run_id, file_path, source, started_at, heartbeat_at, expires_at)
        VALUES ('run_missing', 'src/a.ts', 'EXPLICIT', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z');
      PRAGMA foreign_keys = ON;`);
  }
  db.exec(`PRAGMA application_id = ${AWARENESS_APPLICATION_ID}`);
  db.close();
}

describe('lifecycle constraint schema migration', () => {
  it('migrates exact prior lifecycle schema and preserves rows while enforcing new checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octocode-lifecycle-migration-'));
    const path = join(dir, 'awareness.sqlite3');
    try {
      priorLifecycleConstraintDatabase(path);
      const db = connectDb(path);
      expect(db.prepare('SELECT event_type FROM task_events WHERE event_id = ?').get('event_migrate'))
        .toEqual({ event_type: 'CREATED' });
      expect(db.prepare('SELECT status FROM signals WHERE signal_id = ?').get('ntf_migrate'))
        .toEqual({ status: 'open' });
      expect(db.prepare('SELECT agent_id FROM signal_reads WHERE signal_id = ?').get('ntf_migrate'))
        .toEqual({ agent_id: 'agent-b' });
      expect(() => db.prepare(`INSERT INTO task_events(event_id, task_id, agent_id, event_type, message, created_at)
        VALUES ('event_bad', 'task_migrate', 'lead', 'BOGUS', 'bad', '2026-01-01T00:00:00Z')`).run())
        .toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO signals(signal_id, workspace_path, from_agent, kind, subject, thread_id, importance, status, created_at)
        VALUES ('ntf_bad', '/tmp/repo', 'agent-a', 'fyi', 'subject', 'ntf_bad', 5, 'archived', '2026-01-01T00:00:00Z')`).run())
        .toThrow(/CHECK constraint failed/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reject lifecycle migration for unrelated pre-existing foreign-key debt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octocode-lifecycle-fk-debt-'));
    const path = join(dir, 'awareness.sqlite3');
    try {
      priorLifecycleConstraintDatabase(path, true);
      const db = connectDb(path);
      expect(db.prepare('SELECT event_type FROM task_events WHERE event_id = ?').get('event_migrate'))
        .toEqual({ event_type: 'CREATED' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([
        expect.objectContaining({ table: 'run_files', parent: 'task_runs' }),
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hook receipt schema migration', () => {
  it('transactionally migrates the exact prior persisted Awareness schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octocode-receipt-migration-'));
    const path = join(dir, 'awareness.sqlite3');
    try {
      priorDatabase(path);
      const db = connectDb(path);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'hook_receipts'").get())
        .toEqual({ name: 'hook_receipts' });
      db.close();
      const reopened = connectDb(path);
      expect(reopened.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered prior-looking database without mutating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octocode-receipt-tampered-'));
    const path = join(dir, 'awareness.sqlite3');
    try {
      priorDatabase(path, true);
      expect(() => connectDb(path)).toThrow(/canonical relation contract mismatch|canonical schema fingerprint mismatch/);
      const raw = new DatabaseSync(path);
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'hook_receipts'").get()).toBeUndefined();
      expect(raw.prepare('PRAGMA table_info(memories)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'tampered' }),
      ]));
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
