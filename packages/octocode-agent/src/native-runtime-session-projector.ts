import {
  LifecycleBus,
  RuntimeFailure,
  assertModelToolResultV1,
  revision,
  sessionEventId,
  type LifecycleDispatchResult,
  type ModelToolCall,
  type ModelToolResultV1,
  type Revision,
  type RuntimeEvent,
  type SessionEvent,
  type SessionId,
  type SessionStore,
} from '@octocodeai/agent-core';

const durableModelToolResult = (value: unknown): ModelToolResultV1 | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).content;
  try {
    return assertModelToolResultV1(candidate);
  } catch {
    return undefined;
  }
};

/** Projects ordered runtime lifecycle events into the durable session stream. */
export function createRuntimeEventPersister(options: {
  sessions: SessionStore;
  activeSessionId: SessionId;
  initialRevision: Revision;
  lifecycle?: Map<RuntimeEvent['type'], LifecycleBus<unknown>>;
  onRuntimeStopping?: () => Promise<void>;
}): (runtimeEvent: RuntimeEvent) => Promise<LifecycleDispatchResult<unknown>> {
  let storedRevision = options.initialRevision;
  const lifecycle = options.lifecycle ?? new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
  const assistantChunks: string[] = [];
  const assistantToolCalls: ModelToolCall[] = [];
  const pendingToolCalls = new Map<string, string>();
  const runtimeToolCalls = new Set<string>();
  const requestedToolCalls = new Set<string>();
  const pendingLifecycleContext: string[] = [];
  let assistantMessageEnded = false;
  let runtimeCleanupStarted = false;

  const dispatch = async (runtimeEvent: RuntimeEvent): Promise<LifecycleDispatchResult<unknown>> => {
    let bus = lifecycle.get(runtimeEvent.type);
    if (!bus) {
      bus = new LifecycleBus({ eventType: runtimeEvent.type, authority: ['observe'], validate: (_payload): _payload is unknown => true });
      lifecycle.set(runtimeEvent.type, bus);
    }
    return await bus.dispatch(runtimeEvent);
  };
  const append = async (
    runtimeEvent: RuntimeEvent,
    storedEvent: SessionEvent['event'],
    visibility: SessionEvent['visibility'],
  ): Promise<void> => {
    await appendBatch(runtimeEvent, [{ event: storedEvent, visibility }]);
  };
  const appendBatch = async (
    runtimeEvent: RuntimeEvent,
    records: readonly { event: SessionEvent['event']; visibility: SessionEvent['visibility']; causationId?: string }[],
  ): Promise<void> => {
    storedRevision = (await options.sessions.load(options.activeSessionId)).projection.revision;
    const baseSequence = Number(storedRevision);
    const entries = records.map((record, index): SessionEvent => {
      const sequence = baseSequence + index + 1;
      return {
        schemaVersion: 1,
        sessionId: options.activeSessionId,
        eventId: sessionEventId(`${options.activeSessionId}:runtime-event:${sequence}`),
        revision: revision(String(sequence)),
        sequence,
        timestamp: runtimeEvent.timestamp,
        visibility: record.visibility,
        ...(record.causationId ? { causationId: record.causationId } : {}),
        event: record.event,
      };
    });
    storedRevision = await options.sessions.append(options.activeSessionId, storedRevision, entries);
  };
  const flushAssistant = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    if (assistantChunks.length === 0 && assistantToolCalls.length === 0) return;
    const content = assistantChunks.join('');
    const toolCalls = assistantToolCalls.splice(0);
    assistantChunks.length = 0;
    assistantMessageEnded = false;
    requestedToolCalls.clear();
    for (const call of toolCalls) pendingToolCalls.set(call.id, call.name);
    await append(runtimeEvent, { type: 'message.appended', role: 'assistant', content, ...(toolCalls.length === 0 ? {} : { toolCalls }) }, 'model');
  };
  const discardAssistant = (): void => {
    assistantChunks.length = 0;
    assistantToolCalls.length = 0;
    assistantMessageEnded = false;
    requestedToolCalls.clear();
  };
  const appendToolResult = async (
    runtimeEvent: RuntimeEvent,
    callId: string,
    content: unknown,
  ): Promise<boolean> => {
    if (!pendingToolCalls.has(callId)) return false;
    pendingToolCalls.delete(callId);
    const result = durableModelToolResult(content);
    await append(runtimeEvent, {
      type: 'message.appended',
      role: 'tool',
      toolCallId: callId,
      content: JSON.stringify(content) ?? 'null',
      ...(result === undefined ? {} : { result }),
    }, 'model');
    return true;
  };
  const cancelPendingToolCalls = async (runtimeEvent: RuntimeEvent, reason: string): Promise<void> => {
    for (const callId of [...pendingToolCalls.keys()]) {
      await appendToolResult(runtimeEvent, callId, { error: reason, category: 'cancelled' });
    }
  };
  const flushLifecycleContext = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    if (pendingToolCalls.size > 0 || pendingLifecycleContext.length === 0) return;
    for (const context of pendingLifecycleContext.splice(0)) {
      await append(runtimeEvent, { type: 'message.appended', role: 'user', content: context }, 'model');
    }
  };

  const persistOne = async (runtimeEvent: RuntimeEvent): Promise<LifecycleDispatchResult<unknown>> => {
    let lifecycleResult = await dispatch(runtimeEvent);
    if (runtimeEvent.type === 'tool.requested') {
      const original = runtimeEvent.payload as Record<string, unknown>;
      const rewritten = lifecycleResult.payload;
      if (typeof original.callId !== 'string') throw new RuntimeFailure('validation', 'tool.requested requires a callId');
      if (typeof rewritten !== 'object' || rewritten === null || Array.isArray(rewritten)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload must be an object');
      const candidate = rewritten as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !candidate.name.trim()) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires a non-empty name');
      if (!('input' in candidate)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires input');
      const origin = original.origin;
      if (origin !== undefined && origin !== 'runtime') throw new RuntimeFailure('validation', 'tool.requested origin must be runtime when present');
      lifecycleResult = {
        ...lifecycleResult,
        payload: {
          ...candidate,
          callId: original.callId,
          ...(origin === undefined ? {} : { origin }),
        },
      };
    }
    runtimeEvent = lifecycleResult.payload === runtimeEvent.payload
      ? runtimeEvent
      : { ...runtimeEvent, payload: lifecycleResult.payload } as RuntimeEvent;
    const payload = runtimeEvent.payload as Record<string, unknown>;
    if (runtimeEvent.type === 'message.delta') {
      if (payload.type === 'text' && typeof payload.text === 'string') assistantChunks.push(payload.text);
      else if (payload.type === 'tool-call' && typeof payload.id === 'string' && typeof payload.name === 'string') {
        assistantToolCalls.push({ id: payload.id, name: payload.name, input: payload.input });
      }
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'message.ended') {
      if (payload.status === 'cancelled' || payload.status === 'error') discardAssistant();
      else if (assistantToolCalls.length === 0) await flushAssistant(runtimeEvent);
      else assistantMessageEnded = true;
    } else if (runtimeEvent.type === 'turn.ended') {
      if (payload.stop === 'cancelled' || payload.stop === 'error') {
        if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
        else discardAssistant();
      }
      else await flushAssistant(runtimeEvent);
    } else if (runtimeEvent.type === 'runtime.failed' || runtimeEvent.type === 'runtime.stopping') {
      discardAssistant();
    }

    if (runtimeEvent.type === 'tool.requested' && typeof payload.callId === 'string') {
      if (payload.origin === 'runtime') {
        runtimeToolCalls.add(payload.callId);
        const records: Array<{ event: SessionEvent['event']; visibility: SessionEvent['visibility'] }> = [
          { event: { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload }, visibility: 'diagnostics' },
          ...lifecycleResult.context.map((text) => ({
            event: { type: 'custom.appended' as const, kind: 'tool.lifecycle-context', value: { callId: payload.callId, text } },
            visibility: 'diagnostics' as const,
          })),
        ];
        await appendBatch(runtimeEvent, records);
        return lifecycleResult;
      }
      const call = assistantToolCalls.find((candidate) => candidate.id === payload.callId);
      if (!call) throw new RuntimeFailure('internal-invariant', `tool.requested has no buffered assistant call: ${payload.callId}`);
      const index = assistantToolCalls.indexOf(call);
      assistantToolCalls[index] = { id: call.id, name: payload.name as string, input: payload.input };
      requestedToolCalls.add(call.id);
      pendingLifecycleContext.push(...lifecycleResult.context);
      if (assistantMessageEnded && requestedToolCalls.size === assistantToolCalls.length) await flushAssistant(runtimeEvent);
    }

    if (runtimeEvent.type === 'tool.blocked' && typeof payload.callId === 'string') {
      if (runtimeToolCalls.delete(payload.callId)) {
        await append(runtimeEvent, { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload }, 'diagnostics');
        return lifecycleResult;
      }
      if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
      await appendToolResult(runtimeEvent, payload.callId, {
        error: typeof payload.error === 'string' ? payload.error : 'Tool call blocked',
        ...(typeof payload.category === 'string' ? { category: payload.category } : {}),
      });
      await flushLifecycleContext(runtimeEvent);
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'tool.ended' && typeof payload.callId === 'string') {
      if (runtimeToolCalls.delete(payload.callId)) {
        await append(runtimeEvent, { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload }, 'diagnostics');
        return lifecycleResult;
      }
      if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
      const appended = await appendToolResult(runtimeEvent, payload.callId, payload.result === undefined ? { error: payload.error } : payload.result);
      if (!appended) await append(runtimeEvent, { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload }, 'diagnostics');
      pendingLifecycleContext.push(...lifecycleResult.context);
      await flushLifecycleContext(runtimeEvent);
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'turn.ended' && payload.stop === 'cancelled') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call cancelled');
    } else if (runtimeEvent.type === 'runtime.failed') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call aborted by runtime failure');
    } else if (runtimeEvent.type === 'runtime.stopping') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call cancelled during runtime shutdown');
    }
    await flushLifecycleContext(runtimeEvent);
    if (runtimeEvent.type === 'context.appended') {
      const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!eventId || !text || payload.provenance !== 'peer-attributed-data') {
        throw new RuntimeFailure('validation', 'context.appended requires attributed peer context identity');
      }
      await appendBatch(runtimeEvent, [
        { event: { type: 'message.appended', role: 'user', content: text }, visibility: 'model', causationId: eventId },
        { event: { type: 'custom.appended', kind: 'native.context.event', value: { eventId, provenance: payload.provenance } }, visibility: 'internal', causationId: eventId },
      ]);
      return lifecycleResult;
    }
    const modelVisibleInputText = runtimeEvent.type === 'input.received'
      && lifecycleResult.decision.kind === 'continue'
      && typeof payload.text === 'string'
      ? payload.text
      : undefined;
    if (modelVisibleInputText !== undefined) {
      await appendBatch(runtimeEvent, [
        ...lifecycleResult.context.map((content) => ({
          event: { type: 'message.appended' as const, role: 'user' as const, content },
          visibility: 'model' as const,
        })),
        { event: { type: 'message.appended', role: 'user', content: modelVisibleInputText }, visibility: 'model' },
      ]);
      return lifecycleResult;
    }
    const storedEvent: SessionEvent['event'] = modelVisibleInputText !== undefined
      ? { type: 'message.appended', role: 'user', content: modelVisibleInputText }
      : { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload };
    await append(
      runtimeEvent,
      storedEvent,
      'diagnostics',
    );
    return lifecycleResult;
  };
  let persistenceQueue: Promise<void> = Promise.resolve();
  return (runtimeEvent: RuntimeEvent): Promise<LifecycleDispatchResult<unknown>> => {
    const persisted = persistenceQueue.then(() => persistOne(runtimeEvent));
    persistenceQueue = persisted.then(
      () => undefined,
      () => undefined,
    );
    if (runtimeEvent.type !== 'runtime.stopping' || runtimeCleanupStarted) return persisted;
    runtimeCleanupStarted = true;
    return persisted.then(
      async (lifecycleResult) => {
        await options.onRuntimeStopping?.();
        return lifecycleResult;
      },
      async (error: unknown) => {
        try { await options.onRuntimeStopping?.(); }
        catch { /* Preserve the persistence failure that triggered shutdown. */ }
        throw error;
      },
    );
  };
}
