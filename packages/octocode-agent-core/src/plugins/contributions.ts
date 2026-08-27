import { RuntimeFailure } from '../contracts/errors.js';
import type { PluginContribution } from '../contracts/plugins.js';
export class ContributionRegistry {
  readonly #entries = new Map<string, PluginContribution>();
  begin(): ContributionTransaction { return new ContributionTransaction(this); }
  list(): readonly PluginContribution[] { return [...this.#entries.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)); }
  removeOwner(owner: string): readonly PluginContribution[] { const removed: PluginContribution[] = []; for (const [key, contribution] of [...this.#entries]) if (contribution.owner === owner) { this.#entries.delete(key); removed.push(contribution); } return removed.reverse(); }
  commit(contributions: readonly PluginContribution[]): void { const keys = new Set<string>(); for (const contribution of contributions) { const key = `${contribution.kind}:${contribution.id}`; if (keys.has(key) || this.#entries.has(key)) throw new RuntimeFailure('plugin', `Duplicate contribution: ${key}`); keys.add(key); } for (const contribution of contributions) this.#entries.set(`${contribution.kind}:${contribution.id}`, Object.freeze(contribution)); }
}
export class ContributionTransaction {
  readonly #pending: PluginContribution[] = [];
  #closed = false;
  constructor(readonly registry: ContributionRegistry) {}
  add(contribution: PluginContribution): void { if (this.#closed) throw new RuntimeFailure('plugin', 'Contribution transaction is closed'); this.#pending.push(contribution); }
  commit(): void { if (this.#closed) throw new RuntimeFailure('plugin', 'Contribution transaction is closed'); this.registry.commit(this.#pending); this.#closed = true; }
  rollback(): void { this.#closed = true; this.#pending.length = 0; }
}
