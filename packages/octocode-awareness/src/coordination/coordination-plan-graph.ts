import type { Plan,PlanGraphResult,SourceStep,Task } from '@octocodeai/octocode-shared/entities';
import { AwarenessSchemaHelpers } from './coordination-schema-helpers.js';
import { id,now,planFromRow,PlanRow,required,taskFromRow,TaskRow } from './coordination-shared.js';

export abstract class CoordinationPlanGraph extends AwarenessSchemaHelpers {
  getPlanBySourceKey(params: { sourceKind: string; sourceKey: string }): Plan | null {
    const kind = params.sourceKind?.trim();
    const key = params.sourceKey?.trim();
    if (!kind || !key) return null;
    const row = this.db.prepare('SELECT * FROM plans WHERE workspace_path = ? AND source_kind = ? AND source_key = ?')
      .get(this.workspace, kind, key) as unknown as PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  reconcilePlanGraph(params: { planId: string }): Map<string, Task> {
    this.getPlan(params.planId); // verify plan exists
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE workspace_path = ? AND plan_id = ? AND source_step_key IS NOT NULL ORDER BY created_at ASC",
    ).all(this.workspace, params.planId) as unknown as TaskRow[];
    const mapping = new Map<string, Task>();
    for (const row of rows) {
      mapping.set(row.source_step_key!, taskFromRow(row));
    }
    return mapping;
  }

  abandonPlan(params: { planId: string; agentId: string; reason?: string | null }): { plan: Plan; cancelled: number } {
    this.getPlan(params.planId);
    const stamp = now();
    let cancelled = 0;
    this.db.exec('BEGIN');
    try {
      const result = this.db.prepare(
        "UPDATE tasks SET status = 'CANCELLED', updated_at = ?, verification_message = ? WHERE workspace_path = ? AND plan_id = ? AND status IN ('OPEN', 'CLAIMED')",
      ).run(stamp, params.reason?.trim() || 'plan abandoned', this.workspace, params.planId);
      cancelled = Number(result.changes);
      this.db.prepare("UPDATE plans SET status = 'ABANDONED', updated_at = ? WHERE plan_id = ?")
        .run(stamp, params.planId);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { plan: this.getPlan(params.planId), cancelled };
  }

  materializePlanGraph(params: {
    sourcePlanKey: string;
    sourceKind?: string | null;
    title: string;
    goal?: string | null;
    rfcPath?: string | null;
    rfcRevision?: string | null;
    steps: SourceStep[];
  }): PlanGraphResult {
    const stamp = now();
    const kind = params.sourceKind?.trim() || 'local';
    const key = required(params.sourcePlanKey, 'sourcePlanKey');
    const sourceStepKeys = new Set<string>();
    for (const step of params.steps) {
      const stepKey = required(step.sourceStepKey, 'step.sourceStepKey');
      if (sourceStepKeys.has(stepKey)) {
        throw new Error(`materializePlanGraph: duplicate source step key: ${stepKey}`);
      }
      sourceStepKeys.add(stepKey);
    }
    let planId = '';
    const taskIdByStepKey = new Map<string, string>();

    // Acquire the write reservation before reading the source identity. A
    // deferred transaction lets competing Start attempts both observe an
    // absent graph and then race on the first INSERT; BEGIN IMMEDIATE makes
    // every independent store serialize onto the same stable upsert result.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT plan_id, rfc_revision FROM plans WHERE workspace_path = ? AND source_kind = ? AND source_key = ?')
        .get(this.workspace, kind, key) as { plan_id: string; rfc_revision: string | null } | undefined;
      const requestedRevision = params.rfcRevision?.trim() || null;
      if (existing && existing.rfc_revision !== requestedRevision) {
        throw new Error(`materializePlanGraph: projection revision conflict for ${key}: stored ${existing.rfc_revision}, requested ${requestedRevision ?? '(none)'}`);
      }
      // Upsert plan by (workspace_path, source_kind, source_key)
      const newPlanId = id('plan');
      this.db.prepare(`
        INSERT INTO plans(plan_id, workspace_path, title, goal, status, source_kind, source_key, rfc_path, rfc_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_path, source_kind, source_key) WHERE source_kind IS NOT NULL AND source_key IS NOT NULL
        DO UPDATE SET
          title = excluded.title,
          goal = excluded.goal,
          rfc_path = excluded.rfc_path,
          rfc_revision = excluded.rfc_revision,
          updated_at = excluded.updated_at
      `).run(
        newPlanId, this.workspace,
        required(params.title, 'title'),
        params.goal?.trim() || null,
        kind, key,
        params.rfcPath?.trim() || null,
        params.rfcRevision?.trim() || null,
        stamp, stamp,
      );

      const planRow = this.db.prepare('SELECT * FROM plans WHERE workspace_path = ? AND source_kind = ? AND source_key = ?')
        .get(this.workspace, kind, key) as unknown as PlanRow | undefined;
      if (!planRow) throw new Error(`materializePlanGraph: plan upsert failed for key ${key}`);
      if (planRow.status !== 'OPEN') {
        throw new Error(`materializePlanGraph: source plan is ${planRow.status}: ${key}`);
      }
      planId = planRow.plan_id;

      // Upsert each step as a task by (plan_id, source_step_key)
      for (const step of params.steps) {
        const stepKey = required(step.sourceStepKey, 'step.sourceStepKey');
        const newTaskId = id('task');
        const paths = step.paths ?? [];
        const filePath = paths[0] ?? null;

        this.db.prepare(`
          INSERT INTO tasks(task_id, workspace_path, plan_id, title, file_path, paths_json, reasoning, acceptance, check_command, status, priority, dependencies_json, source_step_key, agent_id, claimed_at, lease_expires_at, created_at, updated_at, done_at, verified_at, verified_by, verification_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, '[]', ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)
          ON CONFLICT(plan_id, source_step_key) WHERE source_step_key IS NOT NULL
          DO UPDATE SET
            title = excluded.title,
            file_path = excluded.file_path,
            paths_json = excluded.paths_json,
            reasoning = excluded.reasoning,
            acceptance = excluded.acceptance,
            check_command = excluded.check_command,
            priority = excluded.priority,
            dependencies_json = excluded.dependencies_json,
            updated_at = excluded.updated_at
        `).run(
          newTaskId, this.workspace, planId,
          required(step.title, 'step.title'),
          filePath,
          JSON.stringify(paths),
          step.reasoning?.trim() || null,
          step.acceptance?.trim() || null,
          step.checkCommand?.trim() || null,
          Math.trunc(step.priority ?? 0),
          stepKey,
          stamp, stamp,
        );

        const taskRow = this.db.prepare('SELECT task_id FROM tasks WHERE plan_id = ? AND source_step_key = ?')
          .get(planId, stepKey) as { task_id: string } | undefined;
        if (!taskRow) throw new Error(`materializePlanGraph: task upsert failed for step: ${stepKey}`);
        taskIdByStepKey.set(stepKey, taskRow.task_id);
      }

      // Resolve dependencies inside the same transaction
      for (const step of params.steps) {
        const taskId = taskIdByStepKey.get(step.sourceStepKey)!;
        const depIds: string[] = [];
        for (const depKey of step.dependsOnStepKeys ?? []) {
          const depId = taskIdByStepKey.get(depKey);
          if (!depId) throw new Error(`materializePlanGraph: dependency step key not in graph: ${depKey}`);
          depIds.push(depId);
        }
        this.db.prepare('UPDATE tasks SET dependencies_json = ?, updated_at = ? WHERE task_id = ?')
          .run(JSON.stringify(depIds), stamp, taskId);
      }

      this.insertOutboxEvent({
        version: 1,
        eventId: `evt_projection_${planId}_${params.rfcRevision?.trim() || 'unversioned'}`,
        workspace: this.workspace,
        type: 'plan.projected',
        actor: { kind: 'system', id: 'awareness-plan-projector' },
        provenance: { source: 'harness', trust: 'authority' },
        aggregate: { kind: 'plan', id: planId, ...(params.rfcRevision?.trim() ? { revision: params.rfcRevision.trim() } : {}) },
        createdAt: stamp,
        payload: { sourceKind: kind, sourcePlanKey: key, stepKeys: [...sourceStepKeys] },
      });

      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }

    // Re-fetch outside transaction
    const finalPlan = this.getPlan(planId);
    const tasks = new Map<string, Task>();
    for (const [stepKey, taskId] of taskIdByStepKey) {
      tasks.set(stepKey, this.getTask(taskId));
    }
    return { plan: finalPlan, tasks };
  }

}
