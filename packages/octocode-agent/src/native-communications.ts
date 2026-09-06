import {
  createAwarenessEventConsumer,
  type AwarenessEventObservability,
  type AwarenessEventStore,
} from '@octocodeai/octocode-awareness';
import type { AgentRuntime, RuntimeCommand, RuntimeCommandResult } from '@octocodeai/agent-core';
import { filterNativeContextEvent } from './native-context-filter.js';

const DEFAULT_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CONTEXT_MAX_BYTES = 16_000;

export interface NativeCommunicationOptions {
  workspace: string;
  sessionId: string;
  agentId: string;
  openStore?: (workspace: string) => AwarenessEventStore;
  onObservability?(stats: AwarenessEventObservability): void;
  contextNow?: () => number;
  contextMaxAgeMs?: number;
}

/**
 * Session-scoped bridge from durable Awareness peer events into the native
 * event runtime. Delivery is persisted by context.append before the canonical
 * consumer records its signal read receipt and outbox cursor.
 */
export function withNativeSessionCommunication(
  runtime: AgentRuntime,
  options: NativeCommunicationOptions,
): AgentRuntime {
  const openStore = options.openStore;
  const consumer = createAwarenessEventConsumer({
    workspace: options.workspace,
    consumerId: `native-session:${options.sessionId}`,
    expectedAgentId: options.agentId,
    ...(openStore ? { openStore } : {}),
    ...(options.onObservability ? { onObservability: options.onObservability } : {}),
    deliver: async (message) => {
      const filtered = filterNativeContextEvent({
        eventId: message.details.eventId,
        text: message.content,
        provenance: message.details.provenance,
        timestamp: message.details.createdAt,
      }, {
        now: options.contextNow?.() ?? Date.now(),
        maxAgeMs: options.contextMaxAgeMs ?? DEFAULT_CONTEXT_MAX_AGE_MS,
        maxTextBytes: DEFAULT_CONTEXT_MAX_BYTES,
      });
      if (filtered.decision === 'reject') return 'refuse';
      const result = await runtime.execute({
        type: 'context.append',
        eventId: message.details.eventId,
        text: message.content,
        provenance: message.details.provenance,
      });
      if (!result.ok) throw new Error(result.error.message);
      return 'accept';
    },
  });

  let inFlight: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await consumer.drain();
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const execute = async (command: RuntimeCommand): Promise<RuntimeCommandResult> => {
    if (command.type === 'input.submit' || command.type === 'input.follow-up' || command.type === 'input.steer') await drain();
    const result = await runtime.execute(command);
    if (command.type === 'input.submit') await drain();
    return result;
  };

  return {
    async start() { await runtime.start(); await drain(); },
    async submit(input) { await drain(); await runtime.submit(input); await drain(); },
    cancel: (reason) => runtime.cancel(reason),
    execute,
    snapshot: () => runtime.snapshot(),
    subscribe: (listener) => runtime.subscribe(listener),
    stop: () => runtime.stop(),
  };
}
