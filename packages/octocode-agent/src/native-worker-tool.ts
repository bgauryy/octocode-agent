import { randomUUID } from 'node:crypto';
import {
  correlationId,
  createEffectSet,
  packetId,
  workerId,
  type JsonSchema,
  type SessionId,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolRegistry,
  type WorkerCapabilities,
  type WorkerCommand,
  type WorkerController,
  type WorkerId,
  type WorkerPacket,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
} from '@octocodeai/agent-core';

const MAX_TASK_CHARS = 16_384;
const MAX_TEXT_CHARS = 8_192;
const MAX_REASON_CHARS = 512;
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 4_096;
const MAX_REVISION_CHARS = 256;
const MAX_TOOLS = 32;
const MAX_TURNS = 100;
const MAX_PUBLIC_HANDBACK_CHARS = 16_384;

type WorkerAction = 'spawn' | 'list' | 'status' | 'wait' | 'send' | 'steer' | 'follow-up' | 'abort' | 'kill';
type ModelRef = { readonly providerId: string; readonly modelId: string };
type WorkspaceInput = { readonly mode: 'shared' } | { readonly mode: 'worktree'; readonly path: string; readonly baseRevision: string };

export interface NativeWorkerToolOptions {
  readonly controller: WorkerController;
  /** Immutable identity of the base prompt/configuration used by every worker spawned by this tool instance. */
  readonly promptSnapshotId: string;
  readonly allowedTools?: readonly string[];
  readonly defaultTools?: readonly string[];
  readonly allowedModels?: readonly ModelRef[];
  readonly defaultModel?: ModelRef;
  readonly defaultMaxTurns?: number;
  readonly maxWaitMs?: number;
  /** Worktrees are rejected unless the native host explicitly declares support here. */
  readonly allowWorktree?: boolean;
  /** Test seam. Generated values remain internal and are never accepted from model input. */
  readonly idFactory?: () => string;
}

interface WorkerBinding {
  readonly workerId: WorkerId;
  readonly correlationId: ReturnType<typeof correlationId>;
  readonly sessionId: SessionId;
}

interface ParsedInput {
  readonly action: WorkerAction;
  readonly workerId?: string;
  readonly task?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly model?: ModelRef;
  readonly maxTurns?: number;
  readonly workspace?: WorkspaceInput;
}

class NativeWorkerToolError extends Error {
  constructor(readonly category: 'validation' | 'not-found' | 'timeout' | 'cancelled' | 'worker', message: string) {
    super(message);
  }
}

const stringSchema = (maxLength: number, minLength = 1): JsonSchema => ({ type: 'string', minLength, maxLength });
const modelSchema: JsonSchema = {
  type: 'object',
  properties: { providerId: stringSchema(MAX_ID_CHARS), modelId: stringSchema(MAX_ID_CHARS) },
  required: ['providerId', 'modelId'],
  additionalProperties: false,
};
const workspaceSchema: JsonSchema = {
  oneOf: [
    { type: 'object', properties: { mode: { const: 'shared' } }, required: ['mode'], additionalProperties: false },
    {
      type: 'object',
      properties: { mode: { const: 'worktree' }, path: stringSchema(MAX_PATH_CHARS), baseRevision: stringSchema(MAX_REVISION_CHARS) },
      required: ['mode', 'path', 'baseRevision'],
      additionalProperties: false,
    },
  ],
};

const branch = (action: WorkerAction, properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: 'object',
  properties: { action: { const: action }, ...properties },
  required: ['action', ...required],
  additionalProperties: false,
});

export const NATIVE_WORKER_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    branch('spawn', {
      task: stringSchema(MAX_TASK_CHARS),
      tools: { type: 'array', items: stringSchema(MAX_ID_CHARS), maxItems: MAX_TOOLS, uniqueItems: true },
      model: modelSchema,
      maxTurns: { type: 'integer', minimum: 1, maximum: MAX_TURNS },
      workspace: workspaceSchema,
    }, ['task']),
    branch('list', {}, []),
    branch('status', { workerId: stringSchema(MAX_ID_CHARS) }, ['workerId']),
    branch('wait', { workerId: stringSchema(MAX_ID_CHARS), timeoutMs: { type: 'integer', minimum: 1 } }, ['workerId']),
    branch('send', { workerId: stringSchema(MAX_ID_CHARS), text: stringSchema(MAX_TEXT_CHARS) }, ['workerId', 'text']),
    branch('steer', { workerId: stringSchema(MAX_ID_CHARS), text: stringSchema(MAX_TEXT_CHARS) }, ['workerId', 'text']),
    branch('follow-up', { workerId: stringSchema(MAX_ID_CHARS), text: stringSchema(MAX_TEXT_CHARS) }, ['workerId', 'text']),
    branch('abort', { workerId: stringSchema(MAX_ID_CHARS), reason: stringSchema(MAX_REASON_CHARS) }, ['workerId']),
    branch('kill', { workerId: stringSchema(MAX_ID_CHARS), reason: stringSchema(MAX_REASON_CHARS) }, ['workerId']),
  ],
};

const publicWorkerSchema: JsonSchema = {
  type: 'object',
  properties: {
    workerId: { type: 'string' }, correlationId: { type: 'string' }, state: { type: 'string' }, queueDepth: { type: 'integer' },
    terminal: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        hasHandback: { type: 'boolean' },
        hasReason: { type: 'boolean' },
        handback: {
          type: 'object',
          properties: {
            summary: { type: 'string', maxLength: MAX_PUBLIC_HANDBACK_CHARS },
            text: { type: 'string', maxLength: MAX_PUBLIC_HANDBACK_CHARS },
            truncated: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['outcome', 'hasHandback', 'hasReason'],
      additionalProperties: false,
    },
  },
  required: ['workerId', 'correlationId', 'state', 'queueDepth'],
  additionalProperties: false,
};

export const NATIVE_WORKER_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    worker: { anyOf: [publicWorkerSchema, { type: 'null' }] },
    workers: { type: 'array', items: publicWorkerSchema },
    acknowledged: { type: 'boolean' },
  },
  required: ['action'],
  additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new NativeWorkerToolError('validation', `${name} must contain 1-${max} characters`);
  return value;
}

function integer(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new NativeWorkerToolError('validation', `${name} must be an integer from 1 to ${max}`);
  return value as number;
}

function assertOnly(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new NativeWorkerToolError('validation', `Unknown field: ${unknown}`);
}

function parseWorkspace(value: unknown, allowWorktree: boolean): WorkspaceInput {
  if (!isRecord(value)) throw new NativeWorkerToolError('validation', 'workspace must be an object');
  if (value['mode'] === 'shared') { assertOnly(value, ['mode']); return { mode: 'shared' }; }
  if (value['mode'] !== 'worktree') throw new NativeWorkerToolError('validation', 'workspace mode is invalid');
  if (!allowWorktree) throw new NativeWorkerToolError('validation', 'Worktree worker isolation is unavailable');
  assertOnly(value, ['mode', 'path', 'baseRevision']);
  return {
    mode: 'worktree',
    path: boundedString(value['path'], 'workspace.path', MAX_PATH_CHARS),
    baseRevision: boundedString(value['baseRevision'], 'workspace.baseRevision', MAX_REVISION_CHARS),
  };
}

function parseInput(value: unknown, options: { allowWorktree: boolean; maxWaitMs: number }): ParsedInput {
  if (!isRecord(value)) throw new NativeWorkerToolError('validation', 'Worker input must be an object');
  const action = value['action'];
  if (action !== 'spawn' && action !== 'list' && action !== 'status' && action !== 'wait' && action !== 'send' && action !== 'steer' && action !== 'follow-up' && action !== 'abort' && action !== 'kill') {
    throw new NativeWorkerToolError('validation', 'Worker action is invalid');
  }
  if (action === 'list') { assertOnly(value, ['action']); return { action }; }
  if (action === 'spawn') {
    assertOnly(value, ['action', 'task', 'tools', 'model', 'maxTurns', 'workspace']);
    let tools: readonly string[] | undefined;
    if (value['tools'] !== undefined) {
      if (!Array.isArray(value['tools']) || value['tools'].length > MAX_TOOLS) throw new NativeWorkerToolError('validation', `tools must contain at most ${MAX_TOOLS} entries`);
      tools = value['tools'].map((tool) => boundedString(tool, 'tool', MAX_ID_CHARS));
      if (new Set(tools).size !== tools.length) throw new NativeWorkerToolError('validation', 'tools must be unique');
    }
    let model: ModelRef | undefined;
    if (value['model'] !== undefined) {
      if (!isRecord(value['model'])) throw new NativeWorkerToolError('validation', 'model must be an object');
      assertOnly(value['model'], ['providerId', 'modelId']);
      model = { providerId: boundedString(value['model']['providerId'], 'model.providerId', MAX_ID_CHARS), modelId: boundedString(value['model']['modelId'], 'model.modelId', MAX_ID_CHARS) };
    }
    return {
      action,
      task: boundedString(value['task'], 'task', MAX_TASK_CHARS),
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
      ...(value['maxTurns'] === undefined ? {} : { maxTurns: integer(value['maxTurns'], 'maxTurns', MAX_TURNS) }),
      ...(value['workspace'] === undefined ? {} : { workspace: parseWorkspace(value['workspace'], options.allowWorktree) }),
    };
  }
  const worker = boundedString(value['workerId'], 'workerId', MAX_ID_CHARS);
  if (action === 'status') { assertOnly(value, ['action', 'workerId']); return { action, workerId: worker }; }
  if (action === 'wait') {
    assertOnly(value, ['action', 'workerId', 'timeoutMs']);
    return { action, workerId: worker, ...(value['timeoutMs'] === undefined ? {} : { timeoutMs: integer(value['timeoutMs'], 'timeoutMs', options.maxWaitMs) }) };
  }
  if (action === 'send' || action === 'steer' || action === 'follow-up') {
    assertOnly(value, ['action', 'workerId', 'text']);
    return { action, workerId: worker, text: boundedString(value['text'], 'text', MAX_TEXT_CHARS) };
  }
  assertOnly(value, ['action', 'workerId', 'reason']);
  return { action, workerId: worker, ...(value['reason'] === undefined ? {} : { reason: boundedString(value['reason'], 'reason', MAX_REASON_CHARS) }) };
}

function publicHandback(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const summary = typeof value['summary'] === 'string' ? value['summary'] : undefined;
  const text = typeof value['text'] === 'string' ? value['text'] : undefined;
  if (summary === undefined && text === undefined) return undefined;
  let remaining = MAX_PUBLIC_HANDBACK_CHARS;
  const publicSummary = summary?.slice(0, remaining);
  remaining -= publicSummary?.length ?? 0;
  const publicText = text?.slice(0, remaining);
  const truncated = (summary?.length ?? 0) + (text?.length ?? 0) > MAX_PUBLIC_HANDBACK_CHARS;
  return {
    ...(publicSummary === undefined ? {} : { summary: publicSummary }),
    ...(publicText === undefined ? {} : { text: publicText }),
    ...(truncated ? { truncated: true } : {}),
  };
}

function publicTerminal(value: WorkerTerminalPacket): Record<string, unknown> {
  const handback = publicHandback(value.handback);
  return {
    outcome: value.outcome,
    hasHandback: value.handback !== undefined,
    hasReason: value.reason !== undefined,
    ...(handback === undefined ? {} : { handback }),
  };
}

function publicWorker(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value['workerId'] !== 'string' || typeof value['correlationId'] !== 'string' || typeof value['state'] !== 'string' || !Number.isInteger(value['queueDepth'])) return null;
  const terminal = isRecord(value['terminal']) && value['terminal']['type'] === 'worker.terminal'
    ? publicTerminal(value['terminal'] as unknown as WorkerTerminalPacket)
    : undefined;
  return {
    workerId: value['workerId'],
    correlationId: value['correlationId'],
    state: value['state'],
    queueDepth: value['queueDepth'],
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function publicTerminalWorker(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value['type'] !== 'worker.terminal' || typeof value['workerId'] !== 'string' || typeof value['correlationId'] !== 'string' || typeof value['outcome'] !== 'string') return null;
  return { workerId: value['workerId'], correlationId: value['correlationId'], state: value['outcome'], queueDepth: 0, terminal: publicTerminal(value as unknown as WorkerTerminalPacket) };
}

function waitBounded<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new NativeWorkerToolError('cancelled', 'Worker operation cancelled')); return; }
    const timer = setTimeout(() => finish(() => reject(new NativeWorkerToolError('timeout', `Worker wait timed out after ${timeoutMs}ms`))), timeoutMs);
    const onAbort = (): void => finish(() => reject(new NativeWorkerToolError('cancelled', 'Worker operation cancelled')));
    const finish = (settle: () => void): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); settle(); };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((value) => finish(() => resolve(value)), () => finish(() => reject(new NativeWorkerToolError('worker', 'Worker operation failed'))));
  });
}

export function createNativeWorkerTool(options: NativeWorkerToolOptions): ToolDefinition {
  const promptSnapshotId = boundedString(options.promptSnapshotId, 'promptSnapshotId', 512);
  const idFactory = options.idFactory ?? randomUUID;
  const allowedTools = new Set(options.allowedTools ?? []);
  const allowedModels = new Set((options.allowedModels ?? []).map((model) => `${model.providerId}\0${model.modelId}`));
  const defaultTools = [...(options.defaultTools ?? [])];
  const defaultModel = options.defaultModel === undefined ? undefined : { ...options.defaultModel };
  const defaultMaxTurns = integer(options.defaultMaxTurns ?? 16, 'defaultMaxTurns', MAX_TURNS);
  const maxWaitMs = integer(options.maxWaitMs ?? 300_000, 'maxWaitMs', 3_600_000);
  for (const tool of defaultTools) if (!allowedTools.has(tool)) throw new NativeWorkerToolError('validation', `Default tool is not allowed: ${tool}`);
  if (defaultModel !== undefined && !allowedModels.has(`${defaultModel.providerId}\0${defaultModel.modelId}`)) throw new NativeWorkerToolError('validation', 'Default model is not allowed');
  const bindings = new Map<string, WorkerBinding>();

  const requireBinding = (id: string, session: SessionId): WorkerBinding => {
    const binding = bindings.get(id);
    if (binding === undefined || binding.sessionId !== session) throw new NativeWorkerToolError('not-found', 'Worker not found in this session');
    return binding;
  };

  const execute = async (request: ToolExecutionInput): Promise<Record<string, unknown>> => {
    const input = parseInput(request.input, { allowWorktree: options.allowWorktree === true, maxWaitMs });
    await request.update({ version: 1, kind: 'status', message: `Worker ${input.action}` });
    if (input.action === 'spawn') {
      const tools = input.tools ?? defaultTools;
      for (const tool of tools) if (!allowedTools.has(tool)) throw new NativeWorkerToolError('validation', `Tool is not allowed: ${tool}`);
      const model = input.model ?? defaultModel;
      if (model !== undefined && !allowedModels.has(`${model.providerId}\0${model.modelId}`)) throw new NativeWorkerToolError('validation', 'Model is not allowed');
      const binding: WorkerBinding = { workerId: workerId(idFactory()), correlationId: correlationId(idFactory()), sessionId: request.context.sessionId };
      const capabilities: WorkerCapabilities = { tools: [...tools], models: model === undefined ? [] : [{ ...model }], maxTurns: input.maxTurns ?? defaultMaxTurns };
      const packet: WorkerSpawnPacket = Object.freeze({
        schemaVersion: 1,
        type: 'worker.spawn',
        packetId: packetId(idFactory()),
        ...binding,
        redaction: 'sensitive',
        prompt: input.task!,
        promptSnapshotId,
        workspace: input.workspace ?? { mode: 'shared' as const },
        capabilities: Object.freeze({ ...capabilities, tools: Object.freeze([...capabilities.tools]), models: Object.freeze(capabilities.models.map((item) => Object.freeze({ ...item }))) }),
      });
      bindings.set(binding.workerId, binding);
      try {
        const result = await options.controller.execute({ type: 'spawn', packet });
        return { action: 'spawn', worker: publicWorker(result) ?? { workerId: binding.workerId, correlationId: binding.correlationId, state: 'queued', queueDepth: 0 } };
      } catch {
        bindings.delete(binding.workerId);
        throw new NativeWorkerToolError('worker', 'Worker spawn failed');
      }
    }
    if (input.action === 'list') {
      let result: unknown;
      try { result = await options.controller.execute({ type: 'list' }); }
      catch { throw new NativeWorkerToolError('worker', 'Worker list failed'); }
      const workers = Array.isArray(result) ? result.filter((item) => isRecord(item) && typeof item['workerId'] === 'string' && bindings.get(item['workerId'])?.sessionId === request.context.sessionId).map(publicWorker).filter((item): item is Record<string, unknown> => item !== null) : [];
      return { action: 'list', workers };
    }
    const binding = requireBinding(input.workerId!, request.context.sessionId);
    let command: WorkerCommand;
    if (input.action === 'send' || input.action === 'steer' || input.action === 'follow-up') {
      const packet: WorkerPacket = Object.freeze({ schemaVersion: 1, type: `worker.${input.action}`, packetId: packetId(idFactory()), ...binding, redaction: 'sensitive', text: input.text! });
      command = { type: input.action, packet };
    } else if (input.action === 'status' || input.action === 'wait') command = { type: input.action, workerId: binding.workerId };
    else command = { type: input.action, workerId: binding.workerId, ...(input.reason === undefined ? {} : { reason: input.reason }) };
    try {
      const operation = options.controller.execute(command);
      const result = input.action === 'wait' ? await waitBounded(operation, input.timeoutMs ?? maxWaitMs, request.signal) : await operation;
      if (input.action === 'status') return { action: input.action, worker: publicWorker(result) };
      if (input.action === 'wait') return { action: input.action, worker: publicTerminalWorker(result) };
      return { action: input.action, acknowledged: true };
    } catch (error) {
      if (error instanceof NativeWorkerToolError) throw error;
      throw new NativeWorkerToolError('worker', `Worker ${input.action} failed`);
    }
  };

  return {
    name: 'worker',
    label: 'Worker',
    description: 'Manage bounded native subagents through one correlated, session-scoped lifecycle surface.',
    schemaVersion: 1,
    inputSchema: NATIVE_WORKER_INPUT_SCHEMA,
    outputSchema: NATIVE_WORKER_OUTPUT_SCHEMA,
    outputVersion: 1,
    policy: { effects: createEffectSet('process'), trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    presentation: { callLabel: 'Worker action', resultLabel: 'Worker result' },
    async execute(request) {
      const content = await execute(request);
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeWorkerTool(registry: ToolRegistry, options: NativeWorkerToolOptions): ToolDefinition {
  const tool = createNativeWorkerTool(options);
  registry.register(tool, 'native-worker');
  return tool;
}
