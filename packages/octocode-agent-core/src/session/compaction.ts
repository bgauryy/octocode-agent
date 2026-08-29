import { RuntimeFailure } from '../contracts/errors.js';
import { revision, sessionEventId, type Revision, type SessionEventId, type SessionId } from '../contracts/identity.js';
import type { ModelMessage } from '../contracts/ports.js';
import type { SessionEvent, SessionStore, SessionStoredEvent } from '../contracts/sessions.js';
export type CompactionState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly reason: 'manual' | 'threshold' | 'overflow'; readonly attempt: number }
  | { readonly state: 'retrying'; readonly reason: string; readonly attempt: number }
  | { readonly state: 'compacted'; readonly summary: string; readonly retainedEventIds: readonly SessionEventId[] }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'cancelled'; readonly reason: string };
export class CompactionMachine {
  #state: CompactionState = { state: 'idle' };
  snapshot(): CompactionState { return this.#state; }
  start(reason: 'manual' | 'threshold' | 'overflow'): void { if (this.#state.state !== 'idle') throw new RuntimeFailure('compaction', 'Compaction already started'); this.#state = { state: 'running', reason, attempt: 1 }; }
  retry(reason: string): void { if (this.#state.state !== 'running' && this.#state.state !== 'retrying') this.#invalid(); const attempt = this.#state.attempt; this.#state = { state: 'retrying', reason, attempt: attempt + 1 }; }
  complete(result: { summary: string; retainedEventIds: readonly SessionEventId[] }): void { this.#assertActive(); this.#state = { state: 'compacted', ...result }; }
  fail(reason: string): void { this.#assertActive(); this.#state = { state: 'failed', reason }; }
  cancel(reason: string): void { this.#assertActive(); this.#state = { state: 'cancelled', reason }; }
  #assertActive(): void { if (this.#state.state !== 'running' && this.#state.state !== 'retrying') this.#invalid(); }
  #invalid(): never { throw new RuntimeFailure('compaction', 'Compaction is terminal or not active'); }
}

export interface CompactionSummary {
  readonly summary: string;
  readonly retainedEventIds: readonly SessionEventId[];
}
export interface CompactionSummarizer {
  summarize(input: { readonly messages: readonly (ModelMessage & { readonly eventId: SessionEventId })[]; readonly reason: 'manual' | 'threshold' | 'overflow'; readonly attempt: number; readonly signal: AbortSignal }): Promise<CompactionSummary>;
}
export interface DurableCompactionOptions {
  readonly store: SessionStore;
  readonly summarizer: CompactionSummarizer;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

const abortable = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw new RuntimeFailure('cancelled', 'Compaction cancelled');
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RuntimeFailure('cancelled', 'Compaction cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
};

export class DurableCompactionService {
  readonly #store: SessionStore;
  readonly #summarizer: CompactionSummarizer;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #active = new Map<SessionId, AbortController>();

  constructor(options: DurableCompactionOptions) {
    this.#store = options.store;
    this.#summarizer = options.summarizer;
    const configured = options.maxAttempts ?? 3;
    this.#maxAttempts = Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
    this.#now = options.now ?? Date.now;
  }

  cancel(id: SessionId, reason = 'Compaction cancelled'): void { this.#active.get(id)?.abort(reason); }

  async compact(id: SessionId, reason: 'manual' | 'threshold' | 'overflow', outerSignal?: AbortSignal): Promise<CompactionSummary> {
    if (this.#active.has(id)) throw new RuntimeFailure('compaction', 'Compaction already active');
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });
    this.#active.set(id, controller);
    let attemptId = '';
    let sourceRevision = revision('0');
    let attempt = 1;
    try {
      let loaded = await this.#store.load(id);
      if (loaded.projection.compactionAttempt?.state === 'running' || loaded.projection.compactionAttempt?.state === 'retrying') {
        const interrupted = loaded.projection.compactionAttempt;
        await this.#append(id, loaded.projection.revision, {
          type: 'compaction.failed', attemptId: interrupted.attemptId, sourceRevision: interrupted.sourceRevision,
          reason: 'Recovered interrupted compaction after restart', attempt: interrupted.attempt,
        });
        loaded = await this.#store.load(id);
      }
      sourceRevision = loaded.projection.revision;
      attemptId = `${id}:compact:${sourceRevision}`;
      const sourceEventIds = loaded.projection.modelContext.map(({ eventId }) => eventId);
      const sourceSet = new Set(sourceEventIds);
      await this.#append(id, loaded.projection.revision, { type: 'compaction.started', attemptId, sourceRevision, reason, attempt });
      for (; attempt <= this.#maxAttempts; attempt += 1) {
        try {
          const result = await abortable(this.#summarizer.summarize({ messages: loaded.projection.modelContext, reason, attempt, signal: controller.signal }), controller.signal);
          if (!result.summary.trim()) throw new RuntimeFailure('compaction', 'Compaction summary must not be empty', 'safe');
          const retained = [...new Set(result.retainedEventIds)];
          if (retained.some((eventId) => !sourceSet.has(eventId))) throw new RuntimeFailure('compaction', 'Compaction retained an unknown source event', 'safe');
          const current = await this.#store.load(id);
          await this.#append(id, current.projection.revision, {
            type: 'compaction.recorded', attemptId, sourceRevision, attempt, summary: result.summary,
            retainedEventIds: retained, sourceEventIds, projectionVersion: 1,
          });
          return { summary: result.summary, retainedEventIds: retained };
        } catch (error) {
          const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure('compaction', error instanceof Error ? error.message : 'Compaction failed', 'safe');
          const current = await this.#store.load(id);
          if (failure.category === 'cancelled' || controller.signal.aborted) {
            await this.#append(id, current.projection.revision, { type: 'compaction.cancelled', attemptId, sourceRevision, reason: failure.message, attempt });
            throw failure;
          }
          if (attempt >= this.#maxAttempts || failure.retry === 'unsafe') {
            await this.#append(id, current.projection.revision, { type: 'compaction.failed', attemptId, sourceRevision, reason: failure.message, attempt });
            throw failure;
          }
          await this.#append(id, current.projection.revision, { type: 'compaction.retrying', attemptId, sourceRevision, reason: failure.message, attempt: attempt + 1 });
        }
      }
      throw new RuntimeFailure('compaction', 'Compaction retry budget exhausted');
    } finally {
      outerSignal?.removeEventListener('abort', forwardAbort);
      this.#active.delete(id);
    }
  }

  async #append(id: SessionId, expectedRevision: Revision, event: SessionStoredEvent): Promise<void> {
    const sequence = Number(expectedRevision) + 1;
    const stored: SessionEvent = {
      schemaVersion: 1, sessionId: id, eventId: sessionEventId(`${id}:compaction:${sequence}`),
      revision: revision(String(sequence)), sequence, timestamp: this.#now(), visibility: 'internal', event,
    };
    await this.#store.append(id, expectedRevision, [stored]);
  }
}
