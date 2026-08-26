import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openAwarenessStore, type AwarenessStore } from '../../src/coordination/index.js';

let workspace: string;
let aw: AwarenessStore;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-read-'));
  process.env.OCTOCODE_DB_PATH = join(workspace, 'octocode.sqlite3');
  aw = openAwarenessStore({ workspace });
});

afterEach(async () => {
  aw.close();
  delete process.env.OCTOCODE_DB_PATH;
  await rm(workspace, { recursive: true, force: true });
});

it('projects expired state without mutating stored rows', () => {
  const plan = aw.createPlan({ title: 'Read-only status' });
  const task = aw.addTask({ planId: plan.planId, title: 'leased' });
  aw.claimTask({ taskId: task.taskId, agentId: 'agent-a' });
  aw.acquireLock({ filePath: 'expired.ts', agentId: 'agent-a' });
  aw.startWork({ filePath: 'expired.ts', agentId: 'agent-a' });

  const db = new DatabaseSync(aw.dbPath);
  const expired = new Date(Date.now() - 60_000).toISOString();
  db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?').run(expired, task.taskId);
  db.prepare('UPDATE locks SET expires_at = ? WHERE workspace_path = ?').run(expired, workspace);
  db.prepare('UPDATE work_presence SET expires_at = ? WHERE workspace_path = ?').run(expired, workspace);

  expect(aw.status()).toMatchObject({ inProgressTasks: 0, readyTasks: 1, locks: 0, work: 0 });
  expect(aw.listTasks({ planId: plan.planId })).toMatchObject([{ status: 'OPEN', agentId: null }]);
  expect(aw.listLocks()).toEqual([]);
  expect(aw.listWork()).toEqual([]);

  expect(db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task.taskId)).toEqual({ status: 'CLAIMED' });
  expect((db.prepare('SELECT COUNT(*) AS count FROM locks WHERE workspace_path = ?').get(workspace) as { count: number }).count).toBe(1);
  expect((db.prepare('SELECT COUNT(*) AS count FROM work_presence WHERE workspace_path = ?').get(workspace) as { count: number }).count).toBe(1);
  db.close();
});
