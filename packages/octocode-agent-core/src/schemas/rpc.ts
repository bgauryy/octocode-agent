import { RuntimeFailure } from '../contracts/errors.js';
import type { RuntimeErrorData } from '../contracts/errors.js';
import type { RuntimeEvent } from '../contracts/events.js';
import type { RpcEvent, RpcRequest, RpcResponse } from '../contracts/rpc.js';

const ERROR_CATEGORIES = new Set([
  'validation', 'protocol', 'unsupported-version', 'unsupported-capability',
  'trust', 'approval', 'plan-policy', 'peer-lock', 'cancelled', 'timeout',
  'provider', 'model', 'tool-execution', 'session-conflict', 'session-corruption',
  'session-migration', 'persistence', 'compaction', 'adapter-compatibility',
  'adapter-translation', 'conflict', 'plugin', 'internal-invariant',
]);
const EVENT_TYPES = new Set([
  'runtime.ready', 'runtime.stopping', 'runtime.stopped', 'runtime.failed',
  'session.starting', 'session.started', 'session.switching', 'session.forked', 'session.tree-changed', 'session.metadata-changed', 'session.stopping',
  'session.before-switch', 'session.before-fork',
  'input.received', 'input.transformed', 'input.handled', 'input.queued', 'input.rejected',
  'agent.starting', 'agent.started', 'agent.settled', 'agent.ended',
  'turn.started', 'turn.ended', 'message.started', 'message.delta', 'message.ended',
  'tool.requested', 'tool.blocked', 'tool.started', 'tool.updated', 'tool.ended',
  'model.selected', 'model.thinking-level-selected', 'provider.request-started', 'provider.response-received', 'provider.failed',
  'context.appended', 'context.usage-changed', 'context.compaction-started', 'context.compaction-retrying', 'context.compacted', 'context.compaction-failed',
  'ui.interaction-requested', 'ui.interaction-resolved', 'ui.notification', 'ui.status-changed', 'ui.presentation-changed',
  'resources.discovering', 'resources.discovered', 'trust.resolving', 'trust.resolved',
  'prompt.assembling', 'prompt.assembled', 'context.preparing', 'agent.before-start',
  'settings.changed', 'plugin.lifecycle',
]);
const EVENT_PHASES = new Set(['before', 'permission', 'after', 'notification']);
const RUNTIME_MODES = new Set(['interactive', 'print', 'json', 'rpc', 'headless']);

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
    'timestamp', 'cwd', 'mode', 'model', 'trust', 'payload',
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
    && typeof value.mode === 'string' && RUNTIME_MODES.has(value.mode)
    && (value.model === undefined || isModelRef(value.model))
    && isTrustSnapshot(value.trust)
    && Object.hasOwn(value, 'payload') && value.payload !== undefined;
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
    case 'session.export': case 'context.cancel-compaction': case 'context.usage': case 'tools.list': case 'runtime.snapshot': case 'runtime.stop':
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
    const payloadMissing = isRecord(input.event) && (!Object.hasOwn(input.event, 'payload') || input.event.payload === undefined);
    throw new RuntimeFailure('validation', payloadMissing ? 'Malformed RPC event payload' : 'Malformed RPC event envelope');
  }
  return input as unknown as RpcEvent;
};
