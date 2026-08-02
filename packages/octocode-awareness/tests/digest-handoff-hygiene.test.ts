import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initDb } from '../src/db.js';
import { digest } from '../src/maintenance.js';
import { insertNotification } from '../src/notifications.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initDb(db);
  return db;
}

const OLD = new Date(Date.now() - 30 * 86400000).toISOString();

function insertLegacyHandoffRefinement(db: DatabaseSync, id: string, state: string): void {
  db.prepare(
    `INSERT INTO refinements (
       refinement_id, agent_id, workspace_path, files_json, reasoning, remember,
       quality, state, created_at, updated_at
     ) VALUES (?, 'old-agent', '/repo', '[]', 'r', 'm', 'handoff', ?, ?, ?)`
  ).run(id, state, OLD, OLD);
}

describe('digest handoff hygiene', () => {
  it('prunes legacy open handoff refinements past retention (dead letters)', () => {
    const db = freshDb();
    insertLegacyHandoffRefinement(db, 'ref_open', 'open');
    insertLegacyHandoffRefinement(db, 'ref_ongoing', 'ongoing');
    insertLegacyHandoffRefinement(db, 'ref_done', 'done');

    const preview = digest(db, { dry_run: true });
    expect(preview.would_prune_refinements).toBe(3);

    const applied = digest(db, {});
    expect(applied.pruned_refinements).toBe(3);
    const left = db.prepare("SELECT COUNT(*) AS c FROM refinements WHERE quality = 'handoff'").get() as { c: number };
    expect(left.c).toBe(0);
  });

  it('keeps fresh open handoff refinements until retention passes', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO refinements (
         refinement_id, agent_id, workspace_path, files_json, reasoning, remember,
         quality, state, created_at, updated_at
       ) VALUES ('ref_fresh', 'a', '/repo', '[]', 'r', 'm', 'handoff', 'open', ?, ?)`
    ).run(now, now);
    const applied = digest(db, {});
    expect(applied.pruned_refinements).toBe(0);
  });

  it('auto-resolves open handoff signals older than retention (TTL), preserving others', () => {
    const db = freshDb();
    const stale = insertNotification(db, {
      agentId: 'a', kind: 'handoff', subject: 'stale handoff', workspacePath: '/repo',
    });
    db.prepare('UPDATE signals SET created_at = ? WHERE signal_id = ?').run(OLD, stale.signal_id);
    const fresh = insertNotification(db, {
      agentId: 'a', kind: 'handoff', subject: 'fresh handoff', workspacePath: '/repo',
    });
    const staleFyi = insertNotification(db, {
      agentId: 'a', kind: 'fyi', subject: 'old fyi stays open', workspacePath: '/repo',
    });
    db.prepare('UPDATE signals SET created_at = ? WHERE signal_id = ?').run(OLD, staleFyi.signal_id);

    const preview = digest(db, { dry_run: true });
    expect(preview.would_resolve_handoff_signals).toBe(1);

    const applied = digest(db, {});
    expect(applied.resolved_handoff_signals).toBe(1);
    const status = (id: string) =>
      (db.prepare('SELECT status FROM signals WHERE signal_id = ?').get(id) as { status: string }).status;
    expect(status(stale.signal_id)).toBe('resolved');
    expect(status(fresh.signal_id)).toBe('open');
    expect(status(staleFyi.signal_id)).toBe('open');
  });
});
