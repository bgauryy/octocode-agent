/**
 * entities.ts — the canonical coordination-entity types.
 *
 * The domain shapes for the local coordination store (plans, tasks, locks, work
 * presence, handoffs, memory, agents, messages) live here so they are defined
 * ONCE and imported by every consumer (Awareness Lite today; open to others).
 * Pure type declarations — no runtime, no dependencies.
 *
 * Note: the full `@octocodeai/octocode-awareness` package intentionally models a
 * richer, different lifecycle (e.g. task states OPEN|IN_PROGRESS|BLOCKED|VERIFY|
 * DONE|FAILED|CANCELLED, plan states DRAFT|ACTIVE|PAUSED|COMPLETED|CANCELLED).
 * Those are a distinct model and are NOT re-expressed here.
 */

export type PlanStatus = 'OPEN' | 'DONE' | 'ABANDONED';
export type TaskStatus = 'OPEN' | 'CLAIMED' | 'DONE' | 'CANCELLED';
export type CheckStatus = 'SUCCESS' | 'FAILED';
export type AgentStatus = 'ACTIVE' | 'IDLE' | 'LEFT';

export interface PruneResult {
  dryRun: boolean;
  matched: number;
  deleted: number;
  olderThan: string;
}

export interface Plan {
  planId: string;
  title: string;
  goal: string | null;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  sourceKind: string | null;
  sourceKey: string | null;
  rfcPath: string | null;
  rfcRevision: string | null;
}

export interface SourceStep {
  sourceStepKey: string;
  title: string;
  paths?: string[];
  reasoning?: string | null;
  acceptance?: string | null;
  checkCommand?: string | null;
  dependsOnStepKeys?: string[];
  priority?: number;
}

export interface Task {
  taskId: string;
  planId: string;
  title: string;
  filePath: string | null;
  paths: string[];
  reasoning: string | null;
  acceptance: string | null;
  checkCommand: string | null;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  agentId: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationMessage: string | null;
  sourceStepKey: string | null;
}

export interface PlanGraphResult {
  plan: Plan;
  tasks: Map<string, Task>;
}

export interface Lock {
  filePath: string;
  agentId: string;
  reason: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WorkPresence {
  filePath: string;
  agentId: string;
  reason: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface HandoffNote {
  handoffId: string;
  agentId: string;
  summary: string;
  files: string[];
  createdAt: string;
  clearedAt: string | null;
}

export interface CheckAudit {
  ok: boolean;
  pending: Task[];
  pendingCount: number;
  filters: {
    agentId: string | null;
    planId: string | null;
    minAgeMs: number | null;
  };
}

export interface LockWaitResult {
  ok: boolean;
  lockFree: boolean;
  filePath: string;
  waitedMs: number;
  conflict: Lock | null;
}

export interface MemoryItem {
  memoryId: string;
  label: string;
  text: string;
  tags: string[];
  createdAt: string;
  similarity?: number;
}

export interface AgentRecord {
  agentId: string;
  name: string | null;
  role: string | null;
  status: AgentStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
}

export interface LiteMessage {
  messageId: string;
  fromAgentId: string;
  toAgentId: string | null;
  topic: string | null;
  text: string;
  files: string[];
  createdAt: string;
  readAt: string | null;
}
