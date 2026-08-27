import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openAwarenessStore } from '../src/coordination/index.js';

const SHARED_TABLES = [
  'agent_sessions', 'agents', 'authorization_receipts', 'capability_receipts',
  'delivery_state', 'edit_log', 'event_acknowledgements', 'event_consumers',
  'event_outbox', 'handoffs', 'harness_log', 'hook_receipts', 'locks',
  'mcp_catalog_state', 'mcp_server_overrides', 'mcp_tool_overrides', 'memories',
  'memory_refs', 'message_receipts', 'messages', 'octocode_meta',
  'pending_interactions', 'plan_docs', 'plan_members', 'plans', 'refinements',
  'run_files', 'run_log', 'sessions', 'signal_reads', 'signals', 'skill_overrides',
  'task_claims', 'task_dependencies', 'task_events', 'task_paths', 'task_runs',
  'tasks', 'work_presence',
] as const;

describe('shared Awareness database contract', () => {
  it('creates every coordination, continuity, control, and auxiliary entity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awareness-shared-contract-'));
    const dbPath = join(dir, 'octocode.sqlite3');
    const store = openAwarenessStore({ workspace: dir, dbPath });
    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((row) => (row as { name: string }).name);
      const indexes = new Set(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      ).all().map((row) => (row as { name: string }).name));

      expect(tables).toEqual([...SHARED_TABLES].sort());
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect([...indexes]).toEqual(expect.arrayContaining([
        'idx_plans_ws', 'idx_tasks_status', 'idx_work_presence_file',
        'idx_messages_to', 'idx_event_outbox_workspace_sequence',
        'idx_interactions_session_status', 'idx_authorization_plan_revision',
      ]));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
