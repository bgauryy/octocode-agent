import type { CheckAudit,CheckStatus,HandoffNote,Lock,LockWaitResult,Task,WorkPresence } from '@octocodeai/octocode-shared/entities';
import { resolve } from 'node:path';
import { CoordinationPlansTasks } from './coordination-plans-tasks.js';
import { handoffFromRow,HandoffRow,id,lockFromRow,LockRow,now,required,sleepMs,splitFiles,workPresenceFromRow,WorkPresenceRow } from './coordination-shared.js';

export abstract class CoordinationState extends CoordinationPlansTasks {
  acquireLock(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): Lock {
    this.pruneExpiredLocks();
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const existing = this.db.prepare('SELECT * FROM locks WHERE workspace_path = ? AND file_path = ?').get(this.workspace, filePath) as unknown as LockRow | undefined;
    if (existing && existing.agent_id !== agentId) throw new Error(`lock conflict on ${filePath}: held by ${existing.agent_id}`);
    const acquiredAt = now();
    const ttlSeconds = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : 1800;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO locks(workspace_path, file_path, agent_id, reason, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_path, file_path) DO UPDATE SET agent_id = excluded.agent_id, reason = excluded.reason,
        acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`).run(
          this.workspace,
          filePath,
          agentId,
          params.reason?.trim() || 'lock',
          acquiredAt,
          expiresAt,
        );
    return this.getLock(filePath);
  }

  listLocks(): Lock[] {
    const rows = this.db.prepare('SELECT * FROM locks WHERE workspace_path = ? AND expires_at > ? ORDER BY file_path ASC')
      .all(this.workspace, now()) as unknown as LockRow[];
    return rows.map(lockFromRow);
  }

  waitForLock(params: { filePath: string; agentId?: string | null; waitMs?: number; retryIntervalMs?: number }): LockWaitResult {
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = params.agentId?.trim() || null;
    const waitMs = Math.max(0, Math.floor(params.waitMs ?? 0));
    const retryIntervalMs = Math.min(Math.max(Math.floor(params.retryIntervalMs ?? 250), 25), 5000);
    const start = Date.now();
    for (;;) {
      const row = this.db.prepare('SELECT * FROM locks WHERE workspace_path = ? AND file_path = ? AND expires_at > ?')
        .get(this.workspace, filePath, now()) as unknown as LockRow | undefined;
      const conflict = row && row.agent_id !== agentId ? lockFromRow(row) : null;
      if (!conflict) return { ok: true, lockFree: true, filePath, waitedMs: Date.now() - start, conflict: null };
      if (Date.now() - start >= waitMs) return { ok: false, lockFree: false, filePath, waitedMs: Date.now() - start, conflict };
      sleepMs(Math.min(retryIntervalMs, Math.max(0, waitMs - (Date.now() - start))));
    }
  }

  pruneLocks(params: { dryRun?: boolean } = {}): { dryRun: boolean; matched: number; deleted: number } {
    const stamp = now();
    const matched = (this.db.prepare('SELECT COUNT(*) AS count FROM locks WHERE workspace_path = ? AND expires_at <= ?').get(this.workspace, stamp) as { count: number }).count;
    const dryRun = params.dryRun !== false;
    if (!dryRun && matched > 0) this.db.prepare('DELETE FROM locks WHERE workspace_path = ? AND expires_at <= ?').run(this.workspace, stamp);
    return { dryRun, matched, deleted: dryRun ? 0 : matched };
  }

  releaseLock(params: { filePath: string; agentId: string }): { released: boolean } {
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const lock = this.db.prepare('SELECT * FROM locks WHERE workspace_path = ? AND file_path = ?').get(this.workspace, filePath) as unknown as LockRow | undefined;
    if (!lock) return { released: false };
    if (lock.agent_id !== agentId) throw new Error(`lock on ${filePath} belongs to ${lock.agent_id}`);
    this.db.prepare('DELETE FROM locks WHERE workspace_path = ? AND file_path = ?').run(this.workspace, filePath);
    return { released: true };
  }

  startWork(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): WorkPresence {
    this.pruneExpiredWork();
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const stamp = now();
    const ttlSeconds = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : 1800;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO work_presence(workspace_path, file_path, agent_id, reason, started_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_path, file_path, agent_id) DO UPDATE SET reason = excluded.reason,
        updated_at = excluded.updated_at, expires_at = excluded.expires_at`).run(
          this.workspace,
          filePath,
          agentId,
          params.reason?.trim() || 'working',
          stamp,
          stamp,
          expiresAt,
        );
    return this.getWorkPresence(filePath, agentId);
  }

  listWork(params: { filePath?: string | null; agentId?: string | null } = {}): WorkPresence[] {
    const clauses: string[] = ['workspace_path = ?', 'expires_at > ?'];
    const values: string[] = [this.workspace, now()];
    if (params.filePath) {
      clauses.push('file_path = ?');
      values.push(resolve(this.workspace, params.filePath));
    }
    if (params.agentId) {
      clauses.push('agent_id = ?');
      values.push(params.agentId);
    }
    const where = ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM work_presence${where} ORDER BY file_path ASC, agent_id ASC`).all(...values) as unknown as WorkPresenceRow[];
    return rows.map(workPresenceFromRow);
  }

  showWork(params: { filePath: string }): WorkPresence[] {
    return this.listWork({ filePath: required(params.filePath, 'file') });
  }

  endWork(params: { filePath: string; agentId: string }): { ended: boolean } {
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const result = this.db.prepare('DELETE FROM work_presence WHERE workspace_path = ? AND file_path = ? AND agent_id = ?').run(this.workspace, filePath, agentId);
    return { ended: result.changes > 0 };
  }

  addHandoff(params: { agentId: string; summary: string; files?: string | string[] | null }): HandoffNote {
    const stamp = now();
    const handoffId = id('handoff');
    this.db.prepare('INSERT INTO handoffs(handoff_id, workspace_path, agent_id, summary, files_json, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(handoffId, this.workspace, required(params.agentId, 'agent-id'), required(params.summary, 'summary'), JSON.stringify(splitFiles(params.files)), stamp);
    return this.getHandoff(handoffId);
  }

  listHandoffs(params: { includeCleared?: boolean } = {}): HandoffNote[] {
    const rows = params.includeCleared
      ? this.db.prepare('SELECT * FROM handoffs WHERE workspace_path = ? ORDER BY created_at DESC').all(this.workspace)
      : this.db.prepare('SELECT * FROM handoffs WHERE workspace_path = ? AND cleared_at IS NULL ORDER BY created_at DESC').all(this.workspace);
    return (rows as unknown as HandoffRow[]).map(handoffFromRow);
  }

  clearHandoff(params: { handoffId: string }): { cleared: boolean } {
    const result = this.db.prepare('UPDATE handoffs SET cleared_at = ? WHERE handoff_id = ? AND cleared_at IS NULL')
      .run(now(), required(params.handoffId, 'handoff-id'));
    return { cleared: result.changes > 0 };
  }

  auditChecks(params: { agentId?: string | null; planId?: string | null; minAgeMs?: number | null } = {}): CheckAudit {
    const pending = this.listPendingChecks(params);
    return {
      ok: pending.length === 0,
      pending,
      pendingCount: pending.length,
      filters: {
        agentId: params.agentId?.trim() || null,
        planId: params.planId?.trim() || null,
        minAgeMs: params.minAgeMs ?? null,
      },
    };
  }

  markCheck(params: { taskId: string; agentId: string; message: string; status?: CheckStatus }): Task {
    const task = this.getTask(params.taskId);
    if (task.status !== 'DONE') throw new Error(`task is not done: ${params.taskId}`);
    const agentId = required(params.agentId, 'agent-id');
    const message = required(params.message, 'message');
    if (params.status === 'FAILED') {
      return this.reopenTask({ taskId: params.taskId, agentId, reason: message });
    }
    const stamp = now();
    this.db.prepare('UPDATE tasks SET verified_at = ?, verified_by = ?, verification_message = ?, updated_at = ? WHERE task_id = ?')
      .run(stamp, agentId, message, stamp, params.taskId);
    return this.getTask(params.taskId);
  }

}
