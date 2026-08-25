import type { AgentRecord,AgentStatus,CheckAudit,CheckStatus,HandoffNote,LiteMessage,Lock,LockWaitResult,MemoryItem,Plan,PlanGraphResult,PlanStatus,PruneResult,SourceStep,Task,TaskStatus,WorkPresence } from '@octocodeai/octocode-shared/entities';
import { initOctocodeSchema } from '@octocodeai/octocode-shared/schema';
import { DatabaseSync,withSqliteBusyRetry } from '@octocodeai/octocode-shared/sqlite';
import { journalModeForSqliteVersion } from '@octocodeai/octocode-shared/sqlite-version';
import { mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { defaultDbPath,type AwarenessLiteOptions,type LiteSchema } from './lite-shared.js';

export abstract class LiteBase {
  readonly workspace: string;
  readonly dbPath: string;
  protected readonly db: DatabaseSync;

  constructor(options: AwarenessLiteOptions) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.dbPath = resolve(options.dbPath ?? defaultDbPath(this.workspace));
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // busy_timeout FIRST: this package exists for parallel agents sharing one
    // DB, and without it concurrent writers hit SQLITE_BUSY immediately and
    // silently lose records (verified: 40 parallel `task add` → 9 failures).
    // 5s matches the hardened open in the full octocode-awareness package.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Version-gated journal mode (shared policy): WAL only when the embedded
    // SQLite carries the concurrent-WAL reset fix, else DELETE. Setting it is a
    // write that can race a first opener → bounded BUSY retry.
    const version = (this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    withSqliteBusyRetry(() => this.db.exec(`PRAGMA journal_mode = ${journalModeForSqliteVersion(version)}`));
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    // The store is shared (~/.octocode/octocode.sqlite3): ensure the agent/session
    // tables exist alongside Lite's own, so opening Lite in the running process
    // also initialises "our DB" for the agent. Idempotent; distinct table names.
    initOctocodeSchema(this.db);
  }

  close(): void {
    this.db.close();
  }
  abstract createPlan(params: { title: string; goal?: string | null }): Plan;
  abstract listPlans(status?: PlanStatus): Plan[];
  abstract getPlan(planId: string): Plan;
  abstract donePlan(params: { planId: string; force?: boolean }): Plan;
  abstract addTask(params: {
    planId: string;
    title: string;
    filePath?: string | null;
    paths?: string | string[] | null;
    reasoning?: string | null;
    acceptance?: string | null;
    checkCommand?: string | null;
    dependsOn?: string | string[] | null;
    priority?: number;
  }): Task;
  abstract addTaskDependency(params: { taskId: string; dependsOnTaskId: string; agentId?: string | null }): Task;
  abstract listTasks(params: { planId?: string; status?: TaskStatus; agentId?: string }): Task[];
  abstract listReadyTasks(params: { planId?: string; limit?: number }): Task[];
  abstract getTask(taskId: string): Task;
  abstract claimTask(params: { taskId: string; agentId: string; leaseSeconds?: number }): Task;
  abstract heartbeatTask(params: { taskId: string; agentId: string; leaseSeconds?: number }): Task;
  abstract releaseTask(params: { taskId: string; agentId: string; blockedReason?: string | null }): Task;
  abstract doneTask(params: { taskId: string; agentId: string }): Task;
  abstract reopenTask(params: { taskId: string; agentId: string; reason?: string | null; leaseSeconds?: number }): Task;
  abstract acquireLock(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): Lock;
  abstract listLocks(): Lock[];
  abstract waitForLock(params: { filePath: string; agentId?: string | null; waitMs?: number; retryIntervalMs?: number }): LockWaitResult;
  abstract pruneLocks(params: { dryRun?: boolean }): { dryRun: boolean; matched: number; deleted: number };
  abstract releaseLock(params: { filePath: string; agentId: string }): { released: boolean };
  abstract startWork(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): WorkPresence;
  abstract listWork(params: { filePath?: string | null; agentId?: string | null }): WorkPresence[];
  abstract showWork(params: { filePath: string }): WorkPresence[];
  abstract endWork(params: { filePath: string; agentId: string }): { ended: boolean };
  abstract addHandoff(params: { agentId: string; summary: string; files?: string | string[] | null }): HandoffNote;
  abstract listHandoffs(params: { includeCleared?: boolean }): HandoffNote[];
  abstract clearHandoff(params: { handoffId: string }): { cleared: boolean };
  abstract auditChecks(params: { agentId?: string | null; planId?: string | null; minAgeMs?: number | null }): CheckAudit;
  abstract markCheck(params: { taskId: string; agentId: string; message: string; status?: CheckStatus }): Task;
  abstract storeMemory(params: { label: string; text: string; tags?: string | string[] | null }): MemoryItem;
  protected abstract embedMemory(memoryId: string, text: string): boolean;
  abstract reindexMemories(params: { force?: boolean; limit?: number }): { enabled: boolean; scanned: number; embedded: number };
  abstract forgetMemory(params: { memoryId: string }): { forgotten: boolean };
  abstract recallMemory(params: { query?: string | null; label?: string | null; limit?: number; semantic?: boolean; minSimilarity?: number }): MemoryItem[];
  protected abstract recallSemantic(query: string, label: string | undefined, limit: number, minSimilarity: number): MemoryItem[];
  abstract pruneMemories(params: { olderThanMs: number; label?: string | null; dryRun?: boolean }): PruneResult;
  abstract joinAgent(params: { agentId: string; name?: string | null; role?: string | null; metadata?: string | Record<string, unknown> | null }): AgentRecord;
  abstract touchAgent(params: { agentId: string; status?: AgentStatus }): AgentRecord;
  abstract leaveAgent(params: { agentId: string }): AgentRecord;
  abstract listAgents(params: { includeLeft?: boolean; staleAfterMs?: number }): AgentRecord[];
  abstract sendMessage(params: { fromAgentId: string; toAgentId?: string | null; topic?: string | null; text: string; files?: string | string[] | null }): LiteMessage;
  abstract listMessages(params: { agentId?: string | null; includeRead?: boolean; topic?: string | null; limit?: number }): LiteMessage[];
  abstract markMessageRead(params: { messageId: string; agentId: string }): LiteMessage;
  abstract pruneMessages(params: { olderThanMs: number; readOnly?: boolean; dryRun?: boolean }): PruneResult;
  abstract schema(): LiteSchema;
  abstract schemaCommand(command?: string): unknown;
  protected abstract listPendingChecks(params: { agentId?: string | null; planId?: string | null; minAgeMs?: number | null }): Task[];
  protected abstract getLock(filePath: string): Lock;
  protected abstract getMemory(memoryId: string): MemoryItem;
  protected abstract getAgent(agentId: string): AgentRecord;
  protected abstract getMessage(messageId: string): LiteMessage;
  protected abstract getWorkPresence(filePath: string, agentId: string): WorkPresence;
  protected abstract getHandoff(handoffId: string): HandoffNote;
  protected abstract pruneExpiredLocks(): void;
  protected abstract pruneExpiredWork(): void;
  protected abstract count(table: 'plans' | 'tasks' | 'locks' | 'work_presence' | 'memories' | 'agents' | 'messages'): number;
  protected abstract countPlansByStatus(status: PlanStatus): number;
  protected abstract countTasksByStatus(status: TaskStatus): number;
  protected abstract countPendingChecks(): number;
  protected abstract countReadyTasks(): number;
  protected abstract taskDependenciesSatisfied(task: Task): boolean;
  protected abstract assertTaskDependenciesSatisfied(task: Task): void;
  protected abstract evictExpiredTaskClaims(): void;
  protected abstract countOpenHandoffs(): number;
  protected abstract countStaleAgents(staleAfterMs: number): number;
  protected abstract countPresentAgents(staleAfterMs: number): number;
  abstract getPlanBySourceKey(params: { sourceKind: string; sourceKey: string }): Plan | null;
  abstract reconcilePlanGraph(params: { planId: string }): Map<string, Task>;
  abstract abandonPlan(params: { planId: string; agentId: string; reason?: string | null }): { plan: Plan; cancelled: number };
  abstract materializePlanGraph(params: {
    sourcePlanKey: string;
    sourceKind?: string | null;
    title: string;
    goal?: string | null;
    rfcPath?: string | null;
    rfcRevision?: string | null;
    steps: SourceStep[];
  }): PlanGraphResult;
  protected abstract migrate(): void;
  protected abstract upgradeStatusConstraints(): void;
  protected abstract addColumnIfMissing(table: string, column: string, definition: string): void;
}
