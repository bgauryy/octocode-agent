import { RuntimeFailure } from '../contracts/errors.js';
import type { SessionEventId } from '../contracts/identity.js';
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
