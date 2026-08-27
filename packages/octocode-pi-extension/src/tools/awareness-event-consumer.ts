import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  evaluatePeerInbound,
  openAwareness,
  parseAgentEventEnvelopeV1,
  type InboundDecision,
  type OutboxEventV1,
} from '@octocodeai/octocode-awareness';
import type { PiContext, PiInstance } from '../types.js';

export const AWARENESS_PEER_EVENT_MESSAGE_TYPE = 'octocode-peer-event';

export interface AwarenessEventStore {
  listEvents(params: { consumerId: string; limit?: number }): OutboxEventV1[];
  acknowledgeEvent(params: { consumerId: string; eventId: string; decision: InboundDecision }): {
    sequence: number;
    decision: InboundDecision;
    duplicate: boolean;
  };
  getConsumerCursor(consumerId: string): number;
  close(): void;
}

export interface AwarenessEventObservability {
  consumerId: string;
  backlogDepth: number;
  backlogCapped: boolean;
  lastAcknowledgedSequence: number;
  accepted: number;
  held: number;
  refused: number;
  errors: number;
}

export interface AwarenessPeerDelivery {
  customType: typeof AWARENESS_PEER_EVENT_MESSAGE_TYPE;
  content: string;
  display: false;
  details: {
    version: 1;
    eventId: string;
    sequence: number;
    messageClass: 'informational' | 'blocking' | 'handoff';
    provenance: 'peer-attributed-data';
  };
}

interface AwarenessEventConsumerOptions {
  workspace: string;
  consumerId: string;
  expectedAgentId: string;
  openStore?: (workspace: string) => AwarenessEventStore;
  deliver(message: AwarenessPeerDelivery): void | Promise<void>;
  onObservability?(stats: AwarenessEventObservability): void;
  now?: () => number;
  maxEventsPerDrain?: number;
}

interface RegisterAwarenessEventConsumerOptions {
  openStore?: (workspace: string) => AwarenessEventStore;
  resolveExpectedAgentId?(ctx: PiContext): string;
  onObservability?(stats: AwarenessEventObservability, ctx: PiContext): void;
  now?: () => number;
  maxEventsPerDrain?: number;
}

interface PeerMessagePayload {
  messageId: string;
  fromAgentId: string;
  toAgentId: string | null;
  topic: string | null;
  text: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parsePeerPayload(event: ReturnType<typeof parseAgentEventEnvelopeV1>): PeerMessagePayload {
  if (event.type !== 'peer.message') throw new Error('event is not a peer message');
  if (event.actor.kind !== 'agent' || event.provenance.source !== 'peer' || event.provenance.trust !== 'attributed-data') {
    throw new Error('peer message provenance is invalid');
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('peer message payload is invalid');
  const payload = event.payload as Record<string, unknown>;
  const messageId = nonEmptyString(payload['messageId']);
  const fromAgentId = nonEmptyString(payload['fromAgentId']);
  const text = nonEmptyString(payload['text']);
  if (!messageId || !fromAgentId || !text) throw new Error('peer message identity and body are required');
  if (event.actor.id !== fromAgentId) throw new Error('peer message actor does not match its payload');
  if (event.aggregate && (event.aggregate.kind !== 'message' || event.aggregate.id !== messageId)) {
    throw new Error('peer message aggregate does not match its payload');
  }
  return {
    messageId,
    fromAgentId,
    toAgentId: nonEmptyString(payload['toAgentId']) ?? null,
    topic: nonEmptyString(payload['topic']) ?? null,
    text,
  };
}

function initialObservability(consumerId: string): AwarenessEventObservability {
  return {
    consumerId,
    backlogDepth: 0,
    backlogCapped: false,
    lastAcknowledgedSequence: 0,
    accepted: 0,
    held: 0,
    refused: 0,
    errors: 0,
  };
}

/**
 * A bounded, serialized transaction-outbox consumer. Only peer.message is a
 * model-facing event class. Harness lifecycle/audit/projection events are
 * intentionally refused and acknowledged without inspecting their payloads.
 */
export function createAwarenessEventConsumer(options: AwarenessEventConsumerOptions) {
  const openStore = options.openStore ?? ((workspace: string) => openAwareness({ workspace }));
  const maxEvents = Math.min(Math.max(options.maxEventsPerDrain ?? 100, 1), 999);
  const now = options.now ?? Date.now;
  const stats = initialObservability(options.consumerId);
  let inFlight: Promise<AwarenessEventObservability> | undefined;

  const drainOnce = async (): Promise<AwarenessEventObservability> => {
    const store = openStore(options.workspace);
    try {
      stats.lastAcknowledgedSequence = store.getConsumerCursor(options.consumerId);
      const pending = store.listEvents({ consumerId: options.consumerId, limit: maxEvents + 1 });
      for (const candidate of pending.slice(0, maxEvents)) {
        let decision: InboundDecision = 'refuse';
        let delivery: AwarenessPeerDelivery | undefined;
        try {
          const event = parseAgentEventEnvelopeV1(candidate);
          if (event.workspace !== options.workspace) throw new Error('event workspace does not match this consumer');
          if (event.expiresAt && Date.parse(event.expiresAt) <= now()) {
            decision = 'refuse';
          } else if (event.type === 'peer.message') {
            const payload = parsePeerPayload(event);
            const policy = evaluatePeerInbound({
              fromAgentId: payload.fromAgentId,
              toAgentId: payload.toAgentId,
              expectedAgentId: options.expectedAgentId,
              topic: payload.topic,
              text: payload.text,
            });
            decision = policy.decision;
            if (decision === 'accept' && policy.attributedText) {
              delivery = {
                customType: AWARENESS_PEER_EVENT_MESSAGE_TYPE,
                content: policy.attributedText,
                display: false,
                details: {
                  version: 1,
                  eventId: candidate.eventId,
                  sequence: candidate.sequence,
                  messageClass: policy.messageClass as 'informational' | 'blocking' | 'handoff',
                  provenance: 'peer-attributed-data',
                },
              };
            }
          }
        } catch {
          // A malformed/forged/expired envelope is a durable refusal when its
          // outbox identity is still usable. Its payload is never exposed.
          stats.errors += 1;
          decision = 'refuse';
          delivery = undefined;
        }
        try {
          // Pi persists the custom message synchronously. A throw means no ack,
          // so the durable cursor replays this event on the next bounded drain.
          if (delivery) await options.deliver(delivery);
          const ack = store.acknowledgeEvent({ consumerId: options.consumerId, eventId: candidate.eventId, decision });
          stats.lastAcknowledgedSequence = ack.sequence;
          if (!ack.duplicate) {
            if (decision === 'accept') stats.accepted += 1;
            else if (decision === 'hold') stats.held += 1;
            else stats.refused += 1;
          }
        } catch {
          stats.errors += 1;
          // Preserve strict ordering: a failed delivery or acknowledgement keeps
          // this event at the cursor, so later events must not pass it.
          break;
        }
      }
      const remaining = store.listEvents({ consumerId: options.consumerId, limit: 1000 });
      stats.backlogDepth = remaining.length;
      stats.backlogCapped = remaining.length === 1000;
      options.onObservability?.({ ...stats });
      return { ...stats };
    } catch {
      stats.errors += 1;
      options.onObservability?.({ ...stats });
      return { ...stats };
    } finally {
      store.close();
    }
  };

  return {
    drain(): Promise<AwarenessEventObservability> {
      if (inFlight) return inFlight;
      inFlight = drainOnce().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    snapshot(): AwarenessEventObservability {
      return { ...stats };
    },
  };
}

export function resolvePiEventConsumerId(ctx: PiContext): string | undefined {
  const sessionId = nonEmptyString(ctx.sessionManager?.getSessionId?.());
  const sessionFile = nonEmptyString(ctx.sessionManager?.getSessionFile?.());
  if (sessionId) return `pi:${sessionId}`;
  if (!sessionFile) return undefined;
  const normalized = path.normalize(path.resolve(sessionFile));
  return `pi:file:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

/** Register event-driven wake points only; there is deliberately no polling loop. */
export function registerAwarenessEventConsumer(pi: PiInstance, options: RegisterAwarenessEventConsumerOptions = {}): void {
  const consumers = new Map<string, ReturnType<typeof createAwarenessEventConsumer>>();
  const drain = async (ctx: PiContext): Promise<void> => {
    const workspace = path.resolve(ctx.cwd ?? process.cwd());
    const consumerId = resolvePiEventConsumerId(ctx);
    if (!consumerId) {
      options.onObservability?.({
        ...initialObservability('unavailable'),
        errors: 1,
      }, ctx);
      return;
    }
    const expectedAgentId = options.resolveExpectedAgentId?.(ctx);
    if (!expectedAgentId?.trim()) {
      options.onObservability?.({
        ...initialObservability(consumerId),
        errors: 1,
      }, ctx);
      return;
    }
    const key = `${workspace}\0${consumerId}`;
    let consumer = consumers.get(key);
    if (!consumer) {
      consumer = createAwarenessEventConsumer({
        workspace,
        consumerId,
        expectedAgentId,
        ...(options.openStore ? { openStore: options.openStore } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.maxEventsPerDrain ? { maxEventsPerDrain: options.maxEventsPerDrain } : {}),
        deliver: (message) => {
          if (!pi.sendMessage) throw new Error('Pi custom message delivery is unavailable');
          pi.sendMessage(message, { triggerTurn: false, deliverAs: 'nextTurn' });
        },
        onObservability: (stats) => options.onObservability?.(stats, ctx),
      });
      consumers.set(key, consumer);
    }
    await consumer.drain();
  };

  pi.on('session_start', async (_event, ctx) => { await drain(ctx); });
  pi.on('turn_end', async (_event, ctx) => { await drain(ctx); });
}
