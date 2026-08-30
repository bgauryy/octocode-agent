import type { RuntimeEvent } from '@octocodeai/agent-core';
import type { PresentationEvent } from './terminal/opentui/presentation.js';

/** Translates host-neutral runtime events into terminal presentation semantics. */
export function presentationEvents(event: RuntimeEvent, activeTurnId?: string): readonly PresentationEvent[] {
  const payload = event.payload as Record<string, unknown>;
  const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
  const name = typeof payload.name === 'string' ? payload.name : 'tool';
  const turn = typeof payload.turnId === 'string'
    ? payload.turnId
    : event.turnId === undefined
      ? activeTurnId
      : String(event.turnId);
  const stringify = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    try { return JSON.stringify(value) ?? String(value); }
    catch { return '[unserializable]'; }
  };
  const errorDetails = (): { message: string; category?: string } => {
    if (typeof payload.error === 'string') return { message: payload.error, ...(typeof payload.category === 'string' ? { category: payload.category } : {}) };
    if (typeof payload.error === 'object' && payload.error !== null) {
      const error = payload.error as Record<string, unknown>;
      return {
        message: typeof error.message === 'string' ? error.message : 'Tool execution failed',
        ...(typeof error.category === 'string' ? { category: error.category } : typeof payload.category === 'string' ? { category: payload.category } : {}),
      };
    }
    return { message: 'Tool execution failed', ...(typeof payload.category === 'string' ? { category: payload.category } : {}) };
  };
  switch (event.type) {
    case 'runtime.ready': return [{ type: 'runtime-ready' }];
    case 'runtime.stopping': return [{ type: 'runtime-stopping' }];
    case 'runtime.failed': return [{ type: 'runtime-failed' }];
    case 'input.received':
      return typeof payload.text === 'string' ? [{ type: 'input-received', text: payload.text, ...(turn === undefined ? {} : { turnId: turn }) }] : [];
    case 'input.queued': {
      const position = typeof payload.position === 'number' ? payload.position : undefined;
      const kind = payload.kind === 'steer' ? 'Steer' : 'Follow-up';
      return [{ type: 'notification', severity: 'info', message: `${kind} queued${position === undefined ? '' : ` · position ${position}`}` }];
    }
    case 'input.rejected': {
      const kind = payload.kind === 'steer' ? 'Steer' : 'Follow-up';
      const reason = typeof payload.reason === 'string' ? payload.reason : 'runtime unavailable';
      return [{ type: 'notification', severity: 'error', message: `${kind} rejected · ${reason}` }];
    }
    case 'context.appended': {
      const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!eventId || !text || payload.provenance !== 'peer-attributed-data') return [];
      return [{ type: 'notification', severity: 'info', message: 'Peer context received and added to this session' }];
    }
    case 'worker.started': {
      const workerId = typeof payload.workerId === 'string' ? payload.workerId.trim() : '';
      if (!workerId) return [];
      const state = typeof payload.state === 'string' && payload.state.trim() ? payload.state.trim().toUpperCase() : 'RUNNING';
      return [{ type: 'status-changed', name: workerId, text: state }];
    }
    case 'worker.stopped': {
      const workerId = typeof payload.workerId === 'string' ? payload.workerId.trim() : '';
      if (!workerId) return [];
      const terminal = typeof payload.terminal === 'object' && payload.terminal !== null
        ? payload.terminal as Record<string, unknown>
        : undefined;
      const outcome = typeof terminal?.outcome === 'string'
        ? terminal.outcome
        : typeof payload.state === 'string' ? payload.state : 'stopped';
      const severity = outcome === 'succeeded' ? 'success' : outcome === 'aborted' ? 'warning' : 'error';
      return [
        { type: 'status-changed', name: workerId },
        { type: 'notification', severity, message: `${workerId} · ${outcome.toUpperCase()}` },
      ];
    }
    case 'turn.started':
      return turn === undefined ? [] : [{ type: 'turn-started', turnId: turn }];
    case 'turn.ended': {
      if (turn === undefined) return [];
      const stop = payload.stop;
      return [{ type: 'turn-ended', turnId: turn, outcome: stop === 'cancelled' ? 'cancelled' : stop === 'error' ? 'error' : 'completed' }];
    }
    case 'message.started': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : String(event.id);
      const role = payload.role === 'user' || payload.role === 'system' || payload.role === 'tool' ? payload.role : 'assistant';
      return [{ type: 'message-started', messageId, role, ...(turn === undefined ? {} : { turnId: turn }) }];
    }
    case 'message.delta':
      return typeof payload.text === 'string' ? [{
        type: 'message-delta',
        text: payload.text,
        messageId: typeof payload.messageId === 'string' ? payload.messageId : `assistant:${turn ?? 'unscoped'}`,
        role: 'assistant',
        ...(turn === undefined ? {} : { turnId: turn }),
        ...(payload.segment === 'thinking' ? { segment: 'thinking' as const } : {}),
      }] : [];
    case 'message.ended': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : `assistant:${turn ?? 'unscoped'}`;
      return [{ type: 'message-ended', messageId, status: payload.status === 'cancelled' || payload.status === 'error' ? payload.status : 'complete' }];
    }
    case 'tool.requested':
      return callId === undefined ? [] : [{
        type: 'tool-requested', callId, name,
        ...(turn === undefined ? {} : { turnId: turn }),
        ...(payload.input === undefined ? {} : { input: stringify(payload.input) }),
      }];
    case 'tool.started':
      return callId === undefined ? [] : [{ type: 'tool-started', callId, name, ...(turn === undefined ? {} : { turnId: turn }) }];
    case 'tool.updated': {
      const update = typeof payload.update === 'object' && payload.update !== null ? payload.update as Record<string, unknown> : undefined;
      const value = typeof update?.value === 'object' && update.value !== null ? update.value as Record<string, unknown> : undefined;
      return callId === undefined ? [] : [{
        type: 'tool-updated', callId, name,
        ...(typeof update?.message === 'string' ? { message: update.message } : {}),
        ...(typeof value?.current === 'number' ? { current: value.current } : {}),
        ...(typeof value?.total === 'number' ? { total: value.total } : {}),
      }];
    }
    case 'tool.blocked': {
      if (callId === undefined) return [];
      const error = errorDetails();
      return [{ type: 'tool-blocked', callId, name, message: error.message, ...(error.category === undefined ? {} : { category: error.category }) }];
    }
    case 'tool.ended': {
      if (callId === undefined) return [];
      if (payload.outcome === 'cancelled' || payload.category === 'cancelled') {
        const error = errorDetails();
        return [{
          type: 'tool-cancelled', callId, name,
          ...(typeof payload.message === 'string' ? { message: payload.message } : error.message === 'Tool execution failed' ? {} : { message: error.message }),
        }];
      }
      if (payload.error !== undefined) {
        const error = errorDetails();
        return [{ type: 'tool-ended', callId, name, error: error.message, ...(error.category === undefined ? {} : { category: error.category }) }];
      }
      return [{ type: 'tool-ended', callId, name, ...(payload.result === undefined ? {} : { result: stringify(payload.result) }) }];
    }
    case 'context.usage-changed': {
      const inputTokens = typeof payload.inputTokens === 'number' ? payload.inputTokens : undefined;
      const outputTokens = typeof payload.outputTokens === 'number' ? payload.outputTokens : undefined;
      const cachedInputTokens = typeof payload.cachedInputTokens === 'number' ? payload.cachedInputTokens : undefined;
      const cacheWriteInputTokens = typeof payload.cacheWriteInputTokens === 'number' ? payload.cacheWriteInputTokens : undefined;
      return inputTokens === undefined || outputTokens === undefined ? [] : [{
        type: 'status-changed', name: 'context.usage',
        text: `${inputTokens} input · ${outputTokens} output${cachedInputTokens === undefined ? '' : ` · ${cachedInputTokens} cached`}${cacheWriteInputTokens === undefined ? '' : ` · ${cacheWriteInputTokens} cache write`} tokens`,
      }];
    }
    case 'provider.response-received': {
      const usage = typeof payload.usage === 'object' && payload.usage !== null ? payload.usage as Record<string, unknown> : undefined;
      const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
      const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined;
      const cachedInputTokens = typeof usage?.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined;
      const cacheWriteInputTokens = typeof usage?.cacheWriteInputTokens === 'number' ? usage.cacheWriteInputTokens : undefined;
      return inputTokens === undefined || outputTokens === undefined ? [] : [{
        type: 'status-changed', name: 'context.usage',
        text: `${inputTokens} input · ${outputTokens} output${cachedInputTokens === undefined ? '' : ` · ${cachedInputTokens} cached`}${cacheWriteInputTokens === undefined ? '' : ` · ${cacheWriteInputTokens} cache write`} tokens`,
      }];
    }
    case 'ui.notification': {
      if (typeof payload.message !== 'string') return [];
      const severity = payload.severity;
      return [{
        type: 'notification', message: payload.message,
        severity: severity === 'success' || severity === 'warning' || severity === 'error' ? severity : 'info',
      }];
    }
    case 'ui.status-changed':
      return typeof payload.name === 'string'
        ? [{ type: 'status-changed', name: payload.name, text: typeof payload.text === 'string' ? payload.text : undefined }]
        : [];
    case 'runtime.stopped':
    case 'session.starting':
    case 'session.started':
    case 'session.switching':
    case 'session.forked':
    case 'session.tree-changed':
    case 'session.metadata-changed':
    case 'session.stopping':
    case 'session.before-switch':
    case 'session.before-fork':
    case 'input.transformed':
    case 'input.handled':
    case 'agent.starting':
    case 'agent.started':
    case 'agent.settled':
    case 'agent.ended':
    case 'permission.requested':
    case 'model.selected':
    case 'model.thinking-level-selected':
    case 'provider.request-started':
    case 'provider.failed':
    case 'context.compaction-started':
    case 'context.compaction-retrying':
    case 'context.compacted':
    case 'context.compaction-failed':
    case 'ui.interaction-requested':
    case 'ui.interaction-resolved':
    case 'ui.presentation-changed':
    case 'resources.discovering':
    case 'resources.discovered':
    case 'trust.resolving':
    case 'trust.resolved':
    case 'prompt.assembling':
    case 'prompt.assembled':
    case 'context.preparing':
    case 'agent.before-start':
    case 'settings.changed':
    case 'plugin.lifecycle':
      return [];
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
