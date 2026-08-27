import { RuntimeFailure } from '../contracts/errors.js';
import type { CommandDefinition } from '../contracts/commands.js';
import type { ToolDefinition } from '../contracts/tools.js';

export interface OwnedRegistration<T> { readonly owner: string; readonly value: T; }

class Registry<T extends { readonly name: string }> {
  readonly #entries = new Map<string, OwnedRegistration<T>>();
  register(value: T, owner: string): void {
    if (this.#entries.has(value.name)) throw new RuntimeFailure('validation', `Duplicate registry identity: ${value.name}`);
    this.#entries.set(value.name, { owner, value });
  }
  get(name: string): (T & { readonly owner: string }) | undefined {
    const registration = this.#entries.get(name);
    return registration === undefined ? undefined : Object.assign(registration.value, { owner: registration.owner });
  }
  list(): readonly (T & { readonly owner: string })[] {
    return [...this.#entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => Object.assign(entry.value, { owner: entry.owner }));
  }
  unregisterOwner(owner: string): readonly string[] {
    const removed: string[] = [];
    for (const [name, entry] of this.#entries) if (entry.owner === owner) { this.#entries.delete(name); removed.push(name); }
    return removed.sort();
  }
}

export class ToolRegistry extends Registry<ToolDefinition> {}
export class CommandRegistry extends Registry<CommandDefinition> {}
