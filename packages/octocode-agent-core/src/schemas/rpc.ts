import { RuntimeFailure } from '../contracts/errors.js';
import type { RuntimeErrorData } from '../contracts/errors.js';
import { AGENT_EVENT_TYPES, RUNTIME_MODES, RUNTIME_OUTPUT_FORMATS, type RuntimeEvent } from '../contracts/events.js';
import type { RpcEvent, RpcRequest, RpcResponse } from '../contracts/rpc.js';

const ERROR_CATEGORIES = new Set([
  'validation', 'protocol', 'unsupported-version', 'unsupported-capability',
  'trust', 'approval', 'plan-policy', 'peer-lock', 'cancelled', 'timeout',
  'provider', 'model', 'tool-execution', 'session-conflict', 'session-corruption',
  'session-migration', 'persistence', 'compaction', 'adapter-compatibility',
  'adapter-translation', 'conflict', 'plugin', 'internal-invariant',
]);
const EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);
const EVENT_PHASES = new Set(['before', 'permission', 'after', 'notification']);
const RPC_RUNTIME_MODES: ReadonlySet<string> = new Set(RUNTIME_MODES);
const RPC_OUTPUT_FORMATS: ReadonlySet<string> = new Set(RUNTIME_OUTPUT_FORMATS);

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUsage(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'])
    && isNonNegativeInteger(value.inputTokens)
    && isNonNegativeInteger(value.outputTokens)
    && (value.cachedInputTokens === undefined || isNonNegativeInteger(value.cachedInputTokens))
    && (value.cacheWriteInputTokens === undefined || isNonNegativeInteger(value.cacheWriteInputTokens));
}

function isMappedEventPayload(type: unknown, payload: unknown): boolean {
  if (type === 'provider.request-started') {
    return isRecord(payload)
      && hasOnlyKeys(payload, ['requestId', 'iteration', 'attempt', 'maxAttempts'])
      && isNonEmptyString(payload.requestId)
      && isNonNegativeInteger(payload.iteration)
      && isNonNegativeInteger(payload.attempt)
      && isNonNegativeInteger(payload.maxAttempts);
  }
  if (type === 'provider.response-received') {
    return isRecord(payload)
      && hasOnlyKeys(payload, ['requestId', 'iteration', 'attempt', 'maxAttempts', 'durationMs', 'ttftMs', 'stop', 'usage'])
      && isNonEmptyString(payload.requestId)
      && isNonNegativeInteger(payload.iteration)
      && isNonNegativeInteger(payload.attempt)
      && isNonNegativeInteger(payload.maxAttempts)
      && isNonNegativeNumber(payload.durationMs)
      && (payload.ttftMs === undefined || isNonNegativeNumber(payload.ttftMs))
      && (payload.stop === 'complete' || payload.stop === 'tool' || payload.stop === 'cancelled' || payload.stop === 'length' || payload.stop === 'error')
      && isUsage(payload.usage);
  }
  if (type === 'provider.failed') {
    return isRecord(payload)
      && hasOnlyKeys(payload, ['requestId', 'iteration', 'attempt', 'maxAttempts', 'retrying', 'category', 'durationMs', 'delayMs', 'message'])
      && (payload.requestId === undefined || isNonEmptyString(payload.requestId))
      && isNonNegativeInteger(payload.iteration)
      && (payload.attempt === undefined || isNonNegativeInteger(payload.attempt))
      && (payload.maxAttempts === undefined || isNonNegativeInteger(payload.maxAttempts))
      && (payload.retrying === undefined || typeof payload.retrying === 'boolean')
      && (payload.category === undefined || (typeof payload.category === 'string' && ERROR_CATEGORIES.has(payload.category)))
      && (payload.durationMs === undefined || isNonNegativeNumber(payload.durationMs))
      && (payload.delayMs === undefined || isNonNegativeNumber(payload.delayMs))
      && typeof payload.message === 'string';
  }
  if (type === 'context.usage-changed') return isUsage(payload);
  return true;
}

function isRuntimeErrorData(value: unknown): value is RuntimeErrorData {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'category', 'message', 'retry', 'userVisible', 'redaction', 'terminalEffect', 'safeCause', 'retryAfterMs',
  ])) return false;
  return typeof value.category === 'string' && ERROR_CATEGORIES.has(value.category)
    && typeof value.message === 'string'
    && (value.retry === 'safe' || value.retry === 'unsafe' || value.retry === 'unknown')
    && typeof value.userVisible === 'boolean'
    && (value.redaction === 'public' || value.redaction === 'sensitive' || value.redaction === 'secret' || value.redaction === 'internal')
    && (value.terminalEffect === 'none' || value.terminalEffect === 'operation' || value.terminalEffect === 'session' || value.terminalEffect === 'runtime')
    && isOptionalString(value.safeCause)
    && (value.retryAfterMs === undefined || (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0));
}

function isModelRef(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['providerId', 'modelId'])
    && isNonEmptyString(value.providerId) && isNonEmptyString(value.modelId);
}

function isTrustSnapshot(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['workspace', 'managedOnly'])
    && (value.workspace === 'trusted' || value.workspace === 'untrusted' || value.workspace === 'unknown')
    && typeof value.managedOnly === 'boolean';
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'eventVersion', 'id', 'type', 'phase', 'sessionId', 'turnId', 'parentEventId',
    'timestamp', 'cwd', 'mode', 'outputFormat', 'model', 'trust', 'payload',
  ])) return false;
  return value.schemaVersion === 1
    && value.eventVersion === 1
    && isNonEmptyString(value.id)
    && typeof value.type === 'string' && EVENT_TYPES.has(value.type)
    && typeof value.phase === 'string' && EVENT_PHASES.has(value.phase)
    && isNonEmptyString(value.sessionId)
    && (value.turnId === undefined || isNonEmptyString(value.turnId))
    && (value.parentEventId === undefined || isNonEmptyString(value.parentEventId))
    && typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
    && typeof value.cwd === 'string'
    && typeof value.mode === 'string' && RPC_RUNTIME_MODES.has(value.mode)
    && (value.outputFormat === undefined || (typeof value.outputFormat === 'string' && RPC_OUTPUT_FORMATS.has(value.outputFormat)))
    && (value.model === undefined || isModelRef(value.model))
    && isTrustSnapshot(value.trust)
    && Object.hasOwn(value, 'payload') && value.payload !== undefined
    && isMappedEventPayload(value.type, value.payload);
}

function isRuntimeCommand(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case 'input.submit': case 'input.steer': case 'input.follow-up':
      return typeof command.text === 'string' && hasOnlyKeys(command, ['type', 'text']);
    case 'input.cancel':
      return isOptionalString(command.reason) && hasOnlyKeys(command, ['type', 'reason']);
    case 'session.create':
      return isOptionalString(command.id) && isOptionalString(command.name) && hasOnlyKeys(command, ['type', 'id', 'name']);
    case 'session.resume': case 'session.switch': case 'session.fork':
      return typeof command.id === 'string' && hasOnlyKeys(command, ['type', 'id']);
    case 'session.navigate':
      return (command.direction === 'parent' || command.direction === 'child' || command.direction === 'previous' || command.direction === 'next')
        && hasOnlyKeys(command, ['type', 'direction']);
    case 'session.name':
      return typeof command.name === 'string' && hasOnlyKeys(command, ['type', 'name']);
    case 'model.select':
      return typeof command.providerId === 'string' && typeof command.modelId === 'string'
        && hasOnlyKeys(command, ['type', 'providerId', 'modelId']);
    case 'model.thinking':
      return typeof command.level === 'string' && hasOnlyKeys(command, ['type', 'level']);
    case 'context.compact':
      return (command.reason === 'manual' || command.reason === 'threshold' || command.reason === 'overflow')
        && hasOnlyKeys(command, ['type', 'reason']);
    case 'tools.activate':
      return typeof command.name === 'string' && hasOnlyKeys(command, ['type', 'name']);
    case 'session.export': case 'context.cancel-compaction': case 'context.usage': case 'tools.list': case 'monitoring.snapshot': case 'runtime.snapshot': case 'runtime.stop':
      return hasOnlyKeys(command, ['type']);
    default:
      return false;
  }
}

export const parseRpcRequest = (input: unknown): RpcRequest => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RuntimeFailure('protocol', 'RPC request must be an object');
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== 1) throw new RuntimeFailure('unsupported-version', 'Unsupported RPC protocol major version');
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) throw new RuntimeFailure('validation', 'Malformed RPC request ID');
  if (!hasOnlyKeys(value, ['protocolVersion', 'requestId', 'command']) || !isRuntimeCommand(value.command)) throw new RuntimeFailure('validation', 'Malformed RPC command');
  return value as unknown as RpcRequest;
};

export const parseRpcResponse = (input: unknown): RpcResponse => {
  if (!isRecord(input)) throw new RuntimeFailure('protocol', 'RPC response must be an object');
  if (input.protocolVersion !== 1) throw new RuntimeFailure('unsupported-version', 'Unsupported RPC protocol major version');
  if (!isNonEmptyString(input.requestId) || typeof input.ok !== 'boolean') throw new RuntimeFailure('validation', 'Malformed RPC response');
  if (input.ok) {
    if (!hasOnlyKeys(input, ['protocolVersion', 'requestId', 'ok', 'data'])) throw new RuntimeFailure('validation', 'Malformed RPC response');
  } else if (!hasOnlyKeys(input, ['protocolVersion', 'requestId', 'ok', 'error']) || !isRuntimeErrorData(input.error)) {
    throw new RuntimeFailure('validation', 'Malformed RPC response error');
  }
  return input as unknown as RpcResponse;
};

export const parseRpcEvent = (input: unknown): RpcEvent => {
  if (!isRecord(input)) throw new RuntimeFailure('protocol', 'RPC event must be an object');
  if (input.protocolVersion !== 1) throw new RuntimeFailure('unsupported-version', 'Unsupported RPC protocol major version');
  if (!hasOnlyKeys(input, ['protocolVersion', 'sequence', 'event'])
    || !Number.isSafeInteger(input.sequence) || (input.sequence as number) <= 0) {
    throw new RuntimeFailure('validation', 'Malformed RPC event');
  }
  if (!isRuntimeEvent(input.event)) {
    const payloadInvalid = isRecord(input.event)
      && (!Object.hasOwn(input.event, 'payload') || input.event.payload === undefined || !isMappedEventPayload(input.event.type, input.event.payload));
    throw new RuntimeFailure('validation', payloadInvalid ? 'Malformed RPC event payload' : 'Malformed RPC event envelope');
  }
  return input as unknown as RpcEvent;
};
