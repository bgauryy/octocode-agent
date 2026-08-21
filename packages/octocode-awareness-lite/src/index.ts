import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PlanStatus = 'OPEN' | 'DONE';
export type TaskStatus = 'OPEN' | 'CLAIMED' | 'DONE';

export interface AwarenessLiteOptions {
  workspace?: string;
  dbPath?: string;
}

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
}

export interface Task {
  taskId: string;
  planId: string;
  title: string;
  filePath: string | null;
  checkCommand: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationMessage: string | null;
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
}

export interface MemoryItem {
  memoryId: string;
  label: string;
  text: string;
  tags: string[];
  createdAt: string;
}

export type AgentStatus = 'ACTIVE' | 'IDLE' | 'LEFT';

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

export interface LiteSchema {
  entities: Record<string, string[]>;
  commands: Record<string, string[]>;
}

interface PlanRow {
  plan_id: string;
  title: string;
  goal: string | null;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  task_id: string;
  plan_id: string;
  title: string;
  file_path: string | null;
  check_command: string | null;
  status: TaskStatus;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
  verification_message: string | null;
}

interface LockRow {
  file_path: string;
  agent_id: string;
  reason: string;
  acquired_at: string;
  expires_at: string;
}

interface WorkPresenceRow {
  file_path: string;
  agent_id: string;
  reason: string;
  started_at: string;
  updated_at: string;
  expires_at: string;
}

interface HandoffRow {
  handoff_id: string;
  agent_id: string;
  summary: string;
  files_json: string;
  created_at: string;
  cleared_at: string | null;
}

interface MemoryRow {
  memory_id: string;
  label: string;
  text: string;
  tags_json: string;
  created_at: string;
}

interface AgentRow {
  agent_id: string;
  name: string | null;
  role: string | null;
  status: AgentStatus;
  metadata_json: string;
  created_at: string;
  last_seen_at: string;
}

interface MessageRow {
  message_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  topic: string | null;
  text: string;
  files_json: string;
  created_at: string;
  read_at?: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function cutoffIso(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs <= 0) throw new Error('age must be a positive duration');
  return new Date(Date.now() - ageMs).toISOString();
}

/**
 * Default presence window for counting "present" agents in status() when the
 * caller does not pass staleAfterMs. 30 min matches the lock/work default TTL,
 * so a crashed agent that never called leave ages out of the presence count.
 */
const DEFAULT_AGENT_PRESENCE_MS = 30 * 60_000;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function required(value: string | undefined | null, name: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function defaultDbPath(workspace: string): string {
  return resolve(workspace, '.octocode-lite', 'awareness-lite.sqlite3');
}

function planFromRow(row: PlanRow): Plan {
  return {
    planId: row.plan_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    planId: row.plan_id,
    title: row.title,
    filePath: row.file_path,
    checkCommand: row.check_command,
    status: row.status,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    verificationMessage: row.verification_message,
  };
}

function lockFromRow(row: LockRow): Lock {
  return {
    filePath: row.file_path,
    agentId: row.agent_id,
    reason: row.reason,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function workPresenceFromRow(row: WorkPresenceRow): WorkPresence {
  return {
    filePath: row.file_path,
    agentId: row.agent_id,
    reason: row.reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function handoffFromRow(row: HandoffRow): HandoffNote {
  return {
    handoffId: row.handoff_id,
    agentId: row.agent_id,
    summary: row.summary,
    files: JSON.parse(row.files_json) as string[],
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
  };
}

function memoryFromRow(row: MemoryRow): MemoryItem {
  return {
    memoryId: row.memory_id,
    label: row.label,
    text: row.text,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
  };
}

function agentFromRow(row: AgentRow): AgentRecord {
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

function messageFromRow(row: MessageRow): LiteMessage {
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

function parseMetadata(metadata: string | Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata !== 'string') return metadata;
  const trimmed = metadata.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function splitTags(tags: string | string[] | undefined | null): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => tag.trim()).filter(Boolean);
  return (tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function splitFiles(files: string | string[] | undefined | null): string[] {
  if (Array.isArray(files)) return files.map((file) => file.trim()).filter(Boolean);
  return (files ?? '').split(',').map((file) => file.trim()).filter(Boolean);
}

// ─── Agent naming ─────────────────────────────────────────────────────────────

/** Compact funny codename pool (sea creature × scientist, mirrors the harness pool). */
const AGENT_NAME_POOL = [
  'squidJobs', 'inkstein', 'octoDarwin', 'jellyTorvalds', 'calamariCurie',
  'crabBohr', 'seahorseHopper', 'lobsterLovelace', 'morayTuring', 'shellKnuth',
  'stingraySagan', 'blobfishBabbage', 'cuttlefishCook', 'narwhalKnuth', 'pinchyPauli',
  'eelCerf', 'snappyCopernicus', 'mantaGates', 'zappyTesla', 'starfishStallman',
] as const;

export type AgentHost =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'opencode'
  | 'vscode'
  | 'zed'
  | 'jetbrains'
  | 'octo'
  | 'agent';

/** Name tag per host — recognizable runner, sea pun where it writes itself. */
const HOST_NAME_TAG: Record<AgentHost, string> = {
  claude: 'clawde',
  cursor: 'cursea',
  codex: 'codex',
  opencode: 'opencode',
  vscode: 'vscode',
  zed: 'zed',
  jetbrains: 'jetbrains',
  octo: 'octo',
  agent: 'agent',
};

/**
 * Detect the running host from the environment so generated agent names tell
 * you WHICH runner joined the shared registry. `OCTOCODE_AGENT_HOST` wins (the
 * Octocode harness sets it, so its sessions tag 'octo' even when launched from
 * a Claude Code or Cursor terminal whose env vars are inherited). Recognition
 * is best-effort: only tag a host on a reliable signal; anything unrecognized
 * falls back to the generic 'agent' (never a wrong guess). Kept in sync by eye
 * with the harness copy in @octocodeai/pi-extension `agentNames.ts`.
 */
export function detectAgentHost(env: NodeJS.ProcessEnv = process.env): AgentHost {
  const override = String(env['OCTOCODE_AGENT_HOST'] ?? '').toLowerCase();
  if (override === 'octocode' || override === 'octocode-agent') return 'octo';
  if (Object.prototype.hasOwnProperty.call(HOST_NAME_TAG, override)) return override as AgentHost;

  // Agent CLIs (checked before terminal/IDE signals, which forks also set).
  if (env['CLAUDECODE'] || env['CLAUDE_CODE_ENTRYPOINT']) return 'claude';
  if (env['CURSOR_TRACE_ID'] || env['CURSOR_AGENT']) return 'cursor';
  if (env['CODEX_THREAD_ID'] || env['CODEX_SANDBOX']) return 'codex';
  if (env['OPENCODE'] || env['OPENCODE_CONFIG'] || env['OPENCODE_BIN_PATH']) return 'opencode';
  // IDEs with a distinguishable terminal signal.
  if (env['ZED_TERM']) return 'zed';
  if (String(env['TERMINAL_EMULATOR'] ?? '').includes('JetBrains')) return 'jetbrains';
  if (env['TERM_PROGRAM'] === 'vscode') return 'vscode';
  return 'agent';
}

/**
 * A funny, host-tagged agent name, e.g. `clawde-squidJobs` (Claude Code),
 * `cursea-crabBohr` (Cursor), `octo-inkstein` (Octocode harness). Used as the
 * default when `agent join` is called without --name so a registry shared by
 * several runners stays legible at a glance.
 */
export function generateAgentName(env: NodeJS.ProcessEnv = process.env): string {
  const funny = AGENT_NAME_POOL[Math.floor(Math.random() * AGENT_NAME_POOL.length)];
  return `${HOST_NAME_TAG[detectAgentHost(env)]}-${funny}`;
}

export class AwarenessLite {
  readonly workspace: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(options: AwarenessLiteOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.dbPath = resolve(options.dbPath ?? defaultDbPath(this.workspace));
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // busy_timeout FIRST: this package exists for parallel agents sharing one
    // DB, and without it concurrent writers hit SQLITE_BUSY immediately and
    // silently lose records (verified: 40 parallel `task add` → 9 failures).
    // 5s matches the hardened open in the full octocode-awareness package.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

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
    this.pruneExpiredLocks();
    this.pruneExpiredWork();
    const pendingChecks = this.countPendingChecks();
    return {
      dbPath: this.dbPath,
      workspace: this.workspace,
      plans: this.count('plans'),
      activePlans: this.countPlansByStatus('OPEN'),
      tasks: this.count('tasks'),
      readyTasks: this.countTasksByStatus('OPEN'),
      inProgressTasks: this.countTasksByStatus('CLAIMED'),
      pendingChecks,
      verifyTasks: pendingChecks,
      locks: this.count('locks'),
      work: this.count('work_presence'),
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
    this.db.prepare(`INSERT INTO plans(plan_id, title, goal, status, created_at, updated_at)
      VALUES (?, ?, ?, 'OPEN', ?, ?)`).run(planId, required(params.title, 'title'), params.goal?.trim() || null, stamp, stamp);
    return this.getPlan(planId);
  }

  listPlans(status?: PlanStatus): Plan[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY created_at ASC').all(status)
      : this.db.prepare('SELECT * FROM plans ORDER BY created_at ASC').all();
    return (rows as unknown as PlanRow[]).map(planFromRow);
  }

  getPlan(planId: string): Plan {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as unknown as PlanRow | undefined;
    if (!row) throw new Error(`plan not found: ${planId}`);
    return planFromRow(row);
  }

  donePlan(params: { planId: string; force?: boolean }): Plan {
    this.getPlan(params.planId);
    if (!params.force) {
      const unfinished = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE plan_id = ? AND status != 'DONE'").get(params.planId) as { count: number };
      if (unfinished.count > 0) throw new Error(`plan has unfinished tasks: ${params.planId}`);
      const unverified = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE plan_id = ? AND status = 'DONE' AND verified_at IS NULL").get(params.planId) as { count: number };
      if (unverified.count > 0) throw new Error(`plan has unverified tasks: ${params.planId}`);
    }
    this.db.prepare("UPDATE plans SET status = 'DONE', updated_at = ? WHERE plan_id = ?").run(now(), params.planId);
    return this.getPlan(params.planId);
  }

  addTask(params: { planId: string; title: string; filePath?: string | null; checkCommand?: string | null }): Task {
    this.getPlan(params.planId);
    const stamp = now();
    const taskId = id('task');
    this.db.prepare(`INSERT INTO tasks(task_id, plan_id, title, file_path, check_command, status, agent_id, created_at, updated_at, done_at, verified_at, verified_by, verification_message)
      VALUES (?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?, NULL, NULL, NULL, NULL)`).run(
        taskId,
        params.planId,
        required(params.title, 'title'),
        params.filePath?.trim() || null,
        params.checkCommand?.trim() || null,
        stamp,
        stamp,
      );
    return this.getTask(taskId);
  }

  listTasks(params: { planId?: string; status?: TaskStatus } = {}): Task[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (params.planId) {
      clauses.push('plan_id = ?');
      values.push(params.planId);
    }
    if (params.status) {
      clauses.push('status = ?');
      values.push(params.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC`).all(...values);
    return (rows as unknown as TaskRow[]).map(taskFromRow);
  }

  getTask(taskId: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) throw new Error(`task not found: ${taskId}`);
    return taskFromRow(row);
  }

  claimTask(params: { taskId: string; agentId: string }): Task {
    const task = this.getTask(params.taskId);
    if (task.status === 'DONE') throw new Error(`task already done: ${params.taskId}`);
    if (task.agentId && task.agentId !== params.agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    this.db.prepare("UPDATE tasks SET status = 'CLAIMED', agent_id = ?, updated_at = ? WHERE task_id = ?")
      .run(required(params.agentId, 'agent-id'), now(), params.taskId);
    return this.getTask(params.taskId);
  }

  doneTask(params: { taskId: string; agentId: string }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    const stamp = now();
    this.db.prepare("UPDATE tasks SET status = 'DONE', agent_id = ?, updated_at = ?, done_at = ? WHERE task_id = ?")
      .run(agentId, stamp, stamp, params.taskId);
    return this.getTask(params.taskId);
  }

  reopenTask(params: { taskId: string; agentId: string; reason?: string | null }): Task {
    const task = this.getTask(params.taskId);
    const agentId = required(params.agentId, 'agent-id');
    if (task.agentId && task.agentId !== agentId) throw new Error(`task ${params.taskId} belongs to ${task.agentId}`);
    const stamp = now();
    this.db.prepare(`UPDATE tasks SET status = 'CLAIMED', agent_id = ?, updated_at = ?, done_at = NULL,
      verified_at = NULL, verified_by = NULL, verification_message = ? WHERE task_id = ?`)
      .run(agentId, stamp, params.reason?.trim() || null, params.taskId);
    return this.getTask(params.taskId);
  }

  acquireLock(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): Lock {
    this.pruneExpiredLocks();
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const existing = this.db.prepare('SELECT * FROM locks WHERE file_path = ?').get(filePath) as unknown as LockRow | undefined;
    if (existing && existing.agent_id !== agentId) throw new Error(`lock conflict on ${filePath}: held by ${existing.agent_id}`);
    const acquiredAt = now();
    const ttlSeconds = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : 1800;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO locks(file_path, agent_id, reason, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET agent_id = excluded.agent_id, reason = excluded.reason,
        acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`).run(
          filePath,
          agentId,
          params.reason?.trim() || 'lock',
          acquiredAt,
          expiresAt,
        );
    return this.getLock(filePath);
  }

  listLocks(): Lock[] {
    this.pruneExpiredLocks();
    const rows = this.db.prepare('SELECT * FROM locks ORDER BY file_path ASC').all() as unknown as LockRow[];
    return rows.map(lockFromRow);
  }

  releaseLock(params: { filePath: string; agentId: string }): { released: boolean } {
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const lock = this.db.prepare('SELECT * FROM locks WHERE file_path = ?').get(filePath) as unknown as LockRow | undefined;
    if (!lock) return { released: false };
    if (lock.agent_id !== agentId) throw new Error(`lock on ${filePath} belongs to ${lock.agent_id}`);
    this.db.prepare('DELETE FROM locks WHERE file_path = ?').run(filePath);
    return { released: true };
  }

  startWork(params: { filePath: string; agentId: string; reason?: string | null; ttlSeconds?: number }): WorkPresence {
    this.pruneExpiredWork();
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const stamp = now();
    const ttlSeconds = params.ttlSeconds && params.ttlSeconds > 0 ? params.ttlSeconds : 1800;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO work_presence(file_path, agent_id, reason, started_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, agent_id) DO UPDATE SET reason = excluded.reason,
        updated_at = excluded.updated_at, expires_at = excluded.expires_at`).run(
          filePath,
          agentId,
          params.reason?.trim() || 'working',
          stamp,
          stamp,
          expiresAt,
        );
    return this.getWorkPresence(filePath, agentId);
  }

  listWork(): WorkPresence[] {
    this.pruneExpiredWork();
    const rows = this.db.prepare('SELECT * FROM work_presence ORDER BY file_path ASC, agent_id ASC').all() as unknown as WorkPresenceRow[];
    return rows.map(workPresenceFromRow);
  }

  endWork(params: { filePath: string; agentId: string }): { ended: boolean } {
    const filePath = resolve(this.workspace, required(params.filePath, 'file'));
    const agentId = required(params.agentId, 'agent-id');
    const result = this.db.prepare('DELETE FROM work_presence WHERE file_path = ? AND agent_id = ?').run(filePath, agentId);
    return { ended: result.changes > 0 };
  }

  addHandoff(params: { agentId: string; summary: string; files?: string | string[] | null }): HandoffNote {
    const stamp = now();
    const handoffId = id('handoff');
    this.db.prepare('INSERT INTO handoffs(handoff_id, agent_id, summary, files_json, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(handoffId, required(params.agentId, 'agent-id'), required(params.summary, 'summary'), JSON.stringify(splitFiles(params.files)), stamp);
    return this.getHandoff(handoffId);
  }

  listHandoffs(params: { includeCleared?: boolean } = {}): HandoffNote[] {
    const rows = params.includeCleared
      ? this.db.prepare('SELECT * FROM handoffs ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM handoffs WHERE cleared_at IS NULL ORDER BY created_at DESC').all();
    return (rows as unknown as HandoffRow[]).map(handoffFromRow);
  }

  clearHandoff(params: { handoffId: string }): { cleared: boolean } {
    const result = this.db.prepare('UPDATE handoffs SET cleared_at = ? WHERE handoff_id = ? AND cleared_at IS NULL')
      .run(now(), required(params.handoffId, 'handoff-id'));
    return { cleared: result.changes > 0 };
  }

  auditChecks(): CheckAudit {
    const pending = this.listPendingChecks();
    return { ok: pending.length === 0, pending, pendingCount: pending.length };
  }

  markCheck(params: { taskId: string; agentId: string; message: string }): Task {
    const task = this.getTask(params.taskId);
    if (task.status !== 'DONE') throw new Error(`task is not done: ${params.taskId}`);
    const stamp = now();
    this.db.prepare('UPDATE tasks SET verified_at = ?, verified_by = ?, verification_message = ?, updated_at = ? WHERE task_id = ?')
      .run(stamp, required(params.agentId, 'agent-id'), required(params.message, 'message'), stamp, params.taskId);
    return this.getTask(params.taskId);
  }

  storeMemory(params: { label: string; text: string; tags?: string | string[] | null }): MemoryItem {
    const stamp = now();
    const memoryId = id('mem');
    this.db.prepare('INSERT INTO memories(memory_id, label, text, tags_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(memoryId, required(params.label, 'label'), required(params.text, 'text'), JSON.stringify(splitTags(params.tags)), stamp);
    return this.getMemory(memoryId);
  }

  forgetMemory(params: { memoryId: string }): { forgotten: boolean } {
    const result = this.db.prepare('DELETE FROM memories WHERE memory_id = ?').run(required(params.memoryId, 'memory-id'));
    return { forgotten: result.changes > 0 };
  }

  recallMemory(params: { query?: string | null; label?: string | null; limit?: number } = {}): MemoryItem[] {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const query = params.query?.trim();
    const label = params.label?.trim();
    const clauses: string[] = [];
    const values: string[] = [];
    if (query) {
      clauses.push('(text LIKE ? OR tags_json LIKE ? OR label LIKE ?)');
      const like = `%${query}%`;
      values.push(like, like, like);
    }
    if (label) {
      clauses.push('label = ?');
      values.push(label);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM memories${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
    return (rows as unknown as MemoryRow[]).map(memoryFromRow);
  }

  pruneMemories(params: { olderThanMs: number; label?: string | null; dryRun?: boolean }): PruneResult {
    const olderThan = cutoffIso(params.olderThanMs);
    const label = params.label?.trim();
    const clauses = ['created_at < ?'];
    const values: string[] = [olderThan];
    if (label) {
      clauses.push('label = ?');
      values.push(label);
    }
    const where = clauses.join(' AND ');
    const matched = (this.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where}`).get(...values) as { count: number }).count;
    const dryRun = params.dryRun !== false;
    if (!dryRun && matched > 0) this.db.prepare(`DELETE FROM memories WHERE ${where}`).run(...values);
    return { dryRun, matched, deleted: dryRun ? 0 : matched, olderThan };
  }

  joinAgent(params: { agentId: string; name?: string | null; role?: string | null; metadata?: string | Record<string, unknown> | null }): AgentRecord {
    const stamp = now();
    const agentId = required(params.agentId, 'agent-id');
    const existing = this.db.prepare('SELECT name, metadata_json FROM agents WHERE agent_id = ?').get(agentId) as { name: string | null; metadata_json: string } | undefined;
    const metadataJson = params.metadata === undefined && existing ? existing.metadata_json : JSON.stringify(parseMetadata(params.metadata));
    // No explicit name and no remembered one → default to a funny host-tagged
    // codename (clawde-squidJobs / cursea-crabBohr / octo-inkstein) so a shared
    // registry shows WHO is running WHERE. Re-joins keep their existing name
    // (null routes through the COALESCE below).
    const name = params.name?.trim() || (existing?.name ? null : generateAgentName());
    this.db.prepare(`INSERT INTO agents(agent_id, name, role, status, metadata_json, created_at, last_seen_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET name = COALESCE(excluded.name, agents.name),
        role = COALESCE(excluded.role, agents.role), status = 'ACTIVE', metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at`).run(
          agentId,
          name,
          params.role?.trim() || null,
          metadataJson,
          stamp,
          stamp,
        );
    return this.getAgent(agentId);
  }

  touchAgent(params: { agentId: string; status?: AgentStatus }): AgentRecord {
    const agentId = required(params.agentId, 'agent-id');
    const status = params.status ?? 'ACTIVE';
    const existing = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as unknown as AgentRow | undefined;
    if (!existing) {
      this.joinAgent({ agentId });
      if (status === 'ACTIVE') return this.getAgent(agentId);
    }
    this.db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE agent_id = ?')
      .run(status, now(), agentId);
    return this.getAgent(agentId);
  }

  leaveAgent(params: { agentId: string }): AgentRecord {
    return this.touchAgent({ agentId: params.agentId, status: 'LEFT' });
  }

  listAgents(params: { includeLeft?: boolean; staleAfterMs?: number } = {}): AgentRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (!params.includeLeft || params.staleAfterMs) clauses.push("status != 'LEFT'");
    if (params.staleAfterMs) {
      clauses.push('last_seen_at < ?');
      values.push(cutoffIso(params.staleAfterMs));
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM agents${where} ORDER BY last_seen_at DESC, agent_id ASC`).all(...values);
    return (rows as unknown as AgentRow[]).map(agentFromRow);
  }

  sendMessage(params: { fromAgentId: string; toAgentId?: string | null; topic?: string | null; text: string; files?: string | string[] | null }): LiteMessage {
    const stamp = now();
    const messageId = id('msg');
    const fromAgentId = required(params.fromAgentId, 'from-agent-id');
    this.touchAgent({ agentId: fromAgentId });
    this.db.prepare(`INSERT INTO messages(message_id, from_agent_id, to_agent_id, topic, text, files_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        messageId,
        fromAgentId,
        params.toAgentId?.trim() || null,
        params.topic?.trim() || null,
        required(params.text, 'text'),
        JSON.stringify(splitFiles(params.files)),
        stamp,
      );
    return this.getMessage(messageId);
  }

  listMessages(params: { agentId?: string | null; includeRead?: boolean; topic?: string | null; limit?: number } = {}): LiteMessage[] {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const agentId = params.agentId?.trim();
    const topic = params.topic?.trim();
    const clauses: string[] = [];
    const values: string[] = [];
    let readAt = 'NULL AS read_at';
    if (agentId) {
      clauses.push('m.from_agent_id != ?');
      values.push(agentId);
      clauses.push('(m.to_agent_id IS NULL OR m.to_agent_id = ?)');
      values.push(agentId);
      readAt = '(SELECT r.read_at FROM message_receipts r WHERE r.message_id = m.message_id AND r.agent_id = ?) AS read_at';
      values.unshift(agentId);
      if (!params.includeRead) {
        clauses.push('NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.message_id AND r.agent_id = ?)');
        values.push(agentId);
      }
    }
    if (topic) {
      clauses.push('m.topic = ?');
      values.push(topic);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT m.*, ${readAt} FROM messages m${where} ORDER BY m.created_at DESC LIMIT ?`).all(...values, limit);
    return (rows as unknown as MessageRow[]).map(messageFromRow);
  }

  markMessageRead(params: { messageId: string; agentId: string }): LiteMessage {
    const message = this.getMessage(required(params.messageId, 'message-id'));
    const agentId = required(params.agentId, 'agent-id');
    this.touchAgent({ agentId });
    this.db.prepare(`INSERT INTO message_receipts(message_id, agent_id, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, agent_id) DO UPDATE SET read_at = excluded.read_at`).run(message.messageId, agentId, now());
    return this.listMessages({ agentId, includeRead: true, limit: 100 }).find((item) => item.messageId === message.messageId) ?? this.getMessage(message.messageId);
  }

  pruneMessages(params: { olderThanMs: number; readOnly?: boolean; dryRun?: boolean }): PruneResult {
    const olderThan = cutoffIso(params.olderThanMs);
    const clauses = ['created_at < ?'];
    const values: string[] = [olderThan];
    if (params.readOnly) clauses.push('EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = messages.message_id)');
    const where = clauses.join(' AND ');
    const matched = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`).get(...values) as { count: number }).count;
    const dryRun = params.dryRun !== false;
    if (!dryRun && matched > 0) this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(...values);
    return { dryRun, matched, deleted: dryRun ? 0 : matched, olderThan };
  }

  schema(): LiteSchema {
    return {
      entities: {
        plan: ['planId', 'title', 'goal', 'status', 'createdAt', 'updatedAt'],
        task: ['taskId', 'planId', 'title', 'filePath', 'checkCommand', 'status', 'agentId', 'doneAt', 'verifiedAt', 'verifiedBy', 'verificationMessage'],
        lock: ['filePath', 'agentId', 'reason', 'acquiredAt', 'expiresAt'],
        work: ['filePath', 'agentId', 'reason', 'startedAt', 'updatedAt', 'expiresAt'],
        handoff: ['handoffId', 'agentId', 'summary', 'files', 'createdAt', 'clearedAt'],
        memory: ['memoryId', 'label', 'text', 'tags', 'createdAt'],
        agent: ['agentId', 'name', 'role', 'status', 'metadata', 'createdAt', 'lastSeenAt'],
        message: ['messageId', 'fromAgentId', 'toAgentId', 'topic', 'text', 'files', 'createdAt', 'readAt'],
      },
      commands: {
        status: ['status'],
        plan: ['create --title [--goal]', 'list', 'done --plan-id [--force]'],
        task: ['add --plan-id --title [--file] [--check]', 'list [--plan-id] [--status]', 'claim --task-id --agent-id', 'done --task-id --agent-id', 'reopen --task-id --agent-id [--reason]'],
        lock: ['acquire --file --agent-id [--reason] [--ttl]', 'release --file --agent-id', 'list'],
        work: ['start --file --agent-id [--reason] [--ttl]', 'touch --file --agent-id [--reason] [--ttl]', 'list', 'end --file --agent-id'],
        handoff: ['add --agent-id --summary [--file]', 'list [--include-cleared]', 'clear --handoff-id'],
        check: ['audit', 'mark --task-id --agent-id --message'],
        memory: ['store --label --text [--tags]', 'recall [--query] [--label] [--limit]', 'list [--limit]', 'forget --memory-id', 'delete --memory-id', 'prune --older-than [--label] [--confirm]'],
        agent: ['join --agent-id [--name] [--role] [--meta]', 'touch --agent-id', 'leave --agent-id', 'list [--include-left] [--stale-after]'],
        message: ['send --from --text [--to] [--topic] [--file]', 'inbox --agent-id [--topic] [--include-read] [--limit]', 'list [--agent-id] [--topic] [--include-read] [--limit]', 'read --message-id --agent-id', 'prune --older-than [--read-only] [--confirm]'],
        hooks: ['pre-edit [--agent-id] [--host] < event.json', 'install --host claude|codex|cursor [--project-dir] [--dry-run]'],
        schema: ['schema'],
      },
    };
  }

  private listPendingChecks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'DONE' AND verified_at IS NULL ORDER BY done_at ASC, updated_at ASC").all();
    return (rows as unknown as TaskRow[]).map(taskFromRow);
  }

  private getLock(filePath: string): Lock {
    const row = this.db.prepare('SELECT * FROM locks WHERE file_path = ?').get(filePath) as unknown as LockRow | undefined;
    if (!row) throw new Error(`lock not found: ${filePath}`);
    return lockFromRow(row);
  }

  private getMemory(memoryId: string): MemoryItem {
    const row = this.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(memoryId) as unknown as MemoryRow | undefined;
    if (!row) throw new Error(`memory not found: ${memoryId}`);
    return memoryFromRow(row);
  }

  private getAgent(agentId: string): AgentRecord {
    const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as unknown as AgentRow | undefined;
    if (!row) throw new Error(`agent not found: ${agentId}`);
    return agentFromRow(row);
  }

  private getMessage(messageId: string): LiteMessage {
    const row = this.db.prepare('SELECT m.*, NULL AS read_at FROM messages m WHERE m.message_id = ?').get(messageId) as unknown as MessageRow | undefined;
    if (!row) throw new Error(`message not found: ${messageId}`);
    return messageFromRow(row);
  }

  private getWorkPresence(filePath: string, agentId: string): WorkPresence {
    const row = this.db.prepare('SELECT * FROM work_presence WHERE file_path = ? AND agent_id = ?').get(filePath, agentId) as unknown as WorkPresenceRow | undefined;
    if (!row) throw new Error(`work presence not found: ${filePath} for ${agentId}`);
    return workPresenceFromRow(row);
  }

  private getHandoff(handoffId: string): HandoffNote {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE handoff_id = ?').get(handoffId) as unknown as HandoffRow | undefined;
    if (!row) throw new Error(`handoff not found: ${handoffId}`);
    return handoffFromRow(row);
  }

  private pruneExpiredLocks(): void {
    this.db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(now());
  }

  private pruneExpiredWork(): void {
    this.db.prepare('DELETE FROM work_presence WHERE expires_at <= ?').run(now());
  }

  private count(table: 'plans' | 'tasks' | 'locks' | 'work_presence' | 'memories' | 'agents' | 'messages'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  private countPlansByStatus(status: PlanStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM plans WHERE status = ?').get(status) as { count: number };
    return row.count;
  }

  private countTasksByStatus(status: TaskStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE status = ?').get(status) as { count: number };
    return row.count;
  }

  private countPendingChecks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'DONE' AND verified_at IS NULL").get() as { count: number };
    return row.count;
  }
  private countOpenHandoffs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM handoffs WHERE cleared_at IS NULL').get() as { count: number };
    return row.count;
  }

  private countStaleAgents(staleAfterMs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE status != 'LEFT' AND last_seen_at < ?").get(cutoffIso(staleAfterMs)) as { count: number };
    return row.count;
  }

  /**
   * Count present agents: joined, not LEFT, and seen within the presence window.
   * Agents have no TTL auto-prune (unlike locks/work), so a crashed agent that
   * never called leave would otherwise linger in a raw COUNT(*) forever. This is
   * the complement of countStaleAgents among non-LEFT agents.
   */
  private countPresentAgents(staleAfterMs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE status != 'LEFT' AND last_seen_at >= ?").get(cutoffIso(staleAfterMs)) as { count: number };
    return row.count;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'DONE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        file_path TEXT,
        check_command TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'DONE')),
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT,
        verified_at TEXT,
        verified_by TEXT,
        verification_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS locks (
        file_path TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_presence (
        file_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(file_path, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_work_presence_file ON work_presence(file_path);
      CREATE INDEX IF NOT EXISTS idx_work_presence_expires ON work_presence(expires_at);

      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cleared_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_handoffs_open ON handoffs(cleared_at, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_label ON memories(label);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'IDLE', 'LEFT')),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status, last_seen_at);

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        topic TEXT,
        text TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, created_at);

      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY(message_id, agent_id)
      );
    `);
    this.addColumnIfMissing('tasks', 'check_command', 'TEXT');
    this.addColumnIfMissing('tasks', 'verified_at', 'TEXT');
    this.addColumnIfMissing('tasks', 'verified_by', 'TEXT');
    this.addColumnIfMissing('tasks', 'verification_message', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_unverified ON tasks(status, verified_at)');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openAwarenessLite(options: AwarenessLiteOptions = {}): AwarenessLite {
  return new AwarenessLite(options);
}
