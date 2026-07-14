import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInstallSource } from '../assets.js';
import { truncateUserVisibleToolOutput } from '../utils.js';
import type {
  PiContext,
  PiInstance,
  SpawnPolicy,
  SpawnPolicyResult,
  ToolCallResult,
  ToolDefinition,
  PiTheme,
  WorkerLedgerEntry,
  WorkerLedgerEvent,
  WorkerLedgerEventType,
} from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { stringEnumSchema } from './schema-helpers.js';
import { getRandomAgentName } from '../agentNames.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export type AgentStatus = 'starting' | 'running' | 'idle' | 'exited' | 'failed' | 'killed';
export type ResourceMode = 'lean' | 'octocode' | 'default';
export type NormalizedWorkerStatus = 'done' | 'blocked' | 'failed' | 'unknown';
export type NormalizedWorkerConfidence = 'confirmed' | 'likely' | 'uncertain';

type MessageAction = 'list' | 'status' | 'send' | 'steer' | 'followUp' | 'wait' | 'kill' | 'abort';

export interface NormalizedWorkerResult {
  status: NormalizedWorkerStatus;
  result?: string;
  evidence: string[];
  verification?: string;
  confidence: NormalizedWorkerConfidence;
  next?: string;
  rawPrefixes: Record<string, string[]>;
}

export interface WorkerRecoveryRisk {
  warnings: string[];
  statusOrActionCount: number;
  evidenceCount: number;
  hasVerification: boolean;
}

const REQUIRED_PACKET_SECTIONS = ['goal', 'scope', 'ownership', 'acceptance', 'return'];

type StreamHandler = (event: string, cb: (chunk: Buffer | string) => void) => void;
type ProcessHandler = (event: string, cb: (...args: unknown[]) => void) => void;

interface AgentProcess {
  stdin: { write(data: string): unknown; end?(): unknown };
  stdout: { on: StreamHandler };
  stderr: { on: StreamHandler };
  on: ProcessHandler;
  kill(signal?: NodeJS.Signals): boolean;
  killed?: boolean;
  /** null while running; a number once the process exited normally. */
  exitCode?: number | null;
  /** null while running; the signal name if the process was killed by a signal. */
  signalCode?: NodeJS.Signals | null;
}

interface SpawnOptions {
  cwd?: string;
  shell?: boolean;
  stdio?: Array<'ignore' | 'pipe'>;
  env?: NodeJS.ProcessEnv;
}

type AgentProcessFactory = (command: string, args: string[], options: SpawnOptions) => AgentProcess;

export interface SpawnAgentParams {
  task?: string;
  prompt?: string;
  context?: string;
  name?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
  resourceMode?: ResourceMode;
  noSession?: boolean;
  /**
   * Absolute paths to skill directories to load via --skill (additive, works with --no-skills).
   * L9: This field is intentionally NOT exposed in the `spawnAgent` tool's TypeBox schema;
   * it is used internally by `spawnSubagent` which resolves skill directories from the
   * installed skill registry before calling `spawnRpcAgent`. Passing skills directly via
   * the `spawnAgent` tool params is unsupported and will be silently ignored by the schema
   * validator; use `spawnSubagent` instead.
   */
  skills?: string[];
}

interface AgentToolCall {
  toolCallId?: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  isError?: boolean;
}

interface AgentRecord {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  process: AgentProcess;
  status: AgentStatus;
  startedAt: number;
  updatedAt: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  stderr: string;
  events: unknown[];
  messages: unknown[];
  responses: unknown[];
  toolCalls: AgentToolCall[];
  lastOutput: string;
  normalizedResult?: NormalizedWorkerResult;
  recoveryRisk: WorkerRecoveryRisk;
  ledgerEvents: WorkerLedgerEvent[];
  policyWarnings: string[];
  promptFiles: string[];
  waiters: Set<() => void>;
  nextRequestId: number;
}

interface AgentDetails {
  agents: Array<ReturnType<typeof summarizeAgent>>;
}

const MAX_STORED_EVENTS = 200;
const MAX_LEDGER_EVENTS = 80;
const MAX_STDERR_CHARS = 64_000;
const MAX_VISIBLE_OUTPUT = 12000;
/** Maximum number of simultaneously active (non-droppable) agent records. Hard limit enforced on spawn. */
export const MAX_AGENT_RECORDS = 50;
export const DEFAULT_SPAWN_POLICY: SpawnPolicy = {
  maxActiveAgents: MAX_AGENT_RECORDS,
  warningActiveAgents: 6,
  requiredPacketSections: REQUIRED_PACKET_SECTIONS,
};
const SPAWN_POLICY_MAX_ACTIVE_ENV = 'OCTOCODE_AGENT_MAX_ACTIVE';
const SPAWN_POLICY_WARNING_ACTIVE_ENV = 'OCTOCODE_AGENT_WARNING_ACTIVE';
export const OCTOCODE_AGENTS_COMMAND_USAGE = '/octocode-agents [help|list|status|inspect <id>|kill <id>|kill-all|prune|hide]';
export const OCTOCODE_AGENTS_COMMAND_COMPLETIONS = ['help', 'list', 'status', 'inspect ', 'kill ', 'kill-all', 'prune', 'hide'] as const;
export const OCTOCODE_AGENTS_COMMAND_DESCRIPTIONS: Record<(typeof OCTOCODE_AGENTS_COMMAND_COMPLETIONS)[number], string> = {
  help: 'Show command examples and lifecycle hints',
  list: 'Show the worker ledger and refresh footer/widget status',
  status: 'Alias for list',
  'inspect ': 'Show full state for one worker by id or prefix',
  'kill ': 'Stop one live worker by id or prefix',
  'kill-all': 'Stop every live worker',
  prune: 'Remove completed idle records from the in-memory ledger',
  hide: 'Clear the footer/widget ledger for this session',
};
const SUBAGENT_ENV_VAR = 'OCTOCODE_PI_SUBAGENT';
const AWARENESS_AGENT_ENV_VAR = 'OCTOCODE_AGENT_ID';
const FORBIDDEN_WORKER_TOOLS = new Set(['spawnAgent', 'AgentMessage', 'spawnSubagent']);
const agents = new Map<string, AgentRecord>();
const EXIT_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
let processFactory: AgentProcessFactory = (command, args, options) => spawn(command, args, options) as unknown as AgentProcess;
let processCleanupHandlersInstalled = false;

/**
 * True when running inside a spawned worker process (marked via SUBAGENT_ENV_VAR).
 * Workers must not register any agent-spawning tool — recursive spawning is forbidden.
 */
export function isSubagentProcess(): boolean {
  return process.env[SUBAGENT_ENV_VAR] === '1';
}

export function setAgentProcessFactoryForTests(factory: AgentProcessFactory | null): void {
  processFactory = factory ?? ((command, args, options) => spawn(command, args, options) as unknown as AgentProcess);
  agents.clear();
}

/** wait() resolves at end-of-turn: idle counts as "done for now", plus true terminals. */
function isTerminal(record: AgentRecord): boolean {
  return ['idle', 'exited', 'failed', 'killed'].includes(record.status);
}

/**
 * Safe to drop from the registry WITHOUT killing: the child process is gone.
 * `idle` is NOT droppable — an idle worker's process is still alive to accept
 * send/steer/followUp, so evicting or shutdown-skipping it would orphan the child.
 */
function isDroppable(record: AgentRecord): boolean {
  return ['exited', 'failed', 'killed'].includes(record.status);
}

/**
 * Whether the underlying OS process is still running (authoritative, sync).
 * A real ChildProcess reports null for both while running; test mocks may leave
 * them undefined — treat null/undefined (== null) as "still running".
 */
function isProcessAlive(record: AgentRecord): boolean {
  return record.process.exitCode == null && record.process.signalCode == null;
}

function evictStaleAgents(): void {
  if (agents.size <= MAX_AGENT_RECORDS) return;
  // Only evict records whose process is truly gone — never silently drop an
  // alive (running/idle/starting) worker, which would orphan the child process.
  const droppable = [...agents.entries()]
    .filter(([, r]) => isDroppable(r))
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt || a.startedAt - b.startedAt);
  while (agents.size > MAX_AGENT_RECORDS && droppable.length > 0) {
    const [id, record] = droppable.shift()!;
    removePromptFiles(record);
    agents.delete(id);
  }
}

export function cleanupSpawnedAgentsForShutdown(): number {
  // Kill every worker whose process is still alive — including idle ones, whose
  // process stays up between turns and would otherwise survive as an orphan.
  const alive = [...agents.values()].filter((record) => !isDroppable(record));
  for (const record of alive) killAgent(record, { forceKillDelayMs: 0 });
  return alive.length;
}

function installProcessCleanupHandlers(): void {
  if (processCleanupHandlersInstalled || process.env[SUBAGENT_ENV_VAR] === '1') return;
  processCleanupHandlersInstalled = true;
  const cleanup = () => { cleanupSpawnedAgentsForShutdown(); };
  process.once('beforeExit', cleanup);
  process.once('exit', cleanup);
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  }
}



// ─── TUI rendering helpers ────────────────────────────────────────────────────
// truncateToWidth + makeRenderer imported from render-helpers.ts (single source)

type AgentDisplayState = 'starting' | 'running' | 'idle' | 'done' | 'blocked' | 'failed' | 'killed';

type AgentDisplaySource = {
  status?: string;
  normalizedResult?: { status?: string; result?: string; next?: string; confidence?: string; verification?: string };
};

function getAgentDisplayState(agent: AgentDisplaySource): AgentDisplayState {
  const workerStatus = agent.normalizedResult?.status;
  if (agent.status === 'killed') return 'killed';
  if (agent.status === 'failed' || workerStatus === 'failed') return 'failed';
  if (workerStatus === 'blocked') return 'blocked';
  if (agent.status === 'running') return 'running';
  if (workerStatus === 'done' || agent.status === 'exited') return 'done';
  if (agent.status === 'idle') return 'idle';
  return 'starting';
}

function agentDisplayMeta(state: AgentDisplayState, theme?: PiTheme): { icon: string; label: string } {
  const raw = (() => {
    switch (state) {
      case 'done': return { icon: '\u2713', label: 'done', color: 'success' };
      case 'failed': return { icon: '\u2717', label: 'failed', color: 'error' };
      case 'killed': return { icon: '\u2717', label: 'killed', color: 'warning' };
      case 'blocked': return { icon: '!', label: 'blocked', color: 'warning' };
      case 'running': return { icon: '\u29D7', label: 'running', color: 'warning' };
      case 'idle': return { icon: '\u25CE', label: 'idle', color: 'success' };
      case 'starting': return { icon: '\u25CB', label: 'starting', color: 'dim' };
    }
  })();
  return {
    icon: theme?.fg(raw.color, raw.icon) ?? raw.icon,
    label: theme?.fg(raw.color, raw.label) ?? raw.label,
  };
}

function statusIcon(status: AgentStatus, theme?: PiTheme): string {
  return agentDisplayMeta(getAgentDisplayState({ status }), theme).icon;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatElapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: 'pi', args };
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'agent';
}

function writeTempPromptFile(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-agent-'));
  const filePath = path.join(dir, `${safeName(name)}.md`);
  fs.writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function removePromptFiles(record: AgentRecord): void {
  for (const filePath of record.promptFiles) {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
  record.promptFiles = [];
}

function buildInitialPrompt(params: SpawnAgentParams): string {
  const task = String(params.task ?? params.prompt ?? '').trim();
  const context = String(params.context ?? '').trim();
  if (!context) return task;
  return `Context for this delegated agent:\n\n${context}\n\nTask:\n\n${task}`;
}

function getWorkerTools(params: SpawnAgentParams): string[] {
  return (params.tools ?? []).filter((toolName) => !FORBIDDEN_WORKER_TOOLS.has(toolName));
}

function buildPiArgs(params: SpawnAgentParams, name: string, promptFiles: string[]): string[] {
  const resourceMode = params.resourceMode ?? 'lean';
  const args = ['--mode', 'rpc'];
  const workerTools = getWorkerTools(params);

  if (params.noSession !== false) args.push('--no-session');
  // Load specific skills even when --no-skills is active (additive)
  for (const skillPath of params.skills ?? []) args.push('--skill', skillPath);
  args.push('--name', name);
  args.push('--exclude-tools', [...FORBIDDEN_WORKER_TOOLS].join(','));

  if (params.provider) args.push('--provider', params.provider);
  if (params.model) args.push('--model', params.model);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (workerTools.length) args.push('--tools', workerTools.join(','));
  args.push('--no-context-files');

  if (resourceMode === 'lean') {
    args.push('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes');
  } else if (resourceMode === 'octocode') {
    args.push('--no-extensions', '-e', getInstallSource(), '--no-skills', '--no-prompt-templates', '--no-themes');
  }

  const systemPrompt = String(params.systemPrompt ?? '').trim();
  if (systemPrompt) {
    const filePath = writeTempPromptFile(name, systemPrompt);
    promptFiles.push(filePath);
    args.push('--append-system-prompt', filePath);
  }

  return args;
}

function touch(record: AgentRecord, status?: AgentStatus): void {
  record.updatedAt = Date.now();
  if (status) record.status = status;
}

function pushLedgerEvent(record: AgentRecord, type: WorkerLedgerEventType, message?: string, details?: unknown): void {
  pushCapped(record.ledgerEvents, {
    type,
    timestamp: Date.now(),
    message,
    details,
  });
  if (record.ledgerEvents.length > MAX_LEDGER_EVENTS) record.ledgerEvents.splice(0, record.ledgerEvents.length - MAX_LEDGER_EVENTS);
}

function notifyWaiters(record: AgentRecord): void {
  for (const waiter of record.waiters) waiter();
  record.waiters.clear();
}

function pushCapped<T>(items: T[], item: T): void {
  items.push(item);
  if (items.length > MAX_STORED_EVENTS) items.splice(0, items.length - MAX_STORED_EVENTS);
}

function activeAgentCount(): number {
  return [...agents.values()].filter((record) => !isDroppable(record)).length;
}

function lowerIncludesAll(text: string, sections: string[]): string[] {
  const lower = text.toLowerCase();
  return sections.filter((section) => !lower.includes(section));
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function resolveSpawnPolicy(policy: SpawnPolicy): SpawnPolicy {
  const maxActiveAgents = readPositiveIntegerEnv(SPAWN_POLICY_MAX_ACTIVE_ENV) ?? policy.maxActiveAgents;
  const warningActiveAgents = readPositiveIntegerEnv(SPAWN_POLICY_WARNING_ACTIVE_ENV) ?? policy.warningActiveAgents;
  return {
    ...policy,
    maxActiveAgents,
    warningActiveAgents: Math.min(warningActiveAgents, maxActiveAgents),
  };
}

function looksLikeProviderScopedModel(model: string): boolean {
  return /\//.test(model)
    || /^(?:claude|gpt|llama|mistral|gemini|qwen|zai|deepseek|kimi|codestral)[-_:/.]/i.test(model);
}

export function evaluateSpawnPolicy(params: SpawnAgentParams, activeCount = activeAgentCount(), policy: SpawnPolicy = DEFAULT_SPAWN_POLICY): SpawnPolicyResult {
  const effectivePolicy = resolveSpawnPolicy(policy);
  const warnings: string[] = [];
  if (activeCount >= effectivePolicy.maxActiveAgents) {
    return {
      allowed: false,
      warnings,
      reason: `Agent registry at capacity: ${activeCount}/${effectivePolicy.maxActiveAgents} active agents.`,
    };
  }
  if (activeCount >= effectivePolicy.warningActiveAgents) {
    warnings.push(`High worker fan-out: ${activeCount}/${effectivePolicy.maxActiveAgents} active agents already exist.`);
  }
  const task = buildInitialPrompt(params);
  const missingSections = lowerIncludesAll(task, effectivePolicy.requiredPacketSections);
  if (missingSections.length > 0) {
    warnings.push(`Worker packet is missing recommended section(s): ${missingSections.join(', ')}.`);
  }
  const model = String(params.model ?? '');
  if (model && looksLikeProviderScopedModel(model) && !params.provider) {
    warnings.push('Model looks provider-scoped or custom-provider-hosted; pass provider from `pi -ne --list-models` when required.');
  }
  const strippedTools = (params.tools ?? []).filter((toolName) => FORBIDDEN_WORKER_TOOLS.has(toolName));
  if (strippedTools.length > 0) {
    warnings.push(`Recursive worker tool(s) stripped: ${strippedTools.join(', ')}.`);
  }
  return { allowed: true, warnings };
}

function extractTextFromMessage(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ((part as { type?: string; text?: string }).type === 'text' ? (part as { text?: string }).text ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}

function normalizeConfidence(value: string | undefined): NormalizedWorkerConfidence {
  const lower = String(value ?? '').toLowerCase();
  if (lower.includes('confirmed')) return 'confirmed';
  if (lower.includes('likely')) return 'likely';
  return 'uncertain';
}

export function normalizeWorkerOutput(output: string): NormalizedWorkerResult {
  const rawPrefixes: Record<string, string[]> = {};
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*\[([A-Z][A-Z0-9_-]*)\]\s*(.*)$/);
    if (!match) continue;
    const prefix = match[1]!;
    (rawPrefixes[prefix] ??= []).push(match[2]!.trim());
  }

  const last = (prefix: string): string | undefined => rawPrefixes[prefix]?.at(-1);
  const evidence = rawPrefixes['EVIDENCE'] ?? [];
  const blocked = last('BLOCKED');
  const done = last('DONE');
  const failed = last('FAILED') ?? last('ERROR');
  const result =
    last('RESULT')
    ?? last('FINDING')
    ?? last('ROOT')
    ?? last('FIX')
    ?? last('PLAN')
    ?? last('ACTION')
    ?? undefined;
  const verification = last('VERIFICATION') ?? last('VERIFY') ?? undefined;
  const fallback = output.trim();

  return {
    status: failed ? 'failed' : blocked ? 'blocked' : done ? 'done' : 'unknown',
    result: result || (Object.keys(rawPrefixes).length === 0 && fallback ? fallback : undefined),
    evidence,
    verification,
    confidence: normalizeConfidence(last('CONFIDENCE')),
    next: last('NEXT') || blocked || done || undefined,
    rawPrefixes,
  };
}

export function evaluateWorkerRecoveryRisk(output: string): WorkerRecoveryRisk {
  const normalized = normalizeWorkerOutput(output);
  const statusOrActionCount = (normalized.rawPrefixes['STATUS']?.length ?? 0)
    + (normalized.rawPrefixes['ACTION']?.length ?? 0)
    + (normalized.rawPrefixes['FIX']?.length ?? 0);
  const evidenceCount = normalized.evidence.length;
  const hasVerification = Boolean(normalized.verification);
  const warnings: string[] = [];

  if (statusOrActionCount >= 4 && evidenceCount === 0 && !hasVerification) {
    warnings.push(
      `Possible recovery loop: ${statusOrActionCount} status/action updates without evidence or verification; re-diagnose before continuing.`,
    );
  }

  if (normalized.status === 'done' && evidenceCount === 0 && !hasVerification) {
    warnings.push('Worker claims done without evidence or verification; parent must independently verify acceptance.');
  }

  return { warnings, statusOrActionCount, evidenceCount, hasVerification };
}

function refreshNormalizedResult(record: AgentRecord): void {
  const previousStatus = record.normalizedResult?.status;
  const previousWarnings = record.recoveryRisk.warnings.join('\n');
  const output = record.lastOutput || record.stderr || record.error || '';
  record.normalizedResult = normalizeWorkerOutput(output);
  record.recoveryRisk = evaluateWorkerRecoveryRisk(output);
  if (record.normalizedResult.status !== 'unknown' && record.normalizedResult.status !== previousStatus) {
    pushLedgerEvent(record, 'handback', `worker handback: ${record.normalizedResult.status}`, record.normalizedResult);
  }
  const currentWarnings = record.recoveryRisk.warnings.join('\n');
  if (currentWarnings && currentWarnings !== previousWarnings) {
    pushLedgerEvent(record, 'policy', `recovery risk: ${record.recoveryRisk.warnings.join(' | ')}`, record.recoveryRisk);
  }
}

function updateLastOutput(record: AgentRecord, message: unknown): void {
  const text = extractTextFromMessage(message);
  if (text) {
    record.lastOutput = text;
    refreshNormalizedResult(record);
  }
}

function getEventToolName(event: Record<string, unknown>): string {
  return String(event['toolName'] ?? event['tool_name'] ?? event['tool'] ?? event['name'] ?? '').trim();
}

function getEventToolCallId(event: Record<string, unknown>): string | undefined {
  const id = event['toolCallId'] ?? event['tool_call_id'] ?? event['id'];
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function recordToolStart(record: AgentRecord, event: Record<string, unknown>): void {
  const toolName = getEventToolName(event);
  if (!toolName) return;
  pushCapped(record.toolCalls, {
    toolCallId: getEventToolCallId(event),
    toolName,
    status: 'running',
    startedAt: Date.now(),
  });
  pushLedgerEvent(record, 'tool', `tool started: ${toolName}`);
  touch(record, 'running');
}

function recordToolEnd(record: AgentRecord, event: Record<string, unknown>): void {
  const toolName = getEventToolName(event);
  const toolCallId = getEventToolCallId(event);
  if (!toolName && !toolCallId) return;
  const call = [...record.toolCalls].reverse().find((item) => (
    toolCallId ? item.toolCallId === toolCallId : item.toolName === toolName
  ) && item.status === 'running');
  const isError = Boolean(event['isError'] ?? event['is_error'] ?? event['error']);
  if (call) {
    call.status = isError ? 'error' : 'done';
    call.finishedAt = Date.now();
    call.isError = isError;
  } else if (toolName) {
    pushCapped(record.toolCalls, {
      toolCallId,
      toolName,
      status: isError ? 'error' : 'done',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      isError,
    });
  }
  if (toolName) pushLedgerEvent(record, 'tool', `tool ${isError ? 'failed' : 'finished'}: ${toolName}`);
  touch(record);
}

function formatToolCalls(toolCalls: AgentToolCall[], limit = 3): string {
  const recent = toolCalls.slice(-limit);
  return recent.map((call) => `${call.toolName}:${call.status}`).join(', ');
}

function processRpcLine(record: AgentRecord, line: string): void {
  if (!line.trim()) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  pushCapped(record.events, event);
  const eventObject = event as Record<string, unknown>;
  const eventType = (event as { type?: string }).type;
  if (eventType === 'tool_call' || eventType === 'tool_execution_start') {
    recordToolStart(record, eventObject);
  } else if (eventType === 'tool_result' || eventType === 'tool_execution_end') {
    recordToolEnd(record, eventObject);
  } else if (eventType === 'response') {
    pushCapped(record.responses, event);
    const resp = event as { success?: boolean; command?: string; error?: string };
    if (resp.success === false) {
      if (!record.error) record.error = resp.error ?? `RPC command failed: ${resp.command ?? 'unknown'}`;
      pushLedgerEvent(record, 'error', record.error);
      touch(record);
    }
  } else if (eventType === 'agent_start') {
    touch(record, 'running');
  } else if (eventType === 'message_end' && (event as { message?: unknown }).message) {
    const message = (event as { message: unknown }).message;
    pushCapped(record.messages, message);
    updateLastOutput(record, message);
    touch(record);
  } else if (eventType === 'agent_end') {
    const messages = (event as { messages?: unknown[] }).messages;
    if (Array.isArray(messages)) {
      for (const message of messages) updateLastOutput(record, message);
    }
    touch(record, 'idle');
    notifyWaiters(record);
  }
}

/**
 * Send an RPC message to the spawned agent process.
 * Returns true on success, false on failure (EPIPE / ERR_STREAM_WRITE_AFTER_END).
 * On failure the record is transitioned to 'failed' and all waiters are notified
 * so AgentMessage action:'wait' resolves immediately instead of hanging to timeout.
 */
function sendRpc(record: AgentRecord, payload: Record<string, unknown>): boolean {
  const id = `${record.id}-${record.nextRequestId++}`;
  try {
    record.process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    return true;
  } catch (error) {
    // Writing to a destroyed/closed stdin throws EPIPE / ERR_STREAM_WRITE_AFTER_END.
    // H4: Transition to 'failed' and notify waiters — without this, any pending
    // action:'wait' would hang until timeout because the record stays in 'starting'.
    record.error = error instanceof Error ? error.message : String(error);
    touch(record, 'failed');
    notifyWaiters(record);
    return false;
  }
}

function workerAwarenessAgentId(workerId: string): string {
  const parentId = process.env[AWARENESS_AGENT_ENV_VAR]?.trim() || 'pi-agent';
  return `${parentId}:worker:${workerId.slice(0, 8)}`;
}

function cleanupPromptFiles(promptFiles: string[]): void {
  for (const filePath of promptFiles) {
    try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function spawnRpcAgent(params: SpawnAgentParams, ctx?: PiContext): AgentRecord {
  const task = buildInitialPrompt(params);
  if (!task) throw new Error('spawnAgent requires task or prompt.');

  const id = randomUUID();
  const name = params.name ? String(params.name) : getRandomAgentName();
  const cwd = path.resolve(String(params.cwd ?? ctx?.cwd ?? process.cwd()));
  const promptFiles: string[] = [];
  const args = buildPiArgs(params, name, promptFiles);
  const invocation = getPiInvocation(args);
  const awarenessAgentId = workerAwarenessAgentId(id);

  // M7: Enforce a hard cap on active (non-droppable) agents before spawning a new process.
  // Evict droppable (exited/failed/killed) agents first to reclaim slots, then refuse if
  // non-droppable agents still fill the registry. Checked before processFactory to ensure
  // no process is leaked when the cap is exceeded.
  evictStaleAgents();
  const policyResult = evaluateSpawnPolicy(params, activeAgentCount());
  if (!policyResult.allowed) {
    cleanupPromptFiles(promptFiles);
    throw new Error(`${policyResult.reason} Kill or wait for existing agents before spawning more.`);
  }

  let proc;
  try {
    proc = processFactory(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [SUBAGENT_ENV_VAR]: '1',
        [AWARENESS_AGENT_ENV_VAR]: awarenessAgentId,
      },
    });
  } catch (error) {
    // processFactory threw before the record was added to `agents`, so removePromptFiles()
    // (wired to the record's 'close'/'error' handlers) would never run. Clean up the temp
    // system-prompt files buildPiArgs wrote so a failing factory does not leak files in os.tmpdir.
    cleanupPromptFiles(promptFiles);
    throw error;
  }

  const record: AgentRecord = {
    id,
    name,
    cwd,
    command: invocation.command,
    args: invocation.args,
    process: proc,
    status: 'starting',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    stderr: '',
    events: [],
    messages: [],
    responses: [],
    toolCalls: [],
    lastOutput: '',
    normalizedResult: normalizeWorkerOutput(''),
    recoveryRisk: evaluateWorkerRecoveryRisk(''),
    ledgerEvents: [],
    policyWarnings: policyResult.warnings,
    promptFiles,
    waiters: new Set(),
    nextRequestId: 1,
  };
  pushLedgerEvent(record, 'spawned', `spawned ${name}`, { awarenessAgentId });
  for (const warning of policyResult.warnings) pushLedgerEvent(record, 'policy', warning);
  agents.set(id, record);
  // Evict droppable agents to keep registry size ≤ MAX_AGENT_RECORDS.
  // The pre-spawn call (M7 cap check) runs before processFactory to avoid leaking
  // a process when the non-droppable cap is exceeded. This post-set call cleans up
  // droppable (exited/failed/killed) agents after the new record is in the map so
  // the total registry size stays bounded even when non-droppable count < cap.
  evictStaleAgents();

  let stdoutBuffer = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) processRpcLine(record, line);
  });
  proc.stderr.on('data', (chunk) => {
    record.stderr += chunk.toString();
    // Cap to the tail so a chatty worker can't grow this string unbounded.
    if (record.stderr.length > MAX_STDERR_CHARS) {
      record.stderr = record.stderr.slice(-MAX_STDERR_CHARS);
    }
    pushLedgerEvent(record, 'status', 'stderr received');
    touch(record);
  });
  proc.on('error', (error) => {
    record.error = error instanceof Error ? error.message : String(error);
    pushLedgerEvent(record, 'error', record.error);
    touch(record, 'failed');
    removePromptFiles(record);
    notifyWaiters(record);
  });
  proc.on('close', (code, signal) => {
    if (stdoutBuffer.trim()) processRpcLine(record, stdoutBuffer);
    record.exitCode = typeof code === 'number' ? code : undefined;
    record.signal = typeof signal === 'string' ? signal : undefined;
    if (record.status !== 'killed') touch(record, code === 0 ? 'exited' : 'failed');
    pushLedgerEvent(record, record.status === 'failed' ? 'error' : 'exit', `process closed with code ${record.exitCode ?? 'unknown'}`);
    removePromptFiles(record);
    notifyWaiters(record);
  });

  // H4: Only advance to 'running' when the initial RPC write succeeded.
  // If sendRpc returned false, it already transitioned the record to 'failed'
  // and notified waiters; overwriting with 'running' here would mask the failure.
  if (sendRpc(record, { type: 'prompt', message: task })) {
    pushLedgerEvent(record, 'message', 'initial prompt sent');
    touch(record, 'running');
  }
  return record;
}

function summarizeAgent(record: AgentRecord) {
  refreshNormalizedResult(record);
  const normalized = record.normalizedResult;
  const summaryText = normalized?.result || normalized?.next || record.lastOutput || record.stderr || record.error || '';
  const preview = truncateUserVisibleToolOutput(summaryText, 1000);
  return {
    agentId: record.id,
    name: record.name,
    status: record.status,
    cwd: record.cwd,
    model: getArgValue(record.args, '--model'),
    startedAt: new Date(record.startedAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    lastOutput: preview.text,
    outputTruncated: preview.truncated,
    normalizedResult: normalized,
    recoveryRisk: record.recoveryRisk,
    policyWarnings: [...record.policyWarnings],
    ledgerEvents: record.ledgerEvents.slice(-10),
    toolCalls: record.toolCalls.slice(-10),
    activeTool: [...record.toolCalls].reverse().find((call) => call.status === 'running')?.toolName,
  };
}

export function listWorkerLedgerEntries(): WorkerLedgerEntry[] {
  return [...agents.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((record) => {
      const normalized = record.normalizedResult;
      return {
        agentId: record.id,
        name: record.name,
        status: record.status,
        startedAt: new Date(record.startedAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        normalizedStatus: normalized?.status,
        result: normalized?.result,
        confidence: normalized?.confidence,
        evidence: normalized?.evidence,
        verification: normalized?.verification,
        next: normalized?.next,
        recentEvents: record.ledgerEvents.slice(-10),
      };
    });
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function findAgentByIdOrPrefix(agentId: unknown): AgentRecord | undefined {
  const id = String(agentId ?? '').trim();
  if (!id) return undefined;
  return agents.get(id) ?? [...agents.values()].find((record) => record.id.startsWith(id));
}

function getAgent(agentId: unknown): AgentRecord {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error(
    'AgentMessage requires agentId for all actions except action:"list". '
    + 'Use action:"list" to see all active agents.',
  );
  const record = findAgentByIdOrPrefix(id);
  if (!record) throw new Error(
    `No agent found with id: ${id.slice(0, 16)}${id.length > 16 ? '\u2026' : ''}. `
    + `Use action:"list" to see all active agents (${agents.size} registered).`,
  );
  return record;
}

function waitForAgent(record: AgentRecord, timeoutMs: number): Promise<void> {
  if (isTerminal(record)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      record.waiters.delete(onDone);
      reject(new Error(`Timed out waiting for agent "${record.name}" after ${timeoutMs}ms. Use AgentMessage action:"status" to inspect.`));
    }, timeoutMs);
    record.waiters.add(onDone);
  });
}

function agentRiskBadge(summary: ReturnType<typeof summarizeAgent>, theme?: PiTheme): string {
  if (summary.recoveryRisk?.warnings.length) return theme?.fg('warning', '⚠ recovery') ?? '⚠ recovery';
  if (summary.normalizedResult?.status === 'done' && summary.normalizedResult.evidence.length === 0 && !summary.normalizedResult.verification) {
    return theme?.fg('warning', '⚠ needs verify') ?? '⚠ needs verify';
  }
  return '';
}

function renderAgentResult(records: AgentRecord[], header: string): ToolCallResult {
  const summaries = records.map(summarizeAgent);
  const lines: string[] = [`${header} (${records.length}):`];
  for (const s of summaries) {
    const exit = s.exitCode !== undefined ? ` (exit ${s.exitCode})` : '';
    const elapsed = formatElapsed(new Date(s.startedAt).getTime());
    const state = getAgentDisplayState(s);
    const meta = agentDisplayMeta(state);
    const handback = s.normalizedResult?.status && s.normalizedResult.status !== 'unknown'
      ? ` \u00b7 ${s.normalizedResult.status}/${s.normalizedResult.confidence}`
      : '';
    const risk = agentRiskBadge(s);
    const riskText = risk ? ` \u00b7 ${risk}` : '';
    const result = s.normalizedResult?.result ?? s.normalizedResult?.next ?? s.lastOutput;
    const preview = result ? ` \u2014 ${result.slice(0, 60).replace(/\n/g, ' ')}${s.outputTruncated ? '\u2026' : ''}` : '';
    const toolInfo = typeof s.activeTool === 'string' ? ` \u00b7 tool: ${s.activeTool}` : '';
    lines.push(`  ${meta.icon} ${s.name} (${shortId(s.agentId)}) \u00b7 ${meta.label}${exit}${handback}${riskText} \u00b7 ${elapsed}${toolInfo}${preview}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: { agents: summaries } satisfies AgentDetails,
  };
}

function countAgentStates(records: AgentDisplaySource[]): Record<AgentDisplayState, number> {
  const counts: Record<AgentDisplayState, number> = {
    starting: 0,
    running: 0,
    idle: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    killed: 0,
  };
  for (const record of records) counts[getAgentDisplayState(record)] += 1;
  return counts;
}

function formatAgentStateCounts(records: AgentDisplaySource[]): string {
  const counts = countAgentStates(records);
  return `${records.length} total · ${counts.running} running · ${counts.blocked} blocked · ${counts.done} done · ${counts.failed} failed`;
}

export function formatAgentLedger(): string {
  const records = [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (records.length === 0) return 'Octocode agents: none';
  return `Octocode agents: ${formatAgentStateCounts(records)}`;
}

function buildAgentLedgerLines(limit = 10, theme?: PiTheme): string[] {
  const records = [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const title = theme?.fg('toolTitle', 'Octocode agents') ?? 'Octocode agents';
  if (records.length === 0) return [`${title}: none`];

  const counts = formatAgentStateCounts(records);
  const lines = [`${title}: ${theme?.fg('dim', counts) ?? counts}`];
  for (const record of records.slice(0, limit)) {
    const summary = summarizeAgent(record);
    const state = getAgentDisplayState(summary);
    const meta = agentDisplayMeta(state, theme);
    const handback = summary.normalizedResult?.status && summary.normalizedResult.status !== 'unknown'
      ? ` · ${summary.normalizedResult.status}/${summary.normalizedResult.confidence}`
      : '';
    const active = summary.activeTool ? ` · tool:${summary.activeTool}` : '';
    const risk = agentRiskBadge(summary, theme);
    const riskText = risk ? ` · ${risk}` : '';
    const result = summary.normalizedResult?.result ?? summary.normalizedResult?.next ?? summary.lastOutput;
    const preview = result ? ` — ${result.replace(/\n/g, ' ').slice(0, 90)}${summary.outputTruncated ? '…' : ''}` : '';
    const name = theme?.fg('accent', summary.name) ?? summary.name;
    const id = theme?.fg('dim', shortId(summary.agentId)) ?? shortId(summary.agentId);
    lines.push(`${meta.icon} ${name} (${id}) · ${meta.label}${handback}${riskText}${active} · ${formatElapsed(record.startedAt)}${theme?.fg('dim', preview) ?? preview}`);
  }
  if (records.length > limit) lines.push(theme?.fg('muted', `… ${records.length - limit} more; use AgentMessage list for full details.`) ?? `… ${records.length - limit} more; use AgentMessage list for full details.`);
  return lines;
}

export function formatAgentLedgerDetails(limit = 10): string {
  return buildAgentLedgerLines(limit).join('\n');
}

function hasVisibleAgentLedgerRecords(): boolean {
  return [...agents.values()].some((record) => !isDroppable(record) || record.normalizedResult?.status === 'blocked' || record.status === 'failed');
}

function agentLedgerWidget(theme?: PiTheme) {
  return makeRenderer((width) => buildAgentLedgerLines(6, theme).map((line) => truncateToWidth(line, width)));
}

export function refreshAgentLedgerUi(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  const records = [...agents.values()];
  if (records.length === 0) {
    ctx.ui?.setStatus?.('octocode-agents', undefined);
    ctx.ui?.setWidget?.('octocode-agents', undefined);
    return;
  }
  ctx.ui?.setStatus?.('octocode-agents', formatAgentLedger().replace(/^Octocode agents: /, 'agents: '));
  ctx.ui?.setWidget?.(
    'octocode-agents',
    hasVisibleAgentLedgerRecords() ? (_tui: unknown, theme: PiTheme) => agentLedgerWidget(theme) : undefined,
    { placement: 'belowEditor' },
  );
}

function formatOctocodeAgentsHelp(): string {
  return [
    OCTOCODE_AGENTS_COMMAND_USAGE,
    '',
    'Commands:',
    '- help — show this command reference',
    '- list/status — show the ledger and refresh footer/widget state',
    '- inspect <id-or-prefix> — show full worker state, handback, evidence, recent events, and stderr',
    '- kill <id-or-prefix> — stop one live worker',
    '- kill-all — stop every live worker',
    '- prune — remove completed idle records from the in-memory ledger',
    '- hide — clear the footer/widget ledger for this session',
    '',
    'Tip: ids can be full ids or short prefixes shown by list/status.',
  ].join('\n');
}

export async function handleOctocodeAgentsCommand(args: string, ctx?: PiContext): Promise<void> {
  const [actionRaw, targetRaw] = args.trim().split(/\s+/, 2);
  const action = (actionRaw || 'list').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h' || action === '?') {
    ctx?.ui?.notify?.(formatOctocodeAgentsHelp(), 'info');
    return;
  }
  if (action === 'hide' || action === 'clear') {
    ctx?.ui?.setStatus?.('octocode-agents', undefined);
    ctx?.ui?.setWidget?.('octocode-agents', undefined);
    ctx?.ui?.notify?.('Octocode agent ledger hidden for this session.', 'info');
    return;
  }
  if (action === 'prune') {
    const droppable = [...agents.entries()].filter(([, record]) => isDroppable(record));
    for (const [id, record] of droppable) {
      removePromptFiles(record);
      agents.delete(id);
    }
    refreshAgentLedgerUi(ctx);
    ctx?.ui?.notify?.(`Pruned ${droppable.length} Octocode agent record(s).\n${formatAgentLedgerDetails()}`, 'info');
    return;
  }
  if (action === 'inspect') {
    const record = findAgentByIdOrPrefix(targetRaw);
    if (!record) {
      ctx?.ui?.notify?.(`No Octocode agent matches: ${targetRaw ?? '(missing id)'}\n${formatAgentLedgerDetails()}`, 'error');
      return;
    }
    refreshAgentLedgerUi(ctx);
    ctx?.ui?.notify?.(renderSingleAgentResult(record, 'Agent status').content[0]?.text ?? '', 'info');
    return;
  }
  if (action === 'kill-all') {
    const alive = [...agents.values()].filter((record) => !isDroppable(record));
    for (const record of alive) killAgent(record);
    refreshAgentLedgerUi(ctx);
    ctx?.ui?.notify?.(`Killed ${alive.length} Octocode agent(s).\n${formatAgentLedgerDetails()}`, 'warning');
    return;
  }
  if (action === 'kill') {
    const record = findAgentByIdOrPrefix(targetRaw);
    if (!record) {
      ctx?.ui?.notify?.(`No Octocode agent matches: ${targetRaw ?? '(missing id)'}\n${formatAgentLedgerDetails()}`, 'error');
      return;
    }
    killAgent(record);
    refreshAgentLedgerUi(ctx);
    ctx?.ui?.notify?.(`Killed Octocode agent ${record.name} (${shortId(record.id)}).\n${formatAgentLedgerDetails()}`, 'warning');
    return;
  }
  if (action !== 'list' && action !== 'status') {
    ctx?.ui?.notify?.(formatOctocodeAgentsHelp(), 'warning');
    return;
  }
  refreshAgentLedgerUi(ctx);
  ctx?.ui?.notify?.(formatAgentLedgerDetails(), 'info');
}

function renderSingleAgentResult(record: AgentRecord, header: string): ToolCallResult {
  const output = truncateUserVisibleToolOutput(record.lastOutput || record.stderr || record.error || '', MAX_VISIBLE_OUTPUT);
  const summary = summarizeAgent(record);
  const elapsed = formatElapsed(record.startedAt);
  const statusParts = [
    `status: ${record.status}`,
    record.exitCode !== undefined ? `exit: ${record.exitCode}` : '',
    `elapsed: ${elapsed}`,
    record.error ? `error: ${record.error}` : '',
  ].filter(Boolean).join(' \u00b7 ');
  const contentParts: string[] = [
    `${header} [${record.name}]`,
    `agentId: ${record.id}`,
    statusParts,
  ];
  const toolSummary = formatToolCalls(record.toolCalls);
  if (toolSummary) contentParts.push(`tools: ${toolSummary}`);
  if (summary.policyWarnings?.length) contentParts.push(`policy: ${summary.policyWarnings.join(' | ')}`);
  if (summary.normalizedResult?.status && summary.normalizedResult.status !== 'unknown') {
    contentParts.push(`handback: ${summary.normalizedResult.status} · confidence: ${summary.normalizedResult.confidence}`);
    if (summary.normalizedResult.result) contentParts.push(`result: ${summary.normalizedResult.result}`);
    if (summary.normalizedResult.evidence.length > 0) {
      contentParts.push(`evidence: ${summary.normalizedResult.evidence.slice(0, 3).join('; ')}`);
    }
    if (summary.normalizedResult.verification) contentParts.push(`verification: ${summary.normalizedResult.verification}`);
    if (summary.normalizedResult.next) contentParts.push(`next: ${summary.normalizedResult.next}`);
  }
  if (summary.recoveryRisk?.warnings.length) {
    contentParts.push(`recovery-risk: ${summary.recoveryRisk.warnings.join(' | ')}`);
  }
  if (output.text) contentParts.push('', output.text);
  if (output.truncated) contentParts.push(`\u2026 output truncated (${output.omittedChars} chars hidden; full content in details)`);
  return {
    content: [{ type: 'text', text: contentParts.join('\n') }],
    details: {
      agent: summary,
      output: output.text,
      outputTruncated: output.truncated,
      omittedChars: output.omittedChars,
    },
    isError: record.status === 'failed' || Boolean(record.error),
  };
}

function killAgent(record: AgentRecord, opts: { forceKillDelayMs?: number } = {}): void {
  pushLedgerEvent(record, 'killed', 'kill requested');
  touch(record, 'killed');
  try {
    record.process.stdin.end?.();
  } catch {
    // ignore stdin close errors
  }
  record.process.kill('SIGTERM');
  // NOTE: ChildProcess.killed only means "a signal was delivered", not "process
  // exited" — it is true immediately after SIGTERM above, so it cannot gate the
  // SIGKILL escalation. Gate on actual liveness (exitCode/signalCode still null).
  const forceKillDelayMs = opts.forceKillDelayMs ?? 5000;
  if (forceKillDelayMs <= 0) {
    if (isProcessAlive(record)) record.process.kill('SIGKILL');
  } else {
    setTimeout(() => {
      if (isProcessAlive(record)) record.process.kill('SIGKILL');
    }, forceKillDelayMs).unref?.();
  }
  removePromptFiles(record);
  notifyWaiters(record);
}

export function registerAgentTools(
  pi: PiInstance,
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  if (process.env[SUBAGENT_ENV_VAR] === '1') return;
  installProcessCleanupHandlers();

  const resourceModeSchema = stringEnumSchema(
    Type,
    ['lean', 'octocode', 'default'],
    'Worker resource loading. lean disables extensions/skills/prompts/themes; octocode loads this extension explicitly; default uses Pi discovery.',
  );
  const actionSchema = stringEnumSchema(
    Type,
    ['list', 'status', 'send', 'steer', 'followUp', 'wait', 'kill', 'abort'],
    'AgentMessage action. abort sends Pi RPC abort (graceful interrupt without killing the process).',
  );

  registerFn(pi, registeredToolNames, {
    name: 'spawnAgent',
    label: 'Agent: Spawn Parallel Worker',
    description:
      'Spawn a separate background Pi worker process over RPC. Returns immediately with an agentId; use AgentMessage to inspect, send follow-ups, wait, or kill. Workers can run in parallel but share the selected cwd and environment-backed services.',
    promptSnippet: 'Spawn a background Pi worker process and return an agentId for AgentMessage.',
    promptGuidelines: [
      'Use spawnAgent only when delegation materially helps: independent work ownership, long-running tasks, or adversarial/coverage checks.',
      'Do not spawn agents for ordinary bug fixes/refactors that need shared context; stay in the parent or batch independent tool calls instead.',
      'For useful parallelism, spawn all independent workers first, then use AgentMessage action:"wait" or action:"status" to collect results.',
      'Workers inherit no parent conversation but share cwd, files, and environment-backed services. Pass a bounded request packet and assign disjoint paths for any writes.',
      'spawnAgent defaults to resourceMode:"lean". Use resourceMode:"octocode" only when the worker needs Octocode extension tools.',
      'Use `pi -ne --list-models [search]` as the source of truth for the user-configured model table; do not read hardcoded config paths.',
      'Pass model for each worker: fastest capable configured model for small tasks, balanced coding/reasoning model for medium tasks, strongest configured model for large/high-risk work.',
      'Spawned-agent registry and output previews live in the current Pi process; collect needed results before session shutdown or reload.',
      'spawnAgent prevents recursive subagents: workers never receive spawnAgent or AgentMessage, even in resourceMode:"octocode" or resourceMode:"default".',
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: 'Task for the worker. Required unless prompt is set.' })),
      prompt: Type.Optional(Type.String({ description: 'Alias for task.' })),
      context: Type.Optional(Type.String({ description: 'Self-contained context to prepend to the worker task.' })),
      name: Type.Optional(Type.String({ description: 'Human label for the worker/session.' })),
      cwd: Type.Optional(Type.String({ description: 'Working directory for the worker process. Defaults to current cwd.' })),
      model: Type.Optional(Type.String({ description: 'Pi model pattern or ID from `pi -ne --list-models [search]`. Choose from the live user-configured table; `--models` only sets model-cycling scope.' })),
      provider: Type.Optional(Type.String({ description: 'Pi provider name for the model. REQUIRED when the model lives on a custom provider defined in models.json (e.g. "guy-provider-anthropic") — without it, pi resolves --model against builtin providers and may fail with "No API key found" or a 400. Look up via `pi -ne --list-models [search]`.' })),
      thinking: Type.Optional(Type.String({ description: 'Pi thinking level: off|minimal|low|medium|high|xhigh.' })),
      tools: Type.Optional(Type.Array(Type.String(), { description: 'Optional allowlist of enabled tool names for the worker. spawnAgent and AgentMessage are always removed.' })),
      systemPrompt: Type.Optional(Type.String({ description: 'Optional extra system prompt appended via a temporary file.' })),
      resourceMode: Type.Optional(resourceModeSchema),
      noSession: Type.Optional(Type.Boolean({ description: 'Pass --no-session to the worker. Default true.' })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: PiContext) {
      const record = spawnRpcAgent(params as SpawnAgentParams, ctx);
      refreshAgentLedgerUi(ctx);
      return renderSingleAgentResult(record, 'Spawned agent');
    },
    renderCall(args: unknown, theme?: PiTheme) {
      const p = args as Partial<SpawnAgentParams>;
      const name = String(p.name ?? 'worker');
      const task = String(p.task ?? p.prompt ?? '');
      const taskPreview = task.length > 72 ? `${task.slice(0, 72)}\u2026` : (task || '(no task)');
      const model = p.model ? ` \u00b7 ${p.model}` : '';
      const rawLine = [
        theme?.fg('toolTitle', theme.bold('spawnAgent')) ?? 'spawnAgent',
        theme?.fg('accent', name) ?? name,
        theme?.fg('dim', `\u2014 ${taskPreview}${model}`) ?? `\u2014 ${taskPreview}${model}`,
      ].join(' ');
      return makeRenderer((w) => [truncateToWidth(rawLine, w)]);
    },
    renderResult(result: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) {
      if (opts.isPartial) {
        return makeRenderer((w) => [truncateToWidth(theme?.fg('warning', '\u29D7 Spawning agent\u2026') ?? '\u29D7 Spawning agent\u2026', w)]);
      }
      const ok = !result.isError;
      const det = result.details as { agent?: { name?: string } } | null;
      const agentName = det?.agent?.name ?? 'agent';
      const displayStatus = ok ? 'spawned' : 'failed';
      const icon = ok ? (theme?.fg('success', '\u2713') ?? '\u2713') : statusIcon('failed', theme);
      const label = theme?.fg('toolTitle', 'spawnAgent') ?? 'spawnAgent';
      const nameStr = theme?.fg('accent', agentName) ?? agentName;
      const statusStr = theme?.fg('dim', displayStatus) ?? displayStatus;
      const header = `${icon} ${label} \u00b7 ${nameStr} \u00b7 ${statusStr}`;
      if (!opts.expanded) {
        const hint = theme?.fg('dim', ' \u00b7 use AgentMessage wait/status') ?? ' \u00b7 use AgentMessage wait/status';
        return makeRenderer((w) => [truncateToWidth(`${header}${hint}`, w)]);
      }
      const text = result.content.find((p) => p.type === 'text')?.text ?? '';
      const outputLines = text.split('\n').slice(2); // skip agent-header + status lines
      return makeRenderer((w) => [
        truncateToWidth(header, w),
        ...outputLines.map((l) => truncateToWidth(theme?.fg('dim', l) ?? l, w)),
      ]);
    },
  } satisfies ToolDefinition);
  registerFn(pi, registeredToolNames, {
    name: 'AgentMessage',
    label: 'Agent: Message Parallel Worker',
    description:
      'Manage spawned agents. Actions: list, status, send, steer, followUp, wait, kill, abort. Use this after spawnAgent to coordinate parallel workers.',
    promptSnippet: 'Message, wait for, list, status, or kill spawned background agents.',
    promptGuidelines: [
      'Use AgentMessage action:"list" or action:"status" before claiming a spawned worker is done.',
      'Use AgentMessage action:"wait" to collect the current turn result. Idle means the turn ended, not necessarily that the delegated objective passed acceptance.',
      'AgentMessage reads the in-memory spawned-agent registry; after session shutdown or reload, spawn fresh workers instead of relying on old agentIds.',
      'Before final answers, wait/status every relevant worker, reconcile disagreements, and synthesize findings instead of dumping raw worker JSON.',
      'Use action:"send" to start the next idle turn; while running it defaults to followUp. action:"followUp" queues after the turn. action:"steer" redirects after current tool calls, before the next model step.',
    ],
    parameters: Type.Object({
      action: Type.Optional(actionSchema),
      agentId: Type.Optional(Type.String({ description: 'Agent id from spawnAgent. Required except for action:"list".' })),
      message: Type.Optional(Type.String({ description: 'Message for send, steer, or followUp actions.' })),
      streamingBehavior: Type.Optional(
        stringEnumSchema(
          Type,
          ['steer', 'followUp'],
          'For action:"send", how to queue if the worker is currently streaming. Defaults to followUp only while the worker is already running.',
        ),
      ),
      timeoutMs: Type.Optional(Type.Integer({ description: 'wait timeout in milliseconds. Default 300000.' })),
      remove: Type.Optional(Type.Boolean({ description: 'After kill, remove the agent record from the registry.' })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: PiContext) {
      const action = (params['action'] as MessageAction | undefined) ?? 'status';
      if (action === 'list') {
        refreshAgentLedgerUi(ctx);
        return renderAgentResult([...agents.values()], 'Spawned agents');
      }

      const record = getAgent(params['agentId']);
      if (action === 'status') {
        refreshAgentLedgerUi(ctx);
        return renderSingleAgentResult(record, 'Agent status');
      }

      if (action === 'wait') {
        if (ctx?.hasUI) ctx.ui?.setStatus?.('agent-wait', `\u29D7 Waiting for \u201C${record.name}\u201D\u2026`);
        try {
          await waitForAgent(record, Number(params['timeoutMs'] ?? 300000));
        } finally {
          if (ctx?.hasUI) ctx.ui?.setStatus?.('agent-wait', undefined);
        }
        const waitResult = renderSingleAgentResult(record, 'Agent turn completed');
        if (params['remove'] === true) agents.delete(record.id);
        refreshAgentLedgerUi(ctx);
        return waitResult;
      }

      if (action === 'kill') {
        killAgent(record);
        const result = renderSingleAgentResult(record, 'Agent killed');
        if (params['remove'] === true) agents.delete(record.id);
        refreshAgentLedgerUi(ctx);
        return result;
      }

      if (action === 'abort') {
        if (!isTerminal(record)) {
          sendRpc(record, { type: 'abort' });
          touch(record);
        }
        refreshAgentLedgerUi(ctx);
        return renderSingleAgentResult(record, 'Agent aborted');
      }

      const message = String(params['message'] ?? '').trim();
      if (!message) throw new Error(`AgentMessage action:${action} requires message.`);
      // A dead worker's stdin is destroyed — writing to it throws EPIPE and would
      // wrongly flip the record back to 'running'. Reject with a clear error instead.
      if (!isProcessAlive(record)) {
        throw new Error(
          `AgentMessage action:${action} cannot reach agent "${record.name}" — it has ${record.status} (process exited). Spawn a fresh worker.`,
        );
      }
      const wasRunning = record.status === 'running';
      touch(record, 'running');
      if (action === 'steer') {
        sendRpc(record, { type: 'steer', message });
      } else if (action === 'followUp') {
        sendRpc(record, { type: 'follow_up', message });
      } else {
        sendRpc(record, {
          type: 'prompt',
          message,
          streamingBehavior: params['streamingBehavior'] ?? (wasRunning ? 'followUp' : undefined),
        });
      }
      refreshAgentLedgerUi(ctx);
      return renderSingleAgentResult(record, 'Agent messaged');
    },
    renderCall(args: unknown, theme?: PiTheme) {
      const p = args as { action?: string; agentId?: string; message?: string };
      const action = String(p.action ?? 'status');
      const rec = p.agentId ? agents.get(p.agentId) : undefined;
      const agentLabel = rec
        ? (theme?.fg('accent', rec.name) ?? rec.name)
        : (theme?.fg('dim', p.agentId ? shortId(p.agentId) : 'all') ?? (p.agentId ? shortId(p.agentId) : 'all'));
      const msgPart = p.message
        ? (theme?.fg('dim', ` \u2014 ${p.message.slice(0, 48)}${p.message.length > 48 ? '\u2026' : ''}`) ?? ` \u2014 ${p.message.slice(0, 48)}`)
        : '';
      const rawLine = [
        theme?.fg('toolTitle', theme.bold('AgentMessage')) ?? 'AgentMessage',
        theme?.fg('accent', action) ?? action,
        agentLabel,
        msgPart,
      ].filter(Boolean).join(' ');
      return makeRenderer((w) => [truncateToWidth(rawLine, w)]);
    },
    renderResult(result: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) {
      if (opts.isPartial) {
        return makeRenderer((w) => [truncateToWidth(theme?.fg('warning', '\u29D7 Agent working\u2026') ?? '\u29D7 Agent working\u2026', w)]);
      }
      const ok = !result.isError;
      const det = result.details as {
        agent?: { name?: string; status?: AgentStatus } | null;
        agents?: Array<{ name: string; agentId: string; status: string; exitCode?: number }>;
        output?: string;
      } | null;
      if (det?.agents) {
        const squareIcon = theme?.fg('toolTitle', '\u25A6') ?? '\u25A6';
        const summaryText = formatAgentStateCounts(det.agents);
        const summary = theme?.fg('dim', summaryText) ?? summaryText;
        const header = `${squareIcon} ${theme?.fg('toolTitle', 'AgentMessage') ?? 'AgentMessage'} list \u00b7 ${summary}`;
        if (!opts.expanded) {
          return makeRenderer((w) => [truncateToWidth(header, w)]);
        }
        const text = result.content.find((p) => p.type === 'text')?.text ?? '';
        return makeRenderer((w) => [truncateToWidth(header, w), ...text.split('\n').slice(1).map((l) => truncateToWidth(theme?.fg('dim', l) ?? l, w))]);
      }
      // single-agent actions
      const agentName = det?.agent?.name ?? 'agent';
      const state = getAgentDisplayState(ok ? (det?.agent ?? { status: 'idle' }) : { status: 'failed' });
      const meta = agentDisplayMeta(state, theme);
      const label = theme?.fg('toolTitle', 'AgentMessage') ?? 'AgentMessage';
      const nameStr = theme?.fg('accent', agentName) ?? agentName;
      const header = `${meta.icon} ${label} \u00b7 ${nameStr} \u00b7 ${meta.label}`;
      if (!opts.expanded) {
        const preview = det?.output ? det.output.split('\n').find((line) => line.trim())?.trim() : '';
        const suffix = preview ? ` \u2014 ${preview}` : ' \u00b7 no output yet';
        return makeRenderer((w) => [truncateToWidth(`${header}${theme?.fg('dim', suffix) ?? suffix}`, w)]);
      }
      const text = result.content.find((p) => p.type === 'text')?.text ?? '';
      const outputLines = text.split('\n').slice(2); // skip agent-header + status lines
      return makeRenderer((w) => [
        truncateToWidth(header, w),
        ...outputLines.map((l) => truncateToWidth(theme?.fg('dim', l) ?? l, w)),
      ]);
    },
  } satisfies ToolDefinition);
}
