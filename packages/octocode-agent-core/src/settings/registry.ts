import { RuntimeFailure } from '../contracts/errors.js';
import type { SettingDefinition } from '../contracts/settings.js';
export class SettingsRegistry {
  readonly #definitions = new Map<string, SettingDefinition>();
  register(definition: SettingDefinition): void {
    if (this.#definitions.has(definition.key)) throw new RuntimeFailure('validation', `Duplicate setting: ${definition.key}`);
    this.#definitions.set(definition.key, Object.freeze(definition));
  }
  get(key: string): SettingDefinition | undefined { return this.#definitions.get(key); }
  list(): readonly SettingDefinition[] { return [...this.#definitions.values()].sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order || a.key.localeCompare(b.key)); }
}
