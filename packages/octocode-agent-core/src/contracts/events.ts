import type { RuntimeErrorData } from './errors.js';
import type { EventId, SessionId, ToolCallId, TurnId } from './identity.js';

export type RuntimeMode = 'interactive' | 'print' | 'json' | 'rpc' | 'headless';
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
export type AgentEventType =
  | 'runtime.ready' | 'runtime.stopping' | 'runtime.stopped' | 'runtime.failed'
  | 'session.starting' | 'session.started' | 'session.switching' | 'session.forked' | 'session.tree-changed' | 'session.metadata-changed' | 'session.stopping'
  | 'session.before-switch' | 'session.before-fork'
  | 'input.received' | 'input.transformed' | 'input.handled' | 'input.queued' | 'input.rejected'
  | 'agent.starting' | 'agent.started' | 'agent.settled' | 'agent.ended'
  | 'turn.started' | 'turn.ended' | 'message.started' | 'message.delta' | 'message.ended'
  | 'tool.requested' | 'tool.blocked' | 'tool.started' | 'tool.updated' | 'tool.ended'
  | 'model.selected' | 'model.thinking-level-selected' | 'provider.request-started' | 'provider.response-received' | 'provider.failed'
  | 'context.appended' | 'context.usage-changed' | 'context.compaction-started' | 'context.compaction-retrying' | 'context.compacted' | 'context.compaction-failed'
  | 'ui.interaction-requested' | 'ui.interaction-resolved' | 'ui.notification' | 'ui.status-changed' | 'ui.presentation-changed'
  | 'resources.discovering' | 'resources.discovered' | 'trust.resolving' | 'trust.resolved'
  | 'prompt.assembling' | 'prompt.assembled' | 'context.preparing' | 'agent.before-start'
  | 'settings.changed' | 'plugin.lifecycle';

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
  readonly model?: ModelRef;
  readonly trust: TrustSnapshot;
  readonly payload: Readonly<TPayload>;
}
export type RuntimeEvent = AgentEventEnvelope;
