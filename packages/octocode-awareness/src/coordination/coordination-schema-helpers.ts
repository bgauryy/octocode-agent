import type { AgentRecord,HandoffNote,LiteMessage,Lock,MemoryItem,PlanStatus,Task,TaskStatus,WorkPresence } from '@octocodeai/octocode-shared/entities';
import { CoordinationMemoryAgents } from './coordination-memory-agents.js';
import { agentFromRow,AgentRow,cutoffIso,handoffFromRow,HandoffRow,AwarenessSchema,lockFromRow,LockRow,memoryFromRow,MemoryRow,messageFromRow,MessageRow,now,taskFromRow,TaskRow,workPresenceFromRow,WorkPresenceRow } from './coordination-shared.js';

export abstract class AwarenessSchemaHelpers extends CoordinationMemoryAgents {
  schema(): AwarenessSchema {
    return {
      entities: {
        plan: ['planId', 'title', 'goal', 'status', 'sourceKind', 'sourceKey', 'rfcPath', 'rfcRevision', 'createdAt', 'updatedAt'],
        task: ['taskId', 'planId', 'title', 'filePath', 'paths', 'reasoning', 'acceptance', 'checkCommand', 'status', 'priority', 'dependencies', 'agentId', 'claimedAt', 'leaseExpiresAt', 'doneAt', 'verifiedAt', 'verifiedBy', 'verificationMessage', 'sourceStepKey'],
        lock: ['filePath', 'agentId', 'reason', 'acquiredAt', 'expiresAt'],
        work: ['filePath', 'agentId', 'reason', 'startedAt', 'updatedAt', 'expiresAt'],
        handoff: ['handoffId', 'agentId', 'summary', 'files', 'createdAt', 'clearedAt'],
        memory: ['memoryId', 'label', 'text', 'tags', 'createdAt', 'similarity?', 'verifiedAt?', 'validUntil?', 'scope?', 'sourceDigest?', 'explanation?'],
        agent: ['agentId', 'name', 'role', 'status', 'metadata', 'createdAt', 'lastSeenAt'],
        message: ['messageId', 'fromAgentId', 'toAgentId', 'topic', 'text', 'files', 'createdAt', 'readAt'],
      },
      commands: {
        status: ['status'],
        plan: ['create --title [--goal]', 'list', 'show --plan-id', 'done --plan-id [--force]', 'abandon --plan-id --agent-id [--reason]'],
        task: ['add --plan-id --title [--file] [--path] [--depends-on] [--reasoning] [--acceptance] [--priority] [--check]', 'list [--plan-id] [--status] [--agent-id]', 'ready [--plan-id] [--limit]', 'show --task-id', 'depend --task-id --depends-on [--agent-id]', 'claim --task-id --agent-id [--lease]', 'heartbeat --task-id --agent-id [--lease]', 'release --task-id --agent-id [--blocked-reason]', 'done --task-id --agent-id', 'reopen --task-id --agent-id [--reason]'],
        lock: ['acquire --file --agent-id [--reason] [--ttl]', 'wait --file [--agent-id] [--wait] [--retry-interval]', 'prune [--confirm]', 'release --file --agent-id', 'list'],
        work: ['start --file --agent-id [--reason] [--ttl]', 'touch --file --agent-id [--reason] [--ttl]', 'list [--file] [--agent-id]', 'show --file', 'end --file --agent-id'],
        handoff: ['add --agent-id --summary [--file]', 'list [--include-cleared]', 'clear --handoff-id'],
        check: ['audit [--agent-id] [--plan-id] [--min-age]', 'mark --task-id --agent-id --message [--status SUCCESS|FAILED]'],
        memory: ['store --label --text [--tags]', 'store-verified --label --text --source-digest [--scope] [--verified-at] [--valid-until] [--importance] [--tags]', 'recall [--query] [--label] [--limit] [--semantic] [--min-similarity]', 'recall-verified [--query] [--label] [--source-digest] [--scope] [--mode lexical|semantic|hybrid] [--limit] [--now] [--min-similarity]', 'evaluate [--corpus-json] [--now] [--limit] [--min-similarity]', 'list [--limit]', 'reindex [--force] [--limit]', 'forget --memory-id', 'prune --older-than [--label] [--confirm]'],
        agent: ['join --agent-id [--name] [--role] [--meta]', 'touch --agent-id', 'leave --agent-id', 'list [--include-left] [--stale-after]'],
        message: ['send --from --text [--to] [--topic] [--file]', 'read --agent-id [--topic] [--include-read] [--limit]', 'list [--agent-id] [--topic] [--include-read] [--limit]', 'prune --older-than [--read-only] [--confirm]'],
        hooks: ['pre-edit [--agent-id] [--host] < event.json', 'install --host claude|codex|cursor [--project-dir] [--dry-run]'],
        schema: ['schema', 'schema commands', 'schema command --name <noun>', 'schema list'],
      },
    };
  }

  schemaCommand(command?: string): unknown {
    const schema = this.schema();
    if (!command || command === 'commands') return schema.commands;
    if (command === 'list') return Object.keys(schema.commands);
    const actions = schema.commands[command];
    if (!actions) throw new Error(`unknown schema command: ${command}`);
    return { command, actions };
  }

  protected listPendingChecks(params: { agentId?: string | null; planId?: string | null; minAgeMs?: number | null } = {}): Task[] {
    const clauses = ['workspace_path = ?', "status = 'DONE'", 'verified_at IS NULL'];
    const values: string[] = [this.workspace];
    if (params.agentId) {
      clauses.push('agent_id = ?');
      values.push(params.agentId);
    }
    if (params.planId) {
      clauses.push('plan_id = ?');
      values.push(params.planId);
    }
    if (params.minAgeMs && params.minAgeMs > 0) {
      clauses.push('done_at <= ?');
      values.push(cutoffIso(params.minAgeMs));
    }
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY done_at ASC, updated_at ASC`).all(...values);
    return (rows as unknown as TaskRow[]).map(taskFromRow);
  }

  protected getLock(filePath: string): Lock {
    const row = this.db.prepare('SELECT * FROM locks WHERE workspace_path = ? AND file_path = ?').get(this.workspace, filePath) as unknown as LockRow | undefined;
    if (!row) throw new Error(`lock not found: ${filePath}`);
    return lockFromRow(row);
  }

  protected getMemory(memoryId: string): MemoryItem {
    const row = this.db.prepare('SELECT * FROM memories WHERE workspace_path = ? AND memory_id = ?').get(this.workspace, memoryId) as unknown as MemoryRow | undefined;
    if (!row) throw new Error(`memory not found: ${memoryId}`);
    return memoryFromRow(row);
  }

  protected getAgent(agentId: string): AgentRecord {
    const row = this.db.prepare('SELECT * FROM agents WHERE workspace_path = ? AND agent_id = ?').get(this.workspace, agentId) as unknown as AgentRow | undefined;
    if (!row) throw new Error(`agent not found: ${agentId}`);
    return agentFromRow(row);
  }

  protected getMessage(messageId: string): LiteMessage {
    const row = this.db.prepare('SELECT m.*, NULL AS read_at FROM messages m WHERE m.workspace_path = ? AND m.message_id = ?').get(this.workspace, messageId) as unknown as MessageRow | undefined;
    if (!row) throw new Error(`message not found: ${messageId}`);
    return messageFromRow(row);
  }

  protected getWorkPresence(filePath: string, agentId: string): WorkPresence {
    const row = this.db.prepare('SELECT * FROM work_presence WHERE workspace_path = ? AND file_path = ? AND agent_id = ?').get(this.workspace, filePath, agentId) as unknown as WorkPresenceRow | undefined;
    if (!row) throw new Error(`work presence not found: ${filePath} for ${agentId}`);
    return workPresenceFromRow(row);
  }

  protected getHandoff(handoffId: string): HandoffNote {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE handoff_id = ?').get(handoffId) as unknown as HandoffRow | undefined;
    if (!row) throw new Error(`handoff not found: ${handoffId}`);
    return handoffFromRow(row);
  }

  protected pruneExpiredLocks(): void {
    this.db.prepare('DELETE FROM locks WHERE workspace_path = ? AND expires_at <= ?').run(this.workspace, now());
  }

  protected pruneExpiredWork(): void {
    this.db.prepare('DELETE FROM work_presence WHERE workspace_path = ? AND expires_at <= ?').run(this.workspace, now());
  }

  protected count(table: 'plans' | 'tasks' | 'locks' | 'work_presence' | 'memories' | 'agents' | 'messages'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_path = ?`).get(this.workspace) as { count: number };
    return row.count;
  }

  protected countActiveExpiring(table: 'locks' | 'work_presence'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_path = ? AND expires_at > ?`)
      .get(this.workspace, now()) as { count: number };
    return row.count;
  }

  protected countActiveClaimedTasks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE workspace_path = ? AND status = 'CLAIMED' AND (lease_expires_at IS NULL OR lease_expires_at > ?)")
      .get(this.workspace, now()) as { count: number };
    return row.count;
  }

  protected countPlansByStatus(status: PlanStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM plans WHERE workspace_path = ? AND status = ?').get(this.workspace, status) as { count: number };
    return row.count;
  }

  protected countTasksByStatus(status: TaskStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE workspace_path = ? AND status = ?').get(this.workspace, status) as { count: number };
    return row.count;
  }

  protected countPendingChecks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE workspace_path = ? AND status = 'DONE' AND verified_at IS NULL").get(this.workspace) as { count: number };
    return row.count;
  }

  protected countReadyTasks(): number {
    return this.listReadyTasks().length;
  }

  protected taskDependenciesSatisfied(task: Task): boolean {
    return task.dependencies.every((taskId) => {
      const dependency = this.getTask(taskId);
      return dependency.status === 'DONE' && Boolean(dependency.verifiedAt);
    });
  }

  protected assertTaskDependenciesSatisfied(task: Task): void {
    for (const taskId of task.dependencies) {
      const dependency = this.getTask(taskId);
      if (dependency.status !== 'DONE' || !dependency.verifiedAt) {
        throw new Error(`task ${task.taskId} is blocked by ${taskId}`);
      }
    }
  }

  protected evictExpiredTaskClaims(): void {
    const stamp = now();
    this.db.prepare(`UPDATE tasks SET status = 'OPEN', agent_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
      updated_at = ?, verification_message = COALESCE(verification_message, 'claim lease expired')
      WHERE workspace_path = ? AND status = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(stamp, this.workspace, stamp);
  }

  protected countOpenHandoffs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM handoffs WHERE workspace_path = ? AND cleared_at IS NULL').get(this.workspace) as { count: number };
    return row.count;
  }

  protected countStaleAgents(staleAfterMs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE workspace_path = ? AND status != 'LEFT' AND last_seen_at < ?").get(this.workspace, cutoffIso(staleAfterMs)) as { count: number };
    return row.count;
  }

  /**
   * Count present agents: joined, not LEFT, and seen within the presence window.
   * Agents have no TTL auto-prune (unlike locks/work), so a crashed agent that
   * never called leave would otherwise linger in a raw COUNT(*) forever. This is
   * the complement of countStaleAgents among non-LEFT agents.
   */
  protected countPresentAgents(staleAfterMs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE workspace_path = ? AND status != 'LEFT' AND last_seen_at >= ?").get(this.workspace, cutoffIso(staleAfterMs)) as { count: number };
    return row.count;
  }

}
