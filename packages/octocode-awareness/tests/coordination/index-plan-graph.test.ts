import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAwarenessStore, type AwarenessStore } from '../../src/coordination/index.js';

let workspace: string;
let aw: AwarenessStore;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-'));
  process.env.OCTOCODE_DB_PATH = join(workspace, 'octocode.sqlite3');
  aw = openAwarenessStore({ workspace });
});

afterEach(async () => {
  aw.close();
  delete process.env.OCTOCODE_DB_PATH;
  await rm(workspace, { recursive: true, force: true });
});

describe('Phase 1: source identities, ABANDONED/CANCELLED, and graph primitives', () => {
  it('materializePlanGraph returns identical plan/task IDs on duplicate calls (idempotent)', () => {
    const steps = [
      { sourceStepKey: 'step-1', title: 'Define schema', paths: ['src/index.ts'], acceptance: 'types compile', checkCommand: 'yarn test' },
      { sourceStepKey: 'step-2', title: 'Wire wiring', dependsOnStepKeys: ['step-1'], reasoning: 'needs step-1' },
    ];

    const first = aw.materializePlanGraph({
      sourcePlanKey: 'rfc-ship-v1',
      sourceKind: 'rfc',
      title: 'Ship RFC',
      goal: 'implement it',
      rfcPath: '.octocode/rfc/ship/RFC.md',
      rfcRevision: 'abc123',
      steps,
    });

    const second = aw.materializePlanGraph({
      sourcePlanKey: 'rfc-ship-v1',
      sourceKind: 'rfc',
      title: 'Ship RFC',
      goal: 'implement it',
      rfcPath: '.octocode/rfc/ship/RFC.md',
      rfcRevision: 'abc123',
      steps,
    });

    // Same plan ID
    expect(second.plan.planId).toBe(first.plan.planId);
    // Same task IDs for each step
    expect(second.tasks.get('step-1')!.taskId).toBe(first.tasks.get('step-1')!.taskId);
    expect(second.tasks.get('step-2')!.taskId).toBe(first.tasks.get('step-2')!.taskId);
    // Only one plan in DB
    expect(aw.listPlans()).toHaveLength(1);
    // Only two tasks
    expect(aw.listTasks({ planId: first.plan.planId })).toHaveLength(2);
    // Source fields persisted
    expect(first.plan.sourceKind).toBe('rfc');
    expect(first.plan.sourceKey).toBe('rfc-ship-v1');
    expect(first.plan.rfcPath).toBe('.octocode/rfc/ship/RFC.md');
    expect(first.plan.rfcRevision).toBe('abc123');
    // Step-2 task has sourceStepKey
    expect(first.tasks.get('step-2')!.sourceStepKey).toBe('step-2');
    // Dependency resolved: step-2 depends on step-1's task ID
    const step2 = first.tasks.get('step-2')!;
    const step1 = first.tasks.get('step-1')!;
    expect(step2.dependencies).toEqual([step1.taskId]);
  });

  it('materializePlanGraph converges removed dependencies without changing task IDs', () => {
    const first = aw.materializePlanGraph({
      sourcePlanKey: 'graph-update',
      title: 'Graph Update',
      steps: [
        { sourceStepKey: 'a', title: 'A' },
        { sourceStepKey: 'b', title: 'B', dependsOnStepKeys: ['a'] },
      ],
    });
    const second = aw.materializePlanGraph({
      sourcePlanKey: 'graph-update',
      title: 'Graph Update',
      steps: [
        { sourceStepKey: 'a', title: 'A' },
        { sourceStepKey: 'b', title: 'B' },
      ],
    });

    expect(second.tasks.get('b')!.taskId).toBe(first.tasks.get('b')!.taskId);
    expect(second.tasks.get('b')!.dependencies).toEqual([]);
  });

  it('binds a source projection to one RFC revision and emits one transactional event', () => {
    const input = {
      sourcePlanKey: 'revision-bound-plan', sourceKind: 'rfc', title: 'Revision bound', rfcRevision: 'sha256:one',
      steps: [{ sourceStepKey: 's1', title: 'One' }],
    };
    const first = aw.materializePlanGraph(input);
    aw.materializePlanGraph(input);
    expect(aw.listEvents({ consumerId: 'projection-test', limit: 20 })
      .filter((event) => event.type === 'plan.projected' && event.aggregate?.id === first.plan.planId)).toHaveLength(1);
    expect(() => aw.materializePlanGraph({ ...input, rfcRevision: 'sha256:two' }))
      .toThrow(/projection revision conflict/);
    expect(aw.getPlan(first.plan.planId).rfcRevision).toBe('sha256:one');
  });

  it('fails closed when an existing source graph has a different revision presence', () => {
    aw.materializePlanGraph({
      sourcePlanKey: 'revision-presence', title: 'Unversioned',
      steps: [{ sourceStepKey: 's1', title: 'One' }],
    });
    expect(() => aw.materializePlanGraph({
      sourcePlanKey: 'revision-presence', title: 'Now versioned', rfcRevision: 'sha256:one',
      steps: [{ sourceStepKey: 's1', title: 'One' }],
    })).toThrow(/projection revision conflict/);
  });

  it('materializePlanGraph rejects duplicate step identities and terminal source plans', () => {
    expect(() => aw.materializePlanGraph({
      sourcePlanKey: 'duplicate-steps',
      title: 'Duplicate Steps',
      steps: [
        { sourceStepKey: 'same', title: 'First' },
        { sourceStepKey: 'same', title: 'Second' },
      ],
    })).toThrow('duplicate source step key: same');
    expect(aw.getPlanBySourceKey({ sourceKind: 'local', sourceKey: 'duplicate-steps' })).toBeNull();

    const graph = aw.materializePlanGraph({
      sourcePlanKey: 'terminal-plan',
      title: 'Terminal Plan',
      steps: [{ sourceStepKey: 'only', title: 'Only' }],
    });
    aw.abandonPlan({ planId: graph.plan.planId, agentId: 'agent-a', reason: 'stopped' });
    expect(() => aw.materializePlanGraph({
      sourcePlanKey: 'terminal-plan',
      title: 'Terminal Plan Again',
      steps: [{ sourceStepKey: 'only', title: 'Only Again' }],
    })).toThrow('source plan is ABANDONED');
    expect(aw.listTasks({ planId: graph.plan.planId })).toHaveLength(1);
  });

  it('materializePlanGraph rolls back on mid-transaction failure — zero rows left', () => {
    // A step with a dependency key not in the graph triggers a rollback
    expect(() =>
      aw.materializePlanGraph({
        sourcePlanKey: 'bad-plan',
        title: 'Will Fail',
        steps: [
          { sourceStepKey: 'step-a', title: 'Step A', dependsOnStepKeys: ['step-nonexistent'] },
        ],
      }),
    ).toThrow('dependency step key not in graph');

    // No plan rows left
    expect(aw.listPlans()).toHaveLength(0);
  });

  it('verified dependencies gate readiness after materializePlanGraph', () => {
    const result = aw.materializePlanGraph({
      sourcePlanKey: 'dep-test',
      title: 'Dep Test',
      steps: [
        { sourceStepKey: 'a', title: 'Task A' },
        { sourceStepKey: 'b', title: 'Task B', dependsOnStepKeys: ['a'] },
      ],
    });

    const taskA = result.tasks.get('a')!;
    const taskB = result.tasks.get('b')!;

    // Only task A is ready initially
    expect(aw.listReadyTasks({ planId: result.plan.planId }).map((t) => t.taskId)).toEqual([taskA.taskId]);
    expect(() => aw.claimTask({ taskId: taskB.taskId, agentId: 'agent-a' })).toThrow(`blocked by ${taskA.taskId}`);

    // Complete and verify A — B unlocks
    aw.doneTask({ taskId: taskA.taskId, agentId: 'agent-a' });
    aw.markCheck({ taskId: taskA.taskId, agentId: 'agent-a', message: 'tests passed' });
    expect(aw.listReadyTasks({ planId: result.plan.planId }).map((t) => t.taskId)).toEqual([taskB.taskId]);
  });

  it('abandonPlan cancels unfinished tasks, preserves DONE history, excludes CANCELLED from ready/debt', () => {
    const plan = aw.createPlan({ title: 'Abandon Me' });
    const taskDone = aw.addTask({ planId: plan.planId, title: 'Already done' });
    const taskOpen = aw.addTask({ planId: plan.planId, title: 'Still open' });
    const taskClaimed = aw.addTask({ planId: plan.planId, title: 'Claimed' });

    // task done + verified
    aw.doneTask({ taskId: taskDone.taskId, agentId: 'agent-a' });
    aw.markCheck({ taskId: taskDone.taskId, agentId: 'agent-a', message: 'passed' });

    // task claimed
    aw.claimTask({ taskId: taskClaimed.taskId, agentId: 'agent-a' });

    const result = aw.abandonPlan({ planId: plan.planId, agentId: 'agent-a', reason: 'scope changed' });

    expect(result.plan.status).toBe('ABANDONED');
    expect(result.cancelled).toBe(2); // taskOpen + taskClaimed

    // DONE task preserved unchanged
    expect(aw.getTask(taskDone.taskId).status).toBe('DONE');
    // OPEN task now CANCELLED
    expect(aw.getTask(taskOpen.taskId).status).toBe('CANCELLED');
    expect(aw.getTask(taskOpen.taskId).verificationMessage).toBe('scope changed');
    // CLAIMED task now CANCELLED
    expect(aw.getTask(taskClaimed.taskId).status).toBe('CANCELLED');

    // CANCELLED tasks excluded from ready list
    expect(aw.listReadyTasks({ planId: plan.planId })).toHaveLength(0);
    // CANCELLED tasks excluded from verification debt
    expect(aw.auditChecks({ planId: plan.planId }).pendingCount).toBe(0);
    // Overall ready task count
    expect(aw.status().readyTasks).toBe(0);
  });

  it('donePlan succeeds when remaining tasks are CANCELLED', () => {
    const plan = aw.createPlan({ title: 'Cancel Some' });
    const taskA = aw.addTask({ planId: plan.planId, title: 'Done task' });
    const taskB = aw.addTask({ planId: plan.planId, title: 'Cancelled task' });

    // task A: done + verified
    aw.doneTask({ taskId: taskA.taskId, agentId: 'agent-a' });
    aw.markCheck({ taskId: taskA.taskId, agentId: 'agent-a', message: 'passed' });

    // task B: cancel it via abandonPlan first, then test donePlan
    // Use DB injection to set CANCELLED directly
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(aw.dbPath);
    try {
      db.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE task_id = ?").run(taskB.taskId);
    } finally {
      db.close();
    }

    // donePlan should succeed since only CANCELLED + DONE tasks remain
    expect(aw.donePlan({ planId: plan.planId }).status).toBe('DONE');
  });

  it('getPlanBySourceKey finds plans by source identity', () => {
    aw.materializePlanGraph({
      sourcePlanKey: 'my-plan-key',
      sourceKind: 'rfc',
      title: 'My Plan',
      steps: [{ sourceStepKey: 'step-1', title: 'Step One' }],
    });

    const found = aw.getPlanBySourceKey({ sourceKind: 'rfc', sourceKey: 'my-plan-key' });
    expect(found).not.toBeNull();
    expect(found!.sourceKey).toBe('my-plan-key');
    expect(found!.sourceKind).toBe('rfc');

    // Non-existent returns null
    expect(aw.getPlanBySourceKey({ sourceKind: 'rfc', sourceKey: 'no-such-plan' })).toBeNull();
    // Empty params returns null
    expect(aw.getPlanBySourceKey({ sourceKind: '', sourceKey: 'key' })).toBeNull();
  });

  it('reconcilePlanGraph returns source step key to task mapping', () => {
    const result = aw.materializePlanGraph({
      sourcePlanKey: 'reconcile-test',
      title: 'Reconcile Plan',
      steps: [
        { sourceStepKey: 'step-x', title: 'X' },
        { sourceStepKey: 'step-y', title: 'Y' },
      ],
    });

    const mapping = aw.reconcilePlanGraph({ planId: result.plan.planId });
    expect(mapping.size).toBe(2);
    expect(mapping.has('step-x')).toBe(true);
    expect(mapping.has('step-y')).toBe(true);
    expect(mapping.get('step-x')!.taskId).toBe(result.tasks.get('step-x')!.taskId);

    // Tasks without source_step_key are excluded
    const manualTask = aw.addTask({ planId: result.plan.planId, title: 'Manual' });
    const mapping2 = aw.reconcilePlanGraph({ planId: result.plan.planId });
    expect(mapping2.size).toBe(2); // manualTask excluded
    expect(Array.from(mapping2.values()).map((t) => t.taskId)).not.toContain(manualTask.taskId);
  });

  it('migrates old plans/tasks tables to add ABANDONED/CANCELLED statuses', async () => {
    aw.close();

    // Create a legacy DB with old-style status constraints
    const { DatabaseSync: DS } = require('node:sqlite');
    const legacyDb = new DS(process.env.OCTOCODE_DB_PATH!);
    try {
      legacyDb.exec(`
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS plans;
        CREATE TABLE plans (
          plan_id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL,
          goal TEXT,
          status TEXT NOT NULL CHECK(status IN ('OPEN', 'DONE')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL DEFAULT '',
          plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          file_path TEXT,
          check_command TEXT,
          status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'DONE')),
          agent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          done_at TEXT
        );
        INSERT INTO plans VALUES ('p1', '${workspace.replace(/'/g, "''")}', 'Legacy Plan', NULL, 'OPEN', datetime('now'), datetime('now'));
        INSERT INTO tasks VALUES ('t1', '${workspace.replace(/'/g, "''")}', 'p1', 'Legacy Task', NULL, NULL, 'OPEN', NULL, datetime('now'), datetime('now'), NULL);
      `);
    } finally {
      legacyDb.close();
    }

    // Re-open triggers migration
    aw = openAwarenessStore({ workspace });

    // Should be able to insert ABANDONED plan
    const { DatabaseSync: DS2 } = require('node:sqlite');
    const db = new DS2(aw.dbPath);
    try {
      const result = db.prepare("INSERT INTO plans(plan_id, workspace_path, title, goal, status, source_kind, source_key, rfc_path, rfc_revision, created_at, updated_at) VALUES ('p2', ?, 'Abandoned', NULL, 'ABANDONED', NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))").run(workspace);
      expect(result.changes).toBe(1);
      const result2 = db.prepare("INSERT INTO tasks(task_id, workspace_path, plan_id, title, file_path, paths_json, reasoning, acceptance, check_command, status, priority, dependencies_json, agent_id, claimed_at, lease_expires_at, source_step_key, created_at, updated_at, done_at, verified_at, verified_by, verification_message) VALUES ('t2', ?, 'p2', 'Cancelled Task', NULL, '[]', NULL, NULL, NULL, 'CANCELLED', 0, '[]', NULL, NULL, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL, NULL, NULL)").run(workspace);
      expect(result2.changes).toBe(1);
    } finally {
      db.close();
    }

    // Legacy data still accessible
    const plans = aw.listPlans();
    expect(plans.some((p) => p.planId === 'p1')).toBe(true);
    const tasks = aw.listTasks({});
    expect(tasks.some((t) => t.taskId === 't1')).toBe(true);
  });
});
