import type { RuntimeErrorData } from './errors.js';
import type { EventId, SessionId, ToolCallId, TurnId } from './identity.js';

export const RUNTIME_MODES = Object.freeze([
  'interactive', 'print', 'json', 'rpc', 'headless', 'acp',
] as const);
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const RUNTIME_OUTPUT_FORMATS = Object.freeze(['text', 'json'] as const);
export type RuntimeOutputFormat = (typeof RUNTIME_OUTPUT_FORMATS)[number];
export interface TrustSnapshot { readonly workspace: 'trusted' | 'untrusted' | 'unknown'; readonly managedOnly: boolean; }
export interface ModelRef { readonly providerId: string; readonly modelId: string; }
export interface ToolCancelledPayload {
  readonly callId: ToolCallId;
  readonly name: string;
  readonly outcome: 'cancelled';
  readonly category: 'cancelled';
  readonly message: string;
  /** Compatibility error envelope for consumers that still read `payload.error`. */
  readonly error: RuntimeErrorData;
}
export type EventPhase = 'before' | 'permission' | 'after' | 'notification';
export const AGENT_EVENT_TYPES = Object.freeze([
  'runtime.ready', 'runtime.stopping', 'runtime.stopped', 'runtime.failed',
  'session.starting', 'session.started', 'session.switching', 'session.forked', 'session.tree-changed', 'session.metadata-changed', 'session.stopping',
  'session.before-switch', 'session.before-fork',
  'input.received', 'input.transformed', 'input.handled', 'input.queued', 'input.rejected',
  'agent.starting', 'agent.started', 'agent.settled', 'agent.ended',
  'turn.started', 'turn.ended', 'message.started', 'message.delta', 'message.ended',
  'tool.requested', 'permission.requested', 'tool.blocked', 'tool.started', 'tool.updated', 'tool.ended',
  'worker.started', 'worker.stopped',
  'model.selected', 'model.thinking-level-selected', 'provider.request-started', 'provider.response-received', 'provider.failed',
  'context.appended', 'context.usage-changed', 'context.compaction-started', 'context.compaction-retrying', 'context.compacted', 'context.compaction-failed',
  'ui.interaction-requested', 'ui.interaction-resolved', 'ui.notification', 'ui.status-changed', 'ui.presentation-changed',
  'resources.discovering', 'resources.discovered', 'trust.resolving', 'trust.resolved',
  'prompt.assembling', 'prompt.assembled', 'context.preparing', 'agent.before-start',
  'settings.changed', 'plugin.lifecycle',
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEventPayloadMap {
  readonly 'provider.request-started': { readonly requestId: string; readonly iteration: number; readonly attempt: number; readonly maxAttempts: number };
  readonly 'provider.response-received': {
    readonly requestId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly durationMs: number;
    readonly ttftMs?: number;
    readonly stop: 'complete' | 'tool' | 'cancelled' | 'length' | 'error';
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number };
  };
  readonly 'provider.failed': {
    readonly requestId?: string;
    readonly iteration: number;
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly retrying?: boolean;
    readonly category?: RuntimeErrorData['category'];
    readonly durationMs?: number;
    readonly delayMs?: number;
    readonly message: string;
  };
  readonly 'context.usage-changed': { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number };
}

export interface AgentEventEnvelope<TType extends AgentEventType = AgentEventType, TPayload = unknown> {
  readonly schemaVersion: 1;
  readonly eventVersion: 1;
  readonly id: EventId;
  readonly type: TType;
  readonly phase: EventPhase;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly parentEventId?: EventId;
  readonly timestamp: number;
  readonly cwd: string;
  readonly mode: RuntimeMode;
  readonly outputFormat?: RuntimeOutputFormat;
  readonly model?: ModelRef;
  readonly trust: TrustSnapshot;
  readonly payload: Readonly<TPayload>;
}
export type RuntimeEventByType = {
  readonly [TType in AgentEventType]: AgentEventEnvelope<
    TType,
    TType extends keyof AgentEventPayloadMap ? AgentEventPayloadMap[TType] : unknown
  >;
};
export type RuntimeEventOf<TType extends AgentEventType> = RuntimeEventByType[TType];
export type RuntimeEventPayload<TType extends AgentEventType> = RuntimeEventOf<TType>['payload'];
export type TypedRuntimeEvent<TType extends keyof AgentEventPayloadMap> = RuntimeEventOf<TType>;
export type OpaqueAgentEventType = Exclude<AgentEventType, keyof AgentEventPayloadMap>;
export type OpaqueRuntimeEvent<TType extends OpaqueAgentEventType = OpaqueAgentEventType> = AgentEventEnvelope<TType, unknown>;
type RuntimeEventShape = RuntimeEventByType[keyof AgentEventPayloadMap] | OpaqueRuntimeEvent;
export type RuntimeEvent = RuntimeEventShape;
