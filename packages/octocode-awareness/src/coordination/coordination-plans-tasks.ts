import type { Plan,PlanStatus,Task,TaskStatus } from '@octocodeai/octocode-shared/entities';
import { CoordinationBase } from './coordination-core.js';
import { DEFAULT_AGENT_PRESENCE_MS,id,normalizeLeaseSeconds,now,planFromRow,PlanRow,required,splitFiles,taskFromRow,TaskRow } from './coordination-shared.js';

export abstract class CoordinationPlansTasks extends CoordinationBase {
  status(params: { staleAfterMs?: number } = {}): {
    dbPath: string;
    workspace: string;
    plans: number;
    activePlans: number;
    tasks: number;
    readyTasks: number;
    inProgressTasks: number;
    pendingChecks: number;
    verifyTasks: number;
    locks: number;
    work: number;
    memories: number;
    handoffs: number;
    agents: number;
    staleAgents: number;
    messages: number;
  } {
    const pendingChecks = this.countPendingChecks();
    return {
      dbPath: this.dbPath,
      workspace: this.workspace,
      plans: this.count('plans'),
      activePlans: this.countPlansByStatus('OPEN'),
      tasks: this.count('tasks'),
      readyTasks: this.countReadyTasks(),
      inProgressTasks: this.countActiveClaimedTasks(),
      pendingChecks,
      verifyTasks: pendingChecks,
      locks: this.countActiveExpiring('locks'),
      work: this.countActiveExpiring('work_presence'),
      memories: this.count('memories'),
      handoffs: this.countOpenHandoffs(),
      agents: this.countPresentAgents(params.staleAfterMs ?? DEFAULT_AGENT_PRESENCE_MS),
      staleAgents: params.staleAfterMs ? this.countStaleAgents(params.staleAfterMs) : 0,
      messages: this.count('messages'),
    };
  }

  createPlan(params: { title: string; goal?: string | null }): Plan {
    const stamp = now();
    const planId = id('plan');
    this.db.prepare(`INSERT INTO plans(plan_id, workspace_path, title, goal, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?)`).run(planId, this.workspace, required(params.title, 'title'), params.goal?.trim() || null, stamp, stamp);
    return this.getPlan(planId);
  }

  listPlans(status?: PlanStatus): Plan[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM plans WHERE workspace_path = ? AND status = ? ORDER BY created_at ASC').all(this.workspace, status)
      : this.db.prepare('SELECT * FROM plans WHERE workspace_path = ? ORDER BY created_at ASC').all(this.workspace);
    return (rows as unknown as PlanRow[]).map(planFromRow);
  }

  getPlan(planId: string): Plan {
    const row = this.db.prepare('SELECT * FROM plans WHERE workspace_path = ? AND plan_id = ?').get(this.workspace, planId) as unknown as PlanRow | undefined;
    if (!row) throw new Error(`plan not found: ${planId}`);
    return planFromRow(row);
  }

  donePlan(params: { planId: string; force?: boolean }): Plan {
    this.getPlan(params.planId);
    if (!params.force) {
      const unfinished = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE plan_id = ? AND status NOT IN ('DONE', 'CANCELLED')").get(params.planId) as { count: number };
      if (unfinished.count > 0) throw new Error(`plan has unfinished tasks: ${params.planId}`);
      const unverified = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE plan_id = ? AND status = 'DONE' AND verified_at IS NULL").get(params.planId) as { count: number };
      if (unverified.count > 0) throw new Error(`plan has unverified tasks: ${params.planId}`);
    }
    this.db.prepare("UPDATE plans SET status = 'DONE', updated_at = ? WHERE plan_id = ?").run(now(), params.planId);
    return this.getPlan(params.planId);
  }

  addTask(params: {
    planId: string;
    title: string;
    filePath?: string | null;
    paths?: string | string[] | null;
    reasoning?: string | null;
    acceptance?: string | null;
    checkCommand?: string | null;
    dependsOn?: string | string[] | null;
    priority?: number;
  }): Task {
    this.getPlan(params.planId);
    const stamp = now();
    const taskId = id('task');
    const paths = splitFiles(params.paths);
    const fallbackPath = params.filePath?.trim() || null;
    const allPaths = paths.length > 0 ? paths : (fallbackPath ? [fallbackPath] : []);
    const filePath = fallbackPath ?? allPaths[0] ?? null;
    const dependencies = splitFiles(params.dependsOn);
    this.db.prepare(`INSERT INTO tasks(task_id, workspace_path, plan_id, title, file_path, paths_json, reasoning, acceptance, check_command, status, priority, dependencies_json, agent_id, claimed_at, lease_expires_at, created_at, updated_at, done_at, verified_at, verified_by, verification_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`).run(
        taskId,
        this.workspace,
        params.planId,
        required(params.title, 'title'),
        filePath,
        JSON.stringify(allPaths),
        params.reasoning?.trim() || null,
        params.acceptance?.trim() || null,
        params.checkCommand?.trim() || null,
        Math.trunc(params.priority ?? 0),
        JSON.stringify(dependencies),
        stamp,
        stamp,
      );
    return this.getTask(taskId);
  }

  addTaskDependency(params: { taskId: string; dependsOnTaskId: string; agentId?: string | null }): Task {
    const task = this.getTask(params.taskId);
    const dependsOn = this.getTask(params.dependsOnTaskId);
    if (task.planId !== dependsOn.planId) throw new Error('task dependencies must stay within one plan');
    if (task.taskId === dependsOn.taskId) throw new Error('task cannot depend on itself');
    const dependencies = [...new Set([...task.dependencies, dependsOn.taskId])];
    this.db.prepare('UPDATE tasks SET dependencies_json = ?, updated_at = ? WHERE task_id = ?')
      .run(JSON.stringify(dependencies), now(), task.taskId);
    return this.getTask(task.taskId);
  }

  listTasks(params: { planId?: string; status?: TaskStatus; agentId?: string } = {}): Task[] {
    const clauses: string[] = ['workspace_path = ?'];
    const values: string[] = [this.workspace];
    if (params.planId) {
      clauses.push('plan_id = ?');
      values.push(params.planId);
    }
    const where = ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM tasks${where} ORDER BY priority DESC, created_at ASC`).all(...values);
    const stamp = now();
    return (rows as unknown as TaskRow[])
      .map(taskFromRow)
      .map((task): Task => task.status === 'CLAIMED' && task.leaseExpiresAt && task.leaseExpiresAt <= stamp
        ? { ...task, status: 'OPEN', agentId: null, claimedAt: null, leaseExpiresAt: null }
        : task)
      .filter((task) => !params.status || task.status === params.status)
      .filter((task) => !params.agentId || task.agentId === params.agentId);
  }

  listReadyTasks(params: { planId?: string; limit?: number } = {}): Task[] {
    return this.listTasks({ planId: params.planId, status: 'OPEN' })
      .filter((task) => this.taskDependenciesSatisfied(task))
      .slice(0, Math.min(Math.max(params.limit ?? 100, 1), 500));
  }

  getTask(taskId: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE workspace_path = ? AND task_id = ?').get(this.workspace, taskId) as unknown as TaskRow | undefined;
    if (!row) throw new Error(`task not found: ${taskId}`);
    return taskFromRow(row);
  }

  claimTask(params: { taskId: string; agentId: string; leaseSeconds?: number }): Task {
    this.evictExpiredTaskClaims();
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.status === 'DONE') throw new Error(`task already done: ${params.taskId}`);
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    this.assertTaskDependenciesSatisfied(task);
    const stamp = now();
    const expiresAt = new Date(Date.now() + normalizeLeaseSeconds(params.leaseSeconds) * 1000).toISOString();
    this.db.prepare("UPDATE tasks SET status = 'CLAIMED', agent_id = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
      .run(agentId, stamp, expiresAt, stamp, params.taskId);
    return this.getTask(params.taskId);
  }

  heartbeatTask(params: { taskId: string; agentId: string; leaseSeconds?: number }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.status !== 'CLAIMED' || task.agentId !== agentId) throw new Error(`task ${params.taskId} is not claimed by ${agentId}`);
    const stamp = now();
    const expiresAt = new Date(Date.now() + normalizeLeaseSeconds(params.leaseSeconds) * 1000).toISOString();
    this.db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE task_id = ?').run(expiresAt, stamp, params.taskId);
    return this.getTask(params.taskId);
  }

  releaseTask(params: { taskId: string; agentId: string; blockedReason?: string | null }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    this.db.prepare(`UPDATE tasks SET status = 'OPEN', agent_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
      updated_at = ?, verification_message = ? WHERE task_id = ?`)
      .run(now(), params.blockedReason?.trim() || null, params.taskId);
    return this.getTask(params.taskId);
  }

  doneTask(params: { taskId: string; agentId: string }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    const stamp = now();
    this.db.prepare("UPDATE tasks SET status = 'DONE', agent_id = ?, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?, done_at = ? WHERE task_id = ?")
      .run(agentId, stamp, stamp, params.taskId);
    return this.getTask(params.taskId);
  }

  reopenTask(params: { taskId: string; agentId: string; reason?: string | null; leaseSeconds?: number }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    const stamp = now();
    const expiresAt = new Date(Date.now() + normalizeLeaseSeconds(params.leaseSeconds) * 1000).toISOString();
    this.db.prepare(`UPDATE tasks SET status = 'CLAIMED', agent_id = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?, done_at = NULL,
      verified_at = NULL, verified_by = NULL, verification_message = ? WHERE task_id = ?`)
      .run(agentId, stamp, expiresAt, stamp, params.reason?.trim() || null, params.taskId);
    return this.getTask(params.taskId);
  }

}
