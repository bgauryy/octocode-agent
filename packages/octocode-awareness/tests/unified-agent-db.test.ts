import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentDbPath } from '@octocodeai/octocode-shared/paths';
import { initOctocodeSchema } from '@octocodeai/octocode-shared/schema';
import { openAwarenessStore } from '../src/coordination/index.js';
import { connectDb } from '../src/db-runtime.js';
import { initializeDb } from '../src/db-init.js';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_APPLICATION_ID } from '@octocodeai/octocode-shared/schema';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unified global agent database', () => {
  it('places both Awareness surfaces in one agent-owned database', () => {
    const home = mkdtempSync(join(tmpdir(), 'octocode-unified-agent-home-'));
    roots.push(home);
    const env = { HOME: home, OCTOCODE_HOME: home };
    const dbPath = agentDbPath(env);

    const coordination = openAwarenessStore({ workspace: join(home, 'workspace'), dbPath });
    coordination.createPlan({ title: 'Coordination plan' });
    coordination.close();

    const advanced = connectDb(dbPath);
    expect(advanced.prepare("SELECT COUNT(*) AS count FROM plans").get()).toEqual({ count: 1 });
    expect(advanced.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='awareness_plans'").get())
      .toEqual({ name: 'awareness_plans' });
    expect(advanced.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    advanced.close();
  });

  it('supports advanced-first then coordination opening without table collisions', () => {
    const home = mkdtempSync(join(tmpdir(), 'octocode-unified-agent-reverse-'));
    roots.push(home);
    const dbPath = agentDbPath({ HOME: home, OCTOCODE_HOME: home });

    connectDb(dbPath).close();
    const coordination = openAwarenessStore({ workspace: join(home, 'workspace'), dbPath });
    const plan = coordination.createPlan({ title: 'Reverse-open plan' });
    coordination.close();

    const db = new DatabaseSync(dbPath);
    expect(db.prepare('SELECT title FROM plans WHERE plan_id = ?').get(plan.planId))
      .toEqual({ title: 'Reverse-open plan' });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='awareness_plans'").get())
      .toEqual({ name: 'awareness_plans' });
    expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: AGENT_APPLICATION_ID });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('installs Awareness into an existing agent-host connection', () => {
    const db = new DatabaseSync(':memory:');
    initOctocodeSchema(db);

    initializeDb(db);

    expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: AGENT_APPLICATION_ID });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='agent_sessions'").get())
      .toEqual({ name: 'agent_sessions' });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='awareness_plans'").get())
      .toEqual({ name: 'awareness_plans' });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    db.close();
  });

  it('refuses a foreign application database without adding agent tables', () => {
    const home = mkdtempSync(join(tmpdir(), 'octocode-foreign-db-'));
    roots.push(home);
    const dbPath = join(home, 'foreign.sqlite3');
    const foreign = new DatabaseSync(dbPath);
    foreign.exec('CREATE TABLE cli_owned(value TEXT); PRAGMA application_id = 12345');
    foreign.close();

    expect(() => openAwarenessStore({ workspace: home, dbPath })).toThrow(/foreign SQLite application_id/);
    const inspect = new DatabaseSync(dbPath);
    expect(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all())
      .toEqual([{ name: 'cli_owned' }]);
    inspect.close();
  });
});
