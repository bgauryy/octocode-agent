import { createHash } from 'node:crypto';
import { correlationId, packetId, sessionId, workerId } from '@octocodeai/agent-core';
import type {
  CorrelationId,
  SessionId,
  WorkerAuthorityV1,
  WorkerId,
  WorkerCommand,
  WorkerController,
  WorkerPacket,
  WorkerSnapshot,
  WorkerSpawnPacket,
  WorkerTerminalPacket,
} from '@octocodeai/agent-core';

const MAX_PUBLIC_HANDBACK_CHARS = 4_096;
const MAX_ID_CHARS = 512;
const MAX_PROMPT_CHARS = 65_536;
const MAX_TEXT_CHARS = 32_768;
const MAX_REASON_CHARS = 4_096;
const MAX_TOOLS = 128;
const MAX_MODELS = 64;
const MAX_TURNS = 1_000;
const RECURSIVE_TOOLS = new Set(['worker', 'spawnAgent', 'spawnSubagent', 'AgentMessage']);

type NativeWorkerProjectionSpawnPacket = Omit<WorkerSpawnPacket, 'authority'>;
type NativeWorkerProjectionPacket = Omit<WorkerPacket, 'authority'>;
export type NativeWorkerProjectionCommand =
  | { readonly type: 'spawn'; readonly packet: NativeWorkerProjectionSpawnPacket }
  | { readonly type: 'list' }
  | {
      readonly type: 'status' | 'wait' | 'abort' | 'kill';
      readonly workerId: WorkerId;
      readonly reason?: string;
    }
  | {
      readonly type: 'send' | 'steer' | 'follow-up';
      readonly packet: NativeWorkerProjectionPacket;
    };

export interface NativeWorkerProjectionRequest {
  readonly protocolVersion: 1;
  readonly projection: 'worker';
  readonly requestId: string;
  readonly sessionId: SessionId;
  readonly correlationId?: CorrelationId;
  readonly command: NativeWorkerProjectionCommand;
}

export type NativeWorkerProjectionResponse =
  | { readonly protocolVersion: 1; readonly projection: 'worker'; readonly requestId: string; readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly protocolVersion: 1; readonly projection: 'worker'; readonly requestId: string; readonly ok: false; readonly error: { readonly category: 'validation' | 'correlation' | 'recursion' | 'capability' | 'approval' | 'worker'; readonly message: string } };
type NativeWorkerProjectionErrorCategory = Extract<NativeWorkerProjectionResponse, { ok: false }>['error']['category'];

export interface NativeWorkerProjectionAuthorizationRequest {
  readonly sessionId: SessionId;
  readonly command: WorkerCommand;
  readonly policy: {
    readonly effect: 'process';
    readonly trust: 'workspace';
    readonly approval: 'on-request';
  };
}

export interface NativeWorkerProjectionOptions {
  readonly activeSessionId: SessionId;
  readonly promptSnapshotId: string;
  readonly capabilities: WorkerSpawnPacket['capabilities'];
  readonly resolveAuthority: (request: {
    readonly sessionId: SessionId;
    readonly workerId: WorkerId;
    readonly correlationId: CorrelationId;
    readonly commandType: Exclude<WorkerCommand['type'], 'list' | 'shutdown'>;
  }) => WorkerAuthorityV1 | undefined;
  readonly authorize?: (request: NativeWorkerProjectionAuthorizationRequest) => Promise<boolean>;
}

export interface NativeWorkerEditorUpdate {
  readonly kind: 'worker';
  readonly requestId: string;
  readonly action: string;
  readonly worker?: unknown;
  readonly workers?: unknown;
  readonly acknowledged?: boolean;
}

export interface NativeWorkerEditorProjection {
  execute(input: unknown): Promise<{
    readonly response: NativeWorkerProjectionResponse;
    readonly update?: NativeWorkerEditorUpdate;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} must be closed`);
}

function bounded(value: unknown, label: string, max = MAX_ID_CHARS): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function parsePacket(value: unknown, expected: WorkerPacketType): NativeWorkerProjectionSpawnPacket | NativeWorkerProjectionPacket {
  if (!isRecord(value)) throw new Error('worker packet must be an object');
  const common = ['schemaVersion', 'type', 'packetId', 'workerId', 'correlationId', 'sessionId', 'redaction'];
  const input = expected === 'worker.spawn' ? [...common, 'prompt', 'promptSnapshotId', 'workspace', 'capabilities'] : [...common, 'text'];
  closed(value, input, 'worker packet');
  if (value['schemaVersion'] !== 1 || value['type'] !== expected) throw new Error('worker packet version or type is invalid');
  if (!['public', 'sensitive', 'secret', 'internal'].includes(String(value['redaction']))) throw new Error('worker packet redaction is invalid');
  const base = {
    schemaVersion: 1 as const,
    packetId: packetId(bounded(value['packetId'], 'packetId')),
    workerId: workerId(bounded(value['workerId'], 'workerId')),
    correlationId: correlationId(bounded(value['correlationId'], 'correlationId')),
    sessionId: sessionId(bounded(value['sessionId'], 'sessionId')),
    redaction: value['redaction'] as WorkerSpawnPacket['redaction'],
  };
  if (expected !== 'worker.spawn') {
    return { ...base, type: expected, text: bounded(value['text'], 'worker text', MAX_TEXT_CHARS) } as NativeWorkerProjectionPacket;
  }
  if (!isRecord(value['workspace'])) throw new Error('worker workspace must be an object');
  const workspaceValue = value['workspace'];
  let workspace: WorkerSpawnPacket['workspace'];
  if (workspaceValue['mode'] === 'shared') {
    closed(workspaceValue, ['mode'], 'worker workspace');
    workspace = { mode: 'shared' };
  } else if (workspaceValue['mode'] === 'worktree') {
    closed(workspaceValue, ['mode', 'path', 'baseRevision'], 'worker workspace');
    workspace = { mode: 'worktree', path: bounded(workspaceValue['path'], 'worktree path', 4_096), baseRevision: bounded(workspaceValue['baseRevision'], 'base revision') };
  } else throw new Error('worker workspace mode is invalid');
  if (!isRecord(value['capabilities'])) throw new Error('worker capabilities must be an object');
  const capabilitiesValue = value['capabilities'];
  closed(capabilitiesValue, ['tools', 'models', 'maxTurns'], 'worker capabilities');
  if (!Array.isArray(capabilitiesValue['tools']) || capabilitiesValue['tools'].length > MAX_TOOLS) throw new Error('worker tools are invalid');
  if (!Array.isArray(capabilitiesValue['models']) || capabilitiesValue['models'].length > MAX_MODELS) throw new Error('worker models are invalid');
  const maxTurns = capabilitiesValue['maxTurns'];
  if (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1 || (maxTurns as number) > MAX_TURNS) throw new Error('worker maxTurns is invalid');
  const models = capabilitiesValue['models'].map((model) => {
    if (!isRecord(model)) throw new Error('worker model is invalid');
    closed(model, ['providerId', 'modelId'], 'worker model');
    return { providerId: bounded(model['providerId'], 'providerId'), modelId: bounded(model['modelId'], 'modelId') };
  });
  return {
    ...base,
    type: 'worker.spawn',
    prompt: bounded(value['prompt'], 'worker prompt', MAX_PROMPT_CHARS),
    promptSnapshotId: bounded(value['promptSnapshotId'], 'promptSnapshotId'),
    workspace,
    capabilities: { tools: capabilitiesValue['tools'].map((tool) => bounded(tool, 'worker tool')), models, maxTurns: maxTurns as number },
  };
}

type WorkerPacketType = 'worker.spawn' | 'worker.send' | 'worker.steer' | 'worker.follow-up';

function parseWorkerCommand(value: unknown): NativeWorkerProjectionCommand {
  if (!isRecord(value) || typeof value['type'] !== 'string') throw new Error('worker command must be an object');
  switch (value['type']) {
    case 'spawn':
      closed(value, ['type', 'packet'], 'worker command');
      return { type: 'spawn', packet: parsePacket(value['packet'], 'worker.spawn') as NativeWorkerProjectionSpawnPacket };
    case 'list':
      closed(value, ['type'], 'worker command');
      return { type: 'list' };
    case 'status': case 'wait':
      closed(value, ['type', 'workerId'], 'worker command');
      return { type: value['type'], workerId: workerId(bounded(value['workerId'], 'workerId')) };
    case 'abort': case 'kill': {
      closed(value, ['type', 'workerId', 'reason'], 'worker command');
      const reason = value['reason'] === undefined ? undefined : bounded(value['reason'], 'reason', MAX_REASON_CHARS);
      return { type: value['type'], workerId: workerId(bounded(value['workerId'], 'workerId')), ...(reason === undefined ? {} : { reason }) };
    }
    case 'send': case 'steer': case 'follow-up':
      closed(value, ['type', 'packet'], 'worker command');
      return { type: value['type'], packet: parsePacket(value['packet'], `worker.${value['type']}` as WorkerPacketType) as WorkerPacket };
    case 'shutdown':
      throw new Error('worker shutdown is unavailable over transport');
    default:
      throw new Error('worker command type is invalid');
  }
}

export function parseNativeWorkerProjectionRequest(input: unknown): NativeWorkerProjectionRequest {
  if (!isRecord(input)) throw new Error('worker projection envelope must be an object');
  closed(input, ['protocolVersion', 'projection', 'requestId', 'sessionId', 'correlationId', 'command'], 'worker projection envelope');
  if (input['protocolVersion'] !== 1 || input['projection'] !== 'worker') throw new Error('worker projection version is unsupported');
  const command = parseWorkerCommand(input['command']);
  const parsedCorrelation = input['correlationId'] === undefined ? undefined : correlationId(bounded(input['correlationId'], 'correlationId'));
  if (command.type !== 'list' && parsedCorrelation === undefined) throw new Error('worker projection correlationId is required');
  return {
    protocolVersion: 1,
    projection: 'worker',
    requestId: bounded(input['requestId'], 'requestId'),
    sessionId: sessionId(bounded(input['sessionId'], 'sessionId')),
    ...(parsedCorrelation === undefined ? {} : { correlationId: parsedCorrelation }),
    command,
  };
}

function terminalProjection(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value['outcome'] !== 'string') return undefined;
  const result: Record<string, unknown> = { outcome: value['outcome'], hasReason: typeof value['reason'] === 'string' };
  const handback = value['handback'];
  if (!isRecord(handback)) return result;
  const source = typeof handback['summary'] === 'string' ? handback['summary'] : typeof handback['text'] === 'string' ? handback['text'] : undefined;
  if (source === undefined) return { ...result, hasHandback: false };
  return {
    ...result,
    hasHandback: true,
    handback: {
      text: source.slice(0, MAX_PUBLIC_HANDBACK_CHARS),
      sha256: digest(source),
      truncated: source.length > MAX_PUBLIC_HANDBACK_CHARS,
    },
  };
}

function workerProjection(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)
    || typeof value['workerId'] !== 'string'
    || typeof value['correlationId'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['state'] !== 'string'
    || !Number.isSafeInteger(value['queueDepth'])) return undefined;
  const terminal = terminalProjection(value['terminal']);
  return {
    workerId: value['workerId'],
    correlationId: value['correlationId'],
    state: value['state'],
    queueDepth: value['queueDepth'],
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function identity(command: NativeWorkerProjectionCommand): Pick<WorkerSpawnPacket, 'sessionId' | 'correlationId'> | undefined {
  if (command.type === 'spawn') return command.packet;
  if (command.type === 'send' || command.type === 'steer' || command.type === 'follow-up') return command.packet;
  return undefined;
}

function recursive(packet: NativeWorkerProjectionSpawnPacket): boolean {
  return packet.capabilities.tools.some((tool) => RECURSIVE_TOOLS.has(tool));
}

function failure(requestId: string, category: NativeWorkerProjectionErrorCategory, message: string): NativeWorkerProjectionResponse {
  return { protocolVersion: 1, projection: 'worker', requestId, ok: false, error: { category, message } };
}

function success(requestId: string, data: Record<string, unknown>): NativeWorkerProjectionResponse {
  return { protocolVersion: 1, projection: 'worker', requestId, ok: true, data };
}

function mutating(command: NativeWorkerProjectionCommand | WorkerCommand): boolean {
  return command.type === 'spawn' || command.type === 'send' || command.type === 'steer'
    || command.type === 'follow-up' || command.type === 'abort' || command.type === 'kill';
}

function withinCapabilities(packet: NativeWorkerProjectionSpawnPacket, options: NativeWorkerProjectionOptions): boolean {
  if (packet.promptSnapshotId !== options.promptSnapshotId) return false;
  if (packet.capabilities.maxTurns > options.capabilities.maxTurns) return false;
  const tools = new Set(options.capabilities.tools);
  if (packet.capabilities.tools.some((tool) => !tools.has(tool))) return false;
  const models = new Set(options.capabilities.models.map((model) => `${model.providerId}\0${model.modelId}`));
  return packet.capabilities.models.every((model) => models.has(`${model.providerId}\0${model.modelId}`));
}

function carriesCallerAuthority(command: NativeWorkerProjectionCommand): boolean {
  if ('authority' in (command as unknown as Record<string, unknown>)) return true;
  return 'packet' in command
    && 'authority' in (command.packet as unknown as Record<string, unknown>);
}

/** Session-bound transport projection; core WorkerSupervisor remains lifecycle authority. */
export class NativeWorkerTransportProjection {
  constructor(readonly controller: WorkerController, readonly options: NativeWorkerProjectionOptions) {}

  async execute(request: NativeWorkerProjectionRequest): Promise<NativeWorkerProjectionResponse> {
    if (request.protocolVersion !== 1 || !request.requestId.trim()) return failure(request.requestId, 'validation', 'Invalid worker projection request');
    if (request.sessionId !== this.options.activeSessionId) return failure(request.requestId, 'correlation', 'Worker projection session does not match the active runtime');
    if (carriesCallerAuthority(request.command)) return failure(request.requestId, 'validation', 'Caller-supplied worker authority is forbidden');
    const commandIdentity = identity(request.command);
    if (commandIdentity !== undefined && (commandIdentity.sessionId !== request.sessionId || commandIdentity.correlationId !== request.correlationId)) {
      return failure(request.requestId, 'correlation', 'Worker command identity does not match its transport scope');
    }
    if (request.command.type === 'spawn' && recursive(request.command.packet)) {
      return failure(request.requestId, 'recursion', 'Workers cannot receive worker-management capabilities');
    }
    if (request.command.type === 'spawn' && !withinCapabilities(request.command.packet, this.options)) {
      return failure(request.requestId, 'capability', 'Worker spawn exceeds the active runtime capability envelope');
    }
    try {
      if (request.command.type === 'list') {
        const listed = await this.controller.execute(request.command);
        const workers = Array.isArray(listed)
          ? listed.filter((value) => isRecord(value) && value['sessionId'] === request.sessionId).map(workerProjection).filter((value): value is Record<string, unknown> => value !== undefined)
          : [];
        return success(request.requestId, { action: 'list', workers });
      }
      const command = this.#trustedCommand(request);
      if (command === undefined)
        return failure(request.requestId, 'approval', 'Trusted worker authority is unavailable');
      if (command.type === 'spawn') {
        if (!await this.#authorize(command)) return failure(request.requestId, 'approval', 'Worker process operation was not approved');
        const result = await this.controller.execute(command);
        return success(request.requestId, { action: 'spawn', worker: workerProjection(result) ?? null });
      }
      if (command.type === 'send' || command.type === 'steer' || command.type === 'follow-up') {
        if (!await this.#authorize(command)) return failure(request.requestId, 'approval', 'Worker process operation was not approved');
        await this.controller.execute(command);
        return success(request.requestId, { action: command.type, acknowledged: true });
      }
      if (!('workerId' in command)) return failure(request.requestId, 'validation', 'Worker command is not addressable');
      const status = await this.controller.execute({ type: 'status', workerId: command.workerId, authority: command.authority });
      if (!isRecord(status) || status['sessionId'] !== request.sessionId || status['correlationId'] !== request.correlationId) {
        return failure(request.requestId, 'correlation', 'Worker does not match its transport scope');
      }
      if (command.type === 'status') {
        return success(request.requestId, { action: 'status', worker: workerProjection(status) ?? null });
      }
      if (mutating(command) && !await this.#authorize(command)) return failure(request.requestId, 'approval', 'Worker process operation was not approved');
      const result = await this.controller.execute(command);
      if (command.type === 'wait') {
        const snapshot = { ...status, terminal: result as WorkerTerminalPacket, state: isRecord(result) && typeof result['outcome'] === 'string' ? result['outcome'] : status['state'] } as unknown as WorkerSnapshot;
        return success(request.requestId, { action: 'wait', worker: workerProjection(snapshot) ?? null });
      }
      return success(request.requestId, { action: command.type, acknowledged: true });
    } catch {
      return failure(request.requestId, 'worker', 'Worker operation failed');
    }
  }

  #trustedCommand(
    request: NativeWorkerProjectionRequest,
  ): WorkerCommand | undefined {
    const projected = request.command;
    if (projected.type === 'list') return projected;
    const worker = 'packet' in projected
      ? projected.packet.workerId
      : projected.workerId;
    const correlation = 'packet' in projected
      ? projected.packet.correlationId
      : request.correlationId;
    if (correlation === undefined) return undefined;
    const authority = this.options.resolveAuthority({
      sessionId: request.sessionId,
      workerId: worker,
      correlationId: correlation,
      commandType: projected.type,
    });
    if (
      authority === undefined ||
      authority.workerId !== worker ||
      authority.correlationId !== correlation ||
      authority.parentSessionId !== request.sessionId
    )
      return undefined;
    if (projected.type === 'spawn')
      return { type: 'spawn', packet: { ...projected.packet, authority } };
    if ('packet' in projected)
      return { type: projected.type, packet: { ...projected.packet, authority } };
    if (projected.type === 'status' || projected.type === 'wait')
      return { type: projected.type, workerId: projected.workerId, authority };
    return {
      type: projected.type,
      workerId: projected.workerId,
      authority,
      ...(projected.reason === undefined ? {} : { reason: projected.reason }),
    };
  }

  async #authorize(command: WorkerCommand): Promise<boolean> {
    if (!mutating(command) || this.options.authorize === undefined) return false;
    try {
      return await this.options.authorize({
        sessionId: this.options.activeSessionId,
        command,
        policy: { effect: 'process', trust: 'workspace', approval: 'on-request' },
      });
    } catch {
      return false;
    }
  }
}

export function toNativeWorkerEditorUpdate(response: NativeWorkerProjectionResponse): NativeWorkerEditorUpdate | undefined {
  if (!response.ok || typeof response.data['action'] !== 'string') return undefined;
  return {
    kind: 'worker',
    requestId: response.requestId,
    action: response.data['action'],
    ...(response.data['worker'] === undefined ? {} : { worker: response.data['worker'] }),
    ...(response.data['workers'] === undefined ? {} : { workers: response.data['workers'] }),
    ...(typeof response.data['acknowledged'] !== 'boolean' ? {} : { acknowledged: response.data['acknowledged'] }),
  };
}

/** Editor/ACP seam that deliberately reuses the RPC parser, authorization, and projection. */
export function createNativeWorkerEditorProjection(projection: NativeWorkerTransportProjection): NativeWorkerEditorProjection {
  return {
    async execute(input) {
      let request: NativeWorkerProjectionRequest;
      try {
        request = parseNativeWorkerProjectionRequest(input);
      } catch (error) {
        const requestId = isRecord(input) && typeof input['requestId'] === 'string' ? input['requestId'] : 'invalid-worker-request';
        const response = failure(requestId, 'validation', error instanceof Error ? error.message : 'Invalid worker projection request');
        return { response };
      }
      const response = await projection.execute(request);
      const update = toNativeWorkerEditorUpdate(response);
      return { response, ...(update === undefined ? {} : { update }) };
    },
  };
}

/** Routes editor/ACP commands to the projection owned by their canonical session. */
export function createNativeWorkerEditorProjectionResolver(
  resolve: (session: SessionId) => NativeWorkerTransportProjection | undefined,
): NativeWorkerEditorProjection {
  return {
    async execute(input) {
      let request: NativeWorkerProjectionRequest;
      try {
        request = parseNativeWorkerProjectionRequest(input);
      } catch (error) {
        const requestId = isRecord(input) && typeof input['requestId'] === 'string' ? input['requestId'] : 'invalid-worker-request';
        return { response: failure(requestId, 'validation', error instanceof Error ? error.message : 'Invalid worker projection request') };
      }
      const projection = resolve(request.sessionId);
      if (projection === undefined) return { response: failure(request.requestId, 'correlation', 'Worker projection is unavailable for the ACP session') };
      return createNativeWorkerEditorProjection(projection).execute(request);
    },
  };
}
