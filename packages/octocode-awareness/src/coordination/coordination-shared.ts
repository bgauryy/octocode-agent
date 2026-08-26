import { octocodeDbPath } from '@octocodeai/octocode-shared/paths';
import { randomUUID } from 'node:crypto';

// ─── Full public surface for in-process external hosts ────────────────────────
// Hosts that embed Awareness as a library instead of spawning the `cli.js`
// bin reach every capability from this package root: the embedding helpers, the
// pre-edit lock gate, and the programmatic CLI/hook-install entrypoints.
import type {
AgentRecord,
AgentStatus,
HandoffNote,
LiteMessage,
Lock,
MemoryItem,
Plan,
PlanStatus,
Task,
TaskStatus,
WorkPresence
} from '@octocodeai/octocode-shared/entities';
export type {
AgentRecord,AgentStatus,CheckAudit,CheckStatus,HandoffNote,LiteMessage,Lock,LockWaitResult,
MemoryItem,Plan,PlanGraphResult,PlanStatus,PruneResult,SourceStep,Task,TaskStatus,WorkPresence
} from '@octocodeai/octocode-shared/entities';

export interface AwarenessOptions {
  workspace?: string;
  dbPath?: string;
}

export interface AwarenessSchema {
  entities: Record<string, string[]>;
  commands: Record<string, string[]>;
}

export interface PlanRow {
  plan_id: string;
  title: string;
  goal: string | null;
  status: PlanStatus;
  source_kind: string | null;
  source_key: string | null;
  rfc_path: string | null;
  rfc_revision: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  task_id: string;
  plan_id: string;
  title: string;
  file_path: string | null;
  paths_json?: string | null;
  reasoning?: string | null;
  acceptance?: string | null;
  check_command: string | null;
  status: TaskStatus;
  priority?: number | null;
  dependencies_json?: string | null;
  agent_id: string | null;
  claimed_at?: string | null;
  lease_expires_at?: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
  verification_message: string | null;
  source_step_key?: string | null;
}

export interface LockRow {
  file_path: string;
  agent_id: string;
  reason: string;
  acquired_at: string;
  expires_at: string;
}

export interface WorkPresenceRow {
  file_path: string;
  agent_id: string;
  reason: string;
  started_at: string;
  updated_at: string;
  expires_at: string;
}

export interface HandoffRow {
  handoff_id: string;
  agent_id: string;
  summary: string;
  files_json: string;
  created_at: string;
  cleared_at: string | null;
}

export interface MemoryRow {
  memory_id: string;
  label: string;
  text: string;
  tags_json: string;
  created_at: string;
  embedding?: Uint8Array | null;
  embedding_model?: string | null;
}

export interface AgentRow {
  agent_id: string;
  name: string | null;
  role: string | null;
  status: AgentStatus;
  metadata_json: string;
  created_at: string;
  last_seen_at: string;
}

export interface MessageRow {
  message_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  topic: string | null;
  text: string;
  files_json: string;
  created_at: string;
  read_at?: string | null;
}

export function now(): string {
  return new Date().toISOString();
}

export function cutoffIso(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs <= 0) throw new Error('age must be a positive duration');
  return new Date(Date.now() - ageMs).toISOString();
}

/**
 * Default presence window for counting "present" agents in status() when the
 * caller does not pass staleAfterMs. 30 min matches the lock/work default TTL,
 * so a crashed agent that never called leave ages out of the presence count.
 */
export const DEFAULT_AGENT_PRESENCE_MS = 30 * 60_000;

/**
 * Default cosine floor for semantic recall. 0 preserves the historical behavior
 * (keep any candidate with positive similarity) and matches the full
 * octocode-awareness search, which applies no hard floor and relies on ranking.
 * Callers that want to suppress weak matches — so a near-orthogonal vector can't
 * mask a better lexical result — pass a positive `minSimilarity` per recall.
 */
export const DEFAULT_SEMANTIC_MIN_SIMILARITY = 0;

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function required(value: string | undefined | null, name: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

/**
 * The single shared local store: `~/.octocode/octocode.sqlite3`. Repos are no
 * longer isolated by file — every row carries `workspace_path` — so all repos
 * and the agent/session tables share one file. `workspace` is retained for the
 * signature (callers pass it) but the path is global.
 */
export function defaultDbPath(_workspace: string): string {
  return octocodeDbPath();
}

export function planFromRow(row: PlanRow): Plan {
  return {
    planId: row.plan_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceKind: row.source_kind ?? null,
    sourceKey: row.source_key ?? null,
    rfcPath: row.rfc_path ?? null,
    rfcRevision: row.rfc_revision ?? null,
  };
}

export function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item).trim()).filter(Boolean);
}

export function taskFromRow(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    planId: row.plan_id,
    title: row.title,
    filePath: row.file_path,
    paths: parseStringArrayJson(row.paths_json),
    reasoning: row.reasoning ?? null,
    acceptance: row.acceptance ?? null,
    checkCommand: row.check_command,
    status: row.status,
    priority: Number(row.priority ?? 0),
    dependencies: parseStringArrayJson(row.dependencies_json),
    agentId: row.agent_id,
    claimedAt: row.claimed_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    verificationMessage: row.verification_message,
    sourceStepKey: row.source_step_key ?? null,
  };
}

export function lockFromRow(row: LockRow): Lock {
  return {
    filePath: row.file_path,
    agentId: row.agent_id,
    reason: row.reason,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

export function workPresenceFromRow(row: WorkPresenceRow): WorkPresence {
  return {
    filePath: row.file_path,
    agentId: row.agent_id,
    reason: row.reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function handoffFromRow(row: HandoffRow): HandoffNote {
  return {
    handoffId: row.handoff_id,
    agentId: row.agent_id,
    summary: row.summary,
    files: JSON.parse(row.files_json) as string[],
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
  };
}

export function memoryFromRow(row: MemoryRow): MemoryItem {
  return {
    memoryId: row.memory_id,
    label: row.label,
    text: row.text,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
  };
}

export function agentFromRow(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    name: row.name,
    role: row.role,
    status: row.status,
    metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function messageFromRow(row: MessageRow): LiteMessage {
  return {
    messageId: row.message_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    topic: row.topic,
    text: row.text,
    files: JSON.parse(row.files_json) as string[],
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
  };
}

export function parseMetadata(metadata: string | Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata !== 'string') return metadata;
  const trimmed = metadata.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export function splitTags(tags: string | string[] | undefined | null): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => tag.trim()).filter(Boolean);
  return (tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function splitFiles(files: string | string[] | undefined | null): string[] {
  if (Array.isArray(files)) return files.map((file) => file.trim()).filter(Boolean);
  return (files ?? '').split(',').map((file) => file.trim()).filter(Boolean);
}

export function sleepMs(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export function normalizeLeaseSeconds(value: number | undefined, fallback = 1800): number {
  if (!value || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), 3600);
}
