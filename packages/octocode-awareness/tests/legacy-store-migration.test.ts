import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { initOctocodeSchema, AGENT_APPLICATION_ID } from '@octocodeai/octocode-shared/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyMixedAwarenessStore } from '../src/legacy-store-migration.js';
import { openAwarenessStore } from '../src/coordination/open.js';
import { AWARENESS_APPLICATION_ID } from '../src/storage-scope.js';
import { appendWorkerLifecycleEvent } from '../src/worker-lifecycle-ledger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'awareness-legacy-migration-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createLegacyMixedStore(path: string): void {
  const store = openAwarenessStore({ workspace: fixtureRoot(), dbPath: path });
  store.close();
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      INSERT INTO plans(plan_id, workspace_path, title, goal, status, created_at, updated_at)
      VALUES ('plan-1', '/workspace/a', 'Legacy plan', 'Preserve it', 'OPEN', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO tasks(task_id, workspace_path, plan_id, title, status, created_at, updated_at)
      VALUES ('task-1', '/workspace/a', 'plan-1', 'Legacy task', 'OPEN', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO awareness_memories(
        memory_id, agent_id, task_context, observation, importance, tags_json, embedding, created_at
      ) VALUES (
        'memory-1', 'agent-1', 'legacy migration', 'preserve bytes', 9, '["migration"]', X'000102FF',
        '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO messages(message_id, workspace_path, from_agent_id, text, files_json, created_at)
      VALUES ('message-1', '/workspace/b', 'agent-2', 'all workspaces survive', '[]', '2026-01-02T00:00:00.000Z');
    `);
    initOctocodeSchema(db);
    appendWorkerLifecycleEvent(db, {
      packetId: 'packet-1',
      workspace: '/workspace/a',
      sessionId: 'session-1',
      workerId: 'worker-1',
      correlationId: 'correlation-1',
      type: 'worker.completed',
      redaction: 'internal',
      createdAt: '2026-01-03T00:00:00.000Z',
      payload: { result: 'preserved' },
    });
    db.exec(`PRAGMA application_id = ${AGENT_APPLICATION_ID}`);
  } finally {
    db.close();
  }
}

function runMigration(source: string, target: string): { code: number; output: Record<string, unknown> } {
  return {
    code: 0,
    output: migrateLegacyMixedAwarenessStore({ sourcePath: source, targetPath: target }) as unknown as Record<string, unknown>,
  };
}

describe('legacy mixed-store migration', () => {
  it('is reachable through the packaged coordination maintenance command with global defaults', () => {
    const octocodeHome = fixtureRoot();
    const source = join(octocodeHome, 'agent', 'agent.sqlite3');
    const target = join(octocodeHome, 'awareness', 'awareness.sqlite3');
    mkdirSync(join(octocodeHome, 'agent'), { recursive: true });
    createLegacyMixedStore(source);

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'out', 'octocode-awareness.js'),
      'coordination', 'maintenance', 'migrate-legacy',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, OCTOCODE_HOME: octocodeHome },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      source_path: source,
      target_path: target,
      source_unchanged: true,
    });
  });

  it('copies every Awareness relation transactionally and leaves the Agent source byte-identical', () => {
    const root = fixtureRoot();
    const source = join(root, 'agent.sqlite3');
    const target = join(root, 'awareness.sqlite3');
    createLegacyMixedStore(source);
    const sourceBefore = digest(source);

    const { code, output } = runMigration(source, target);

    expect(code).toBe(0);
    expect(output).toMatchObject({
      ok: true,
      migrated: true,
      source_path: source,
      target_path: target,
      source_application_id: AGENT_APPLICATION_ID,
      target_application_id: AWARENESS_APPLICATION_ID,
      integrity_check: 'ok',
      foreign_key_violations: 0,
      source_unchanged: true,
    });
    expect(digest(source)).toBe(sourceBefore);

    const db = new DatabaseSync(target, { readOnly: true });
    try {
      expect(db.prepare('SELECT title FROM plans WHERE plan_id = ?').get('plan-1')).toEqual({ title: 'Legacy plan' });
      expect(db.prepare('SELECT title FROM tasks WHERE task_id = ?').get('task-1')).toEqual({ title: 'Legacy task' });
      expect(db.prepare('SELECT text FROM messages WHERE message_id = ?').get('message-1')).toEqual({ text: 'all workspaces survive' });
      expect(db.prepare('SELECT hex(embedding) AS value FROM awareness_memories WHERE memory_id = ?').get('memory-1')).toEqual({ value: '000102FF' });
      expect(db.prepare('SELECT packet_id FROM worker_lifecycle_events').get()).toEqual({ packet_id: 'packet-1' });
      expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: AWARENESS_APPLICATION_ID });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects a nonempty target without changing either database', () => {
    const root = fixtureRoot();
    const source = join(root, 'agent.sqlite3');
    const target = join(root, 'awareness.sqlite3');
    createLegacyMixedStore(source);
    const targetStore = openAwarenessStore({ workspace: root, dbPath: target });
    targetStore.close();
    const sourceBefore = digest(source);
    const targetBefore = digest(target);

    expect(() => runMigration(source, target)).toThrow(/target.*exists/i);
    expect(digest(source)).toBe(sourceBefore);
    expect(digest(target)).toBe(targetBefore);
  });

  it('rejects an unknown source identity before creating the target', () => {
    const root = fixtureRoot();
    const source = join(root, 'awareness.sqlite3');
    const target = join(root, 'target.sqlite3');
    const store = openAwarenessStore({ workspace: root, dbPath: source });
    store.close();
    const sourceBefore = digest(source);

    expect(() => runMigration(source, target)).toThrow(/source application_id/i);
    expect(digest(source)).toBe(sourceBefore);
    expect(() => readFileSync(target)).toThrow();
  });

  it('rejects an unrecognized mixed schema without changing the source or creating the target', () => {
    const root = fixtureRoot();
    const source = join(root, 'agent.sqlite3');
    const target = join(root, 'target.sqlite3');
    createLegacyMixedStore(source);
    const db = new DatabaseSync(source);
    db.exec('CREATE TABLE unexpected_owner_data(id TEXT PRIMARY KEY)');
    db.close();
    const sourceBefore = digest(source);

    expect(() => runMigration(source, target)).toThrow(/unrecognized source relation/i);
    expect(digest(source)).toBe(sourceBefore);
    expect(() => readFileSync(target)).toThrow();
  });

  it('removes its temporary database when validation fails after target initialization', () => {
    const root = fixtureRoot();
    const source = join(root, 'agent.sqlite3');
    const target = join(root, 'awareness.sqlite3');
    createLegacyMixedStore(source);
    const db = new DatabaseSync(source);
    db.exec('ALTER TABLE messages ADD COLUMN legacy_extra TEXT');
    db.close();
    const sourceBefore = digest(source);

    expect(() => runMigration(source, target)).toThrow(/schema mismatch/i);
    expect(digest(source)).toBe(sourceBefore);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes('.migration-'))).toEqual([]);
  });
});
