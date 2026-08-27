import { RuntimeFailure } from '../contracts/errors.js';
import type { AgentEventEnvelope, AgentEventType } from '../contracts/events.js';

export type EventAuthority = 'observe' | 'context' | 'rewrite' | 'allow-deny' | 'stop';
export type LifecycleDecision<T> = { readonly kind: 'continue' | 'allow' | 'no-decision' } | { readonly kind: 'deny' | 'stop'; readonly reason: string } | { readonly kind: 'rewrite'; readonly payload: T } | { readonly kind: 'context'; readonly text: string } | { readonly kind: 'suppress' };
export type LifecycleSource = 'managed' | 'user' | 'workspace' | 'plugin' | 'builtin';
export interface LifecycleSubscription<T> { readonly id: string; readonly source: LifecycleSource; readonly priority?: number; readonly discoveryOrder?: number; readonly declarationOrder?: number; readonly timeoutMs?: number; handler(event: AgentEventEnvelope<AgentEventType, T>): Promise<LifecycleDecision<T> | void>; }
export interface LifecycleReceipt { readonly handlerId: string; readonly order: number; readonly outcome: 'success' | 'timeout' | 'cancelled' | 'failed'; readonly durationMs: number; readonly decision: LifecycleDecision<unknown>['kind']; readonly diagnostic?: string; }
export interface LifecycleDispatchResult<T> { readonly payload: T; readonly decision: LifecycleDecision<T>; readonly context: readonly string[]; readonly suppressed: boolean; readonly receipts: readonly LifecycleReceipt[]; }
const SOURCE_ORDER: Record<LifecycleSource, number> = { managed: 0, builtin: 1, user: 2, workspace: 3, plugin: 4 };

export class LifecycleBus<T> {
  readonly #subscriptions: LifecycleSubscription<T>[] = [];
  readonly #active = new Set<string>();
  constructor(readonly definition: { readonly eventType: AgentEventType; readonly authority: readonly EventAuthority[]; readonly validate: (payload: unknown) => payload is T; readonly recursion?: boolean }) {}
  subscribe(subscription: LifecycleSubscription<T>): () => void {
    if (this.#subscriptions.some(({ id }) => id === subscription.id)) throw new RuntimeFailure('validation', `Duplicate lifecycle handler: ${subscription.id}`);
    this.#subscriptions.push(subscription);
    return () => { const index = this.#subscriptions.indexOf(subscription); if (index >= 0) this.#subscriptions.splice(index, 1); };
  }
  async dispatch(envelope: AgentEventEnvelope<AgentEventType, T>): Promise<LifecycleDispatchResult<T>> {
    if (envelope.type !== this.definition.eventType) throw new RuntimeFailure('validation', `Expected ${this.definition.eventType}, received ${envelope.type}`);
    if (!this.definition.recursion && this.#active.has(envelope.type)) throw new RuntimeFailure('internal-invariant', `Recursive intercepting event: ${envelope.type}`);
    this.#active.add(envelope.type);
    let payload = envelope.payload as T;
    let aggregate: LifecycleDecision<T> = { kind: 'continue' };
    let suppressed = false;
    const context: string[] = [];
    const receipts: LifecycleReceipt[] = [];
    const ordered = [...this.#subscriptions].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || (a.priority ?? 0) - (b.priority ?? 0) || (a.discoveryOrder ?? 0) - (b.discoveryOrder ?? 0) || (a.declarationOrder ?? 0) - (b.declarationOrder ?? 0) || a.id.localeCompare(b.id));
    try {
      for (const [order, subscription] of ordered.entries()) {
        const started = Date.now();
        try {
          const handlerPromise = subscription.handler({ ...envelope, payload });
          const decision = subscription.timeoutMs === undefined ? await handlerPromise : await withTimeout(handlerPromise, subscription.timeoutMs);
          if (decision !== undefined) {
            this.#assertAuthority(decision);
            if (decision.kind === 'rewrite') {
              if (!this.definition.validate(decision.payload)) throw new RuntimeFailure('validation', `Invalid rewrite from ${subscription.id}`);
              payload = Object.freeze(decision.payload);
            } else if (decision.kind === 'deny') aggregate = decision;
            else if (decision.kind === 'stop' && aggregate.kind !== 'deny') aggregate = decision;
            else if (decision.kind === 'allow' && aggregate.kind !== 'deny' && aggregate.kind !== 'stop') aggregate = decision;
            else if (decision.kind === 'context') context.push(decision.text);
            else if (decision.kind === 'suppress') suppressed = true;
          }
          receipts.push({ handlerId: subscription.id, order, outcome: 'success', durationMs: Date.now() - started, decision: decision?.kind ?? 'continue' });
        } catch (error) {
          if (error instanceof RuntimeFailure && (error.category === 'validation' || error.category === 'internal-invariant')) throw error;
          const diagnostic = error instanceof Error ? error.message : 'handler failed';
          receipts.push({ handlerId: subscription.id, order, outcome: diagnostic === 'Lifecycle handler timed out' ? 'timeout' : 'failed', durationMs: Date.now() - started, decision: 'continue', diagnostic });
        }
      }
      return { payload, decision: aggregate, context, suppressed, receipts };
    } finally { this.#active.delete(envelope.type); }
  }
  #assertAuthority(decision: LifecycleDecision<T>): void {
    const required = decision.kind === 'rewrite' ? 'rewrite' : decision.kind === 'allow' || decision.kind === 'deny' || decision.kind === 'no-decision' ? 'allow-deny' : decision.kind === 'stop' ? 'stop' : decision.kind === 'context' ? 'context' : decision.kind === 'suppress' ? 'observe' : 'observe';
    if (!this.definition.authority.includes(required)) throw new RuntimeFailure('validation', `${decision.kind} is not allowed for ${this.definition.eventType}`);
  }
}
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => await new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Lifecycle handler timed out')), timeoutMs);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
});
