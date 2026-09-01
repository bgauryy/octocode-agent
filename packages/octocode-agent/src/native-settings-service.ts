import {
  SettingsRegistry,
  SettingsService,
  type SettingDefinition,
  type PluginPermission,
  type SettingsMutation,
  type SettingsMutationResult,
  type SettingsSnapshot,
} from '@octocodeai/agent-core';

import type { NativeSettingsStorage, StoredSettings } from './native-settings.js';
import { resolveNativeExtensionPolicy } from './native-extension-adapters.js';
import { DEFAULT_OCTOCODE_THEME, OCTOCODE_THEME_NAMES } from './settings.js';

const DEFAULT_MODEL_KEY = 'defaultModel';
const DEFAULT_PROVIDER_KEY = 'defaultProvider';
const THEME_KEY = 'theme';
const REDUCED_MOTION_KEY = 'reducedMotion';
export const NATIVE_COMPACTION_THRESHOLD_KEY = 'compactionInputTokenThreshold';
export const DEFAULT_NATIVE_COMPACTION_INPUT_TOKEN_THRESHOLD = 64_000;
const NATIVE_EXTENSIONS_KEY = 'nativeExtensions';

const themeDefinition: SettingDefinition = {
    key: THEME_KEY,
    schemaVersion: 1,
    section: 'Appearance',
    order: 10,
    kind: { type: 'enum', values: OCTOCODE_THEME_NAMES },
    scopes: ['global'],
    defaultValue: DEFAULT_OCTOCODE_THEME,
    mutability: 'editable',
    application: 'next-session',
    visibility: 'public',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
};
const reducedMotionDefinition: SettingDefinition = {
    key: REDUCED_MOTION_KEY,
    schemaVersion: 1,
    section: 'Appearance',
    order: 20,
    kind: { type: 'boolean' },
    scopes: ['global'],
    defaultValue: true,
    mutability: 'editable',
    application: 'next-session',
    visibility: 'public',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
};
const compactionThresholdDefinition: SettingDefinition = {
    key: NATIVE_COMPACTION_THRESHOLD_KEY,
    schemaVersion: 1,
    section: 'Agent',
    order: 10,
    kind: { type: 'integer', minimum: 4_096, maximum: 2_000_000 },
    scopes: ['global'],
    defaultValue: DEFAULT_NATIVE_COMPACTION_INPUT_TOKEN_THRESHOLD,
    mutability: 'editable',
    application: 'next-session',
    visibility: 'public',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
    validate: (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 4_096 && (value as number) <= 2_000_000,
};
const defaultModelDefinition: SettingDefinition = {
    key: DEFAULT_MODEL_KEY,
    schemaVersion: 1,
    section: 'Models',
    order: 10,
    kind: { type: 'string' },
    scopes: ['global'],
    defaultValue: null,
    mutability: 'editable',
    application: 'next-session',
    visibility: 'public',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
    normalize: (value: unknown) => typeof value === 'string' ? value.trim() : value,
    validate: (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200,
};
const defaultProviderDefinition: SettingDefinition = {
    key: DEFAULT_PROVIDER_KEY,
    schemaVersion: 1,
    section: 'Models',
    order: 5,
    kind: { type: 'string' },
    scopes: ['global'],
    defaultValue: null,
    mutability: 'editable',
    application: 'next-session',
    visibility: 'public',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
    normalize: (value: unknown) => typeof value === 'string' ? value.trim() : value,
    validate: (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value),
};
const nativeExtensionsDefinition: SettingDefinition = {
    key: NATIVE_EXTENSIONS_KEY,
    schemaVersion: 1,
    section: 'Extensions',
    order: 10,
    kind: { type: 'object' },
    scopes: ['global'],
    defaultValue: {},
    mutability: 'editable',
    application: 'next-session',
    visibility: 'never-render',
    owner: 'octocode-agent',
    documentation: 'docs/SETTINGS.md',
    validate: (value: unknown) => {
      try { resolveNativeExtensionPolicy({ nativeExtensions: value }); return true; } catch { return false; }
    },
};

export const NATIVE_SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.freeze([
  themeDefinition,
  reducedMotionDefinition,
  compactionThresholdDefinition,
  defaultProviderDefinition,
  defaultModelDefinition,
  nativeExtensionsDefinition,
]);

function createRegistry(): SettingsRegistry {
  const registry = new SettingsRegistry();
  for (const definition of NATIVE_SETTING_DEFINITIONS) registry.register(definition);
  return registry;
}

function hydrationEntries(values: Readonly<Record<string, unknown>>): readonly [string, unknown][] {
  const entries: [string, unknown][] = [];
  if ((OCTOCODE_THEME_NAMES as readonly unknown[]).includes(values[THEME_KEY])) {
    entries.push([THEME_KEY, values[THEME_KEY]]);
  }
  if (typeof values[REDUCED_MOTION_KEY] === 'boolean') {
    entries.push([REDUCED_MOTION_KEY, values[REDUCED_MOTION_KEY]]);
  }
  const provider = values[DEFAULT_PROVIDER_KEY];
  if (typeof provider === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(provider.trim())) {
    entries.push([DEFAULT_PROVIDER_KEY, provider.trim()]);
  }
  const model = values[DEFAULT_MODEL_KEY];
  if (typeof model === 'string' && model.trim().length > 0 && model.trim().length <= 200) {
    entries.push([DEFAULT_MODEL_KEY, model.trim()]);
  }
  if (values[NATIVE_EXTENSIONS_KEY] !== undefined) {
    const policy = resolveNativeExtensionPolicy(values);
    entries.push([NATIVE_EXTENSIONS_KEY, { reviewedHashes: policy.reviewedHashes, pluginGrants: policy.pluginGrants }]);
  }
  return entries;
}

function hydrationMutation(service: SettingsService, key: string, value: unknown): SettingsMutation {
  return {
    protocolVersion: 1,
    requestId: `hydrate:${key}`,
    action: 'set',
    scope: 'global',
    expectedRevision: service.snapshot().revision,
    payload: { key, value },
  };
}

function persistenceError(requestId: string): SettingsMutationResult {
  return {
    ok: false,
    requestId,
    error: { category: 'persistence', message: 'Settings persistence failed' },
  };
}

/**
 * Native persistence bridge for the host-neutral settings registry/service.
 * Candidate state is published only after the configured storage port commits it.
 */
export class NativeSettingsService {
  readonly registry: SettingsRegistry;
  readonly #storage: NativeSettingsStorage;
  #service: SettingsService;
  #storageRevision: string;
  #persistedValues: Record<string, unknown>;
  #history: SettingsMutation[];

  private constructor(storage: NativeSettingsStorage, stored: StoredSettings) {
    this.#storage = storage;
    this.#storageRevision = stored.revision;
    this.#persistedValues = { ...stored.values };
    this.registry = createRegistry();
    this.#service = new SettingsService(this.registry);
    this.#history = [];
  }

  static async create(storage: NativeSettingsStorage): Promise<NativeSettingsService> {
    const stored = await storage.read();
    const settings = new NativeSettingsService(storage, stored);
    for (const [key, value] of hydrationEntries(stored.values)) {
      const mutation = hydrationMutation(settings.#service, key, value);
      const result = await settings.#service.mutate(mutation);
      if (!result.ok) throw new Error(`Could not hydrate native setting: ${key}`);
      settings.#history.push(mutation);
    }
    return settings;
  }

  snapshot(): SettingsSnapshot {
    return this.#service.snapshot();
  }

  diagnostics(): {
    readonly storageRevision: string;
    readonly unknownStoredKeys: readonly { readonly key: string; readonly valueType: string }[];
  } {
    const registered = new Set(NATIVE_SETTING_DEFINITIONS.map(({ key }) => key));
    return {
      storageRevision: this.#storageRevision,
      unknownStoredKeys: Object.keys(this.#persistedValues)
        .filter((key) => !registered.has(key))
        .sort()
        .map((key) => ({
          key,
          valueType: Array.isArray(this.#persistedValues[key]) ? 'array' : typeof this.#persistedValues[key],
        })),
    };
  }

  exportPortable(): NativePortableSettings {
    const values: Record<string, string> = {};
    for (const entry of this.snapshot().values) {
      const definition = this.registry.get(entry.key);
      if (definition?.visibility === 'public' && entry.stored && typeof entry.value === 'string') values[entry.key] = entry.value;
    }
    return { schemaVersion: 1, values };
  }

  importPortable(input: {
    readonly requestId: string;
    readonly expectedRevision: SettingsSnapshot['revision'];
    readonly document: unknown;
  }): Promise<SettingsMutationResult> {
    const document = parsePortableSettings(input.document);
    if (document === undefined) return Promise.resolve(mutationError(input.requestId, 'validation', 'Invalid portable settings document'));
    const actions = Object.entries(document.values).map(([key, value]) => ({ action: 'set' as const, payload: { key, value } }));
    if (actions.length === 0) return Promise.resolve(mutationError(input.requestId, 'validation', 'Portable settings document is empty'));
    return this.#mutateTransaction({ requestId: input.requestId, expectedRevision: input.expectedRevision, actions });
  }

  reset(input: { readonly requestId: string; readonly expectedRevision: SettingsSnapshot['revision'] }): Promise<SettingsMutationResult> {
    return this.#mutateTransaction({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      actions: NATIVE_SETTING_DEFINITIONS.map(({ key }) => ({ action: 'unset' as const, payload: { key } })),
    });
  }

  async mutate(mutation: SettingsMutation): Promise<SettingsMutationResult> {
    return this.#mutateTransaction({
      requestId: mutation.requestId,
      expectedRevision: mutation.expectedRevision,
      actions: [{ action: mutation.action, payload: mutation.payload }],
    });
  }

  async setDefaultModel(input: {
    readonly requestId: string;
    readonly expectedRevision: SettingsSnapshot['revision'];
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<SettingsMutationResult> {
    return this.#mutateTransaction({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      actions: [
        { action: 'set', payload: { key: DEFAULT_PROVIDER_KEY, value: input.providerId } },
        { action: 'set', payload: { key: DEFAULT_MODEL_KEY, value: input.modelId } },
      ],
    });
  }

  reviewExtension(input: ExtensionPolicyInput & { readonly id: string; readonly hash: string }): Promise<SettingsMutationResult> {
    return this.#mutateExtensionPolicy(input, (policy) => {
      policy.reviewedHashes[input.id] = input.hash;
    });
  }

  unreviewExtension(input: ExtensionPolicyInput & { readonly id: string }): Promise<SettingsMutationResult> {
    return this.#mutateExtensionPolicy(input, (policy) => { delete policy.reviewedHashes[input.id]; });
  }

  grantPluginCapability(input: ExtensionPolicyInput & { readonly pluginId: string; readonly permission: PluginPermission }): Promise<SettingsMutationResult> {
    return this.#mutateExtensionPolicy(input, (policy) => {
      policy.pluginGrants[input.pluginId] = [...new Set([...(policy.pluginGrants[input.pluginId] ?? []), input.permission])];
    });
  }

  revokePluginCapability(input: ExtensionPolicyInput & { readonly pluginId: string; readonly permission: PluginPermission }): Promise<SettingsMutationResult> {
    return this.#mutateExtensionPolicy(input, (policy) => {
      policy.pluginGrants[input.pluginId] = (policy.pluginGrants[input.pluginId] ?? []).filter((permission) => permission !== input.permission);
    });
  }

  async #mutateExtensionPolicy(input: ExtensionPolicyInput, update: (policy: { reviewedHashes: Record<string, string>; pluginGrants: Record<string, PluginPermission[]> }) => void): Promise<SettingsMutationResult> {
    if (!input.workspaceTrusted) return mutationError(input.requestId, 'policy', 'Extension policy changes require a trusted workspace');
    if (input.expectedRevision !== this.snapshot().revision) return mutationError(input.requestId, 'conflict', 'Settings changed since snapshot', this.snapshot().revision);
    let current;
    try { current = resolveNativeExtensionPolicy(this.#persistedValues); }
    catch { return mutationError(input.requestId, 'validation', 'Stored extension policy is invalid'); }
    const candidate = {
      reviewedHashes: { ...current.reviewedHashes },
      pluginGrants: Object.fromEntries(Object.entries(current.pluginGrants).map(([id, permissions]) => [id, [...permissions]])) as Record<string, PluginPermission[]>,
    };
    update(candidate);
    try { resolveNativeExtensionPolicy({ nativeExtensions: candidate }); }
    catch { return mutationError(input.requestId, 'validation', 'Invalid extension policy mutation'); }
    return this.mutate({ protocolVersion: 1, requestId: input.requestId, action: 'set', scope: 'global', expectedRevision: input.expectedRevision, payload: { key: NATIVE_EXTENSIONS_KEY, value: candidate } });
  }

  async #mutateTransaction(input: {
    readonly requestId: string;
    readonly expectedRevision: SettingsSnapshot['revision'];
    readonly actions: readonly Pick<SettingsMutation, 'action' | 'payload'>[];
  }): Promise<SettingsMutationResult> {
    const first = input.actions[0];
    if (first === undefined) return persistenceError(input.requestId);
    const mutation: SettingsMutation = {
      protocolVersion: 1,
      requestId: input.requestId,
      action: first.action,
      scope: 'global',
      expectedRevision: input.expectedRevision,
      payload: first.payload,
    };
    if (mutation.expectedRevision !== this.#service.snapshot().revision) {
      return this.#service.mutate(mutation);
    }
    const expectedStorageRevision = this.#storageRevision;
    const persistedBase = { ...this.#persistedValues };

    const candidate = new SettingsService(this.registry);
    for (const prior of this.#history) {
      const replayed = await candidate.mutate({ ...prior, expectedRevision: candidate.snapshot().revision });
      if (!replayed.ok) return persistenceError(mutation.requestId);
    }
    const applied: SettingsMutation[] = [];
    const results: Extract<SettingsMutationResult, { ok: true }>[] = [];
    const persistedValues = persistedBase;
    for (const [index, action] of input.actions.entries()) {
      const step: SettingsMutation = {
        protocolVersion: 1,
        requestId: `${input.requestId}:${index}`,
        action: action.action,
        scope: 'global',
        expectedRevision: candidate.snapshot().revision,
        payload: action.payload,
      };
      const result = await candidate.mutate(step);
      if (!result.ok) return { ...result, requestId: input.requestId };
      const payload = step.payload as { key: string };
      if (step.action === 'unset') delete persistedValues[payload.key];
      else if (result.storedValue !== undefined) {
        const definition = this.registry.get(payload.key);
        persistedValues[payload.key] = definition?.visibility === 'never-render'
          ? structuredClone((step.payload as { value?: unknown }).value)
          : result.storedValue.value;
      }
      applied.push(step);
      results.push(result);
    }

    try {
      const stored = await this.#storage.commit(expectedStorageRevision, persistedValues);
      this.#storageRevision = stored.revision;
      this.#persistedValues = { ...stored.values };
    } catch {
      return persistenceError(mutation.requestId);
    }

    this.#service = candidate;
    this.#history.push(...applied);
    const result = results.at(-1)!;
    return {
      ...result,
      requestId: input.requestId,
      redactedImpact: results.flatMap(({ redactedImpact }) => redactedImpact),
      auditReceiptId: `settings-transaction:${result.revision}`,
    };
  }
}

export interface NativePortableSettings {
  readonly schemaVersion: 1;
  readonly values: Readonly<Record<string, string | boolean>>;
}

const PORTABLE_KEYS = new Set([THEME_KEY, REDUCED_MOTION_KEY, DEFAULT_PROVIDER_KEY, DEFAULT_MODEL_KEY]);

function parsePortableSettings(value: unknown): NativePortableSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || !item.values || typeof item.values !== 'object' || Array.isArray(item.values)) return undefined;
  const entries = Object.entries(item.values as Record<string, unknown>);
  if (entries.some(([key, entry]) => !PORTABLE_KEYS.has(key)
    || (key === REDUCED_MOTION_KEY ? typeof entry !== 'boolean' : typeof entry !== 'string'))) return undefined;
  return { schemaVersion: 1, values: Object.fromEntries(entries) as Record<string, string | boolean> };
}

interface ExtensionPolicyInput {
  readonly requestId: string;
  readonly expectedRevision: SettingsSnapshot['revision'];
  readonly workspaceTrusted: boolean;
}

function mutationError(requestId: string, category: 'validation' | 'conflict' | 'policy', message: string, currentRevision?: SettingsSnapshot['revision']): SettingsMutationResult {
  return { ok: false, requestId, error: { category, message, ...(currentRevision === undefined ? {} : { currentRevision }) } };
}

export function createNativeSettingsService(storage: NativeSettingsStorage): Promise<NativeSettingsService> {
  return NativeSettingsService.create(storage);
}
