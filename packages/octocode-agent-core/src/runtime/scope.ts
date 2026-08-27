import { RuntimeFailure } from '../contracts/errors.js';
export class ExecutionScope {
  readonly #controller = new AbortController();
  readonly #children = new Set<ExecutionScope>();
  readonly signal = this.#controller.signal;
  constructor(readonly name: string, readonly parent?: ExecutionScope) {
    if (parent?.signal.aborted) this.#controller.abort(parent.signal.reason);
    else if (parent !== undefined) { parent.#children.add(this); parent.signal.addEventListener('abort', () => this.cancel(parent.signal.reason), { once: true }); }
  }
  child(name: string): ExecutionScope { if (this.signal.aborted) throw new RuntimeFailure('cancelled', `Scope ${this.name} is cancelled`, 'unsafe', true, 'public', 'operation'); return new ExecutionScope(name, this); }
  cancel(reason: unknown = 'cancelled'): void { if (this.signal.aborted) return; this.#controller.abort(reason); for (const child of this.#children) child.cancel(reason); this.#children.clear(); if (this.parent !== undefined) this.parent.#children.delete(this); }
  close(): void { for (const child of this.#children) child.cancel(`Parent scope ${this.name} closed`); this.#children.clear(); if (this.parent !== undefined) this.parent.#children.delete(this); }
}
