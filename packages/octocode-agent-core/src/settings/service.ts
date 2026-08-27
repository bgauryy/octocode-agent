import { revision, type Revision } from '../contracts/identity.js';
import type { SettingDefinition, SettingScope, SettingsMutation, SettingsMutationResult, SettingsSnapshot, SettingValue } from '../contracts/settings.js';
import { SettingsRegistry } from './registry.js';

const PRECEDENCE: readonly SettingScope[] = ['session', 'managed', 'workspace', 'global', 'imported'];
const provenance = (scope: SettingScope): SettingValue['provenance'] => scope === 'workspace' ? 'workspace' : scope === 'global' ? 'global' : scope === 'imported' ? 'imported' : scope === 'managed' ? 'policy' : 'runtime';
export class SettingsService {
  readonly #values = new Map<string, Map<SettingScope, { value: unknown; revision: Revision }>>();
  #revision = 0;
  constructor(readonly registry: SettingsRegistry) {}
  snapshot(): SettingsSnapshot {
    const definitions = this.registry.list();
    return { schemaVersion: 1, revision: revision(String(this.#revision)), definitions: definitions.map(redactDefinition), values: definitions.map((definition) => this.#effective(definition)), revisionVector: { settings: revision(String(this.#revision)) }, sourceHealth: [] };
  }
  async mutate(mutation: SettingsMutation): Promise<SettingsMutationResult> {
    if (mutation.protocolVersion !== 1) return this.#error(mutation.requestId, 'validation', 'Unsupported settings protocol');
    if (mutation.expectedRevision !== revision(String(this.#revision))) return this.#error(mutation.requestId, 'conflict', 'Settings changed since snapshot', revision(String(this.#revision)));
    if (mutation.action !== 'set' && mutation.action !== 'unset') return this.#error(mutation.requestId, 'validation', `Action ${mutation.action} requires a model/settings adapter`);
    if (!isSettingPayload(mutation.payload)) return this.#error(mutation.requestId, 'validation', 'Invalid settings payload');
    const definition = this.registry.get(mutation.payload.key);
    if (definition === undefined || definition.mutability !== 'editable' || !definition.scopes.includes(mutation.scope)) return this.#error(mutation.requestId, 'validation', `Setting is unavailable in ${mutation.scope}`);
    const values = this.#values.get(definition.key) ?? new Map();
    if (mutation.action === 'unset') values.delete(mutation.scope);
    else {
      const normalized = definition.normalize?.(mutation.payload.value) ?? mutation.payload.value;
      if (!validateKind(definition, normalized) || definition.validate?.(normalized) === false) return this.#error(mutation.requestId, 'validation', `Invalid value for ${definition.key}`);
      values.set(mutation.scope, { value: normalized, revision: revision(String(this.#revision + 1)) });
    }
    this.#values.set(definition.key, values); this.#revision += 1;
    const effectiveValue = this.#effective(definition);
    return { ok: true, requestId: mutation.requestId, revision: revision(String(this.#revision)), storedValue: values.has(mutation.scope) ? this.#present(definition, mutation.scope, values.get(mutation.scope)!) : undefined, effectiveValue, application: definition.application, redactedImpact: [`${definition.key}:${mutation.action}`], auditReceiptId: `settings:${this.#revision}` };
  }
  #effective(definition: SettingDefinition): SettingValue {
    const values = this.#values.get(definition.key);
    for (const scope of PRECEDENCE) { const value = values?.get(scope); if (value !== undefined) return this.#present(definition, scope, value); }
    return { key: definition.key, value: redactValue(definition, definition.defaultValue), stored: false, scope: 'global', provenance: 'default', revision: revision('0'), warnings: [], application: definition.application };
  }
  #present(definition: SettingDefinition, scope: SettingScope, record: { value: unknown; revision: Revision }): SettingValue { return { key: definition.key, value: redactValue(definition, record.value), stored: true, scope, provenance: provenance(scope), revision: record.revision, warnings: [], application: definition.application }; }
  #error(requestId: string, category: 'validation' | 'conflict' | 'policy' | 'persistence', message: string, currentRevision?: Revision): SettingsMutationResult { return { ok: false, requestId, error: { category, message, ...(currentRevision === undefined ? {} : { currentRevision }) } }; }
}
const isSettingPayload = (value: unknown): value is { key: string; value?: unknown } => typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string';
const redactDefinition = (definition: SettingDefinition): SettingDefinition => definition.visibility === 'secret-reference' || definition.visibility === 'never-render' ? { ...definition, defaultValue: null } : definition;
const redactValue = (definition: SettingDefinition, value: unknown): unknown => definition.visibility === 'secret-reference' ? (value === null ? null : { configured: true }) : definition.visibility === 'never-render' ? null : value;
const validateKind = (definition: SettingDefinition, value: unknown): boolean => { const kind = definition.kind; switch (kind.type) { case 'boolean': return typeof value === 'boolean'; case 'enum': return typeof value === 'string' && kind.values.includes(value); case 'string': case 'path': case 'secret-reference': return typeof value === 'string'; case 'integer': return Number.isInteger(value) && (kind.minimum === undefined || (value as number) >= kind.minimum) && (kind.maximum === undefined || (value as number) <= kind.maximum); case 'duration': return typeof value === 'number' && value >= (kind.minimumMs ?? 0) && value <= (kind.maximumMs ?? Number.MAX_SAFE_INTEGER); case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value); case 'list': return Array.isArray(value); } };
