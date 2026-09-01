import {
  ContributionRegistry,
  HookCatalog,
  PluginActivator,
  PluginLeaseRegistry,
  RuntimeFailure,
  type CodexHookConfiguration,
  type EffectiveHookGroup,
  type HookSourceDescriptor,
  type PluginCapabilityGrant,
  type PluginContribution,
  type PluginLease,
  type PluginLifecycleState,
  type PluginManifest,
  type ToolDefinition,
  type ToolEffect,
  type ToolRegistry,
} from '@octocodeai/agent-core';

export interface NativeDiscoveredHook {
  readonly source: HookSourceDescriptor;
  readonly configuration: CodexHookConfiguration;
  readonly enabled?: boolean;
  readonly reviewedHash?: string;
}

export interface NativeDiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly grant: PluginCapabilityGrant;
  readonly trust: 'trusted' | 'review-required' | 'denied';
  readonly manifestHash: string;
  readonly reviewedHash?: string;
  /** Canonical real path used only by the native filesystem activation adapter. */
  readonly root?: string;
}

export interface NativeExtensionsOptions {
  readonly discoverHooks: () => Promise<readonly NativeDiscoveredHook[]>;
  readonly discoverPlugins: () => Promise<readonly NativeDiscoveredPlugin[]>;
  readonly activatePlugin: (
    candidate: NativeDiscoveredPlugin,
    contributions: NativePluginContributionWriter,
  ) => Promise<void>;
  /** Observability boundary for lifecycle evidence; it cannot rewrite policy or state. */
  readonly onLifecycle?: (event: Readonly<{
    pluginId: string;
    version: string;
    state: PluginLifecycleState;
    timestamp: number;
    diagnostic?: string;
  }>) => void;
  readonly now?: () => number;
}

export interface NativePluginContributionWriter {
  add(contribution: Omit<PluginContribution, 'owner'>): void;
  addTool(id: string, definition: ToolDefinition): void;
}

export interface NativeExtensionsSnapshot {
  readonly discovered: boolean;
  readonly hooks: ReturnType<HookCatalog['snapshot']>;
  readonly plugins: readonly {
    readonly id: string;
    readonly version: string;
    readonly active: boolean;
    readonly lifecycle: PluginLifecycleState;
    readonly review: 'approved' | 'review-required' | 'stale' | 'denied';
    readonly diagnostic?: string;
  }[];
  readonly contributions: readonly PluginContribution[];
  readonly activeLeases: readonly PluginLease[];
}

export interface NativePluginActivationResult {
  readonly activated: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: 'trust' | 'capabilities' | 'expired' }[];
}

export class NativeExtensionsController {
  readonly #hooks = new HookCatalog();
  readonly #contributions = new ContributionRegistry();
  readonly #leases = new PluginLeaseRegistry();
  readonly #activator: PluginActivator;
  readonly #plugins = new Map<string, NativeDiscoveredPlugin>();
  readonly #lifecycle = new Map<string, { state: PluginLifecycleState; diagnostic?: string }>();
  readonly #active = new Set<string>();
  readonly #toolRegistries = new Map<ToolRegistry, Set<string>>();
  readonly #now: () => number;
  #discovered = false;

  constructor(readonly options: NativeExtensionsOptions) {
    this.#now = options.now ?? Date.now;
    this.#activator = new PluginActivator(this.#contributions, this.#now);
    this.#activator.subscribe((event) => {
      this.#lifecycle.set(event.pluginId, {
        state: event.state,
        ...(event.diagnostic === undefined ? {} : { diagnostic: event.diagnostic }),
      });
      if (event.state === 'ready') this.#active.add(event.pluginId);
      if (event.state === 'stopped') this.#active.delete(event.pluginId);
      options.onLifecycle?.(event);
    });
  }

  async discover(): Promise<void> {
    if (this.#discovered) throw new RuntimeFailure('plugin', 'Native extensions have already been discovered');
    const [hooks, plugins] = await Promise.all([
      this.options.discoverHooks(),
      this.options.discoverPlugins(),
    ]);
    assertUnique(hooks.map((entry) => entry.source.id), 'hook source');
    assertUnique(plugins.map((entry) => entry.manifest.id), 'plugin');

    for (const entry of hooks) {
      this.#hooks.register(entry.source, entry.configuration, entry.enabled ?? true);
      if (entry.reviewedHash === entry.source.normalizedHash) {
        this.#hooks.review(entry.source.id, entry.reviewedHash);
      }
    }
    for (const candidate of plugins) {
      this.#plugins.set(candidate.manifest.id, candidate);
      this.#lifecycle.set(candidate.manifest.id, { state: 'discovered' });
    }
    this.#discovered = true;
  }

  async activate(id: string): Promise<void> {
    this.#assertDiscovered();
    const candidate = this.#plugins.get(id);
    if (candidate === undefined) throw new RuntimeFailure('plugin', `Unknown plugin: ${id}`);
    if (this.#active.has(id)) throw new RuntimeFailure('plugin', `Plugin is already active: ${id}`);
    if (!this.#isApproved(candidate)) {
      this.#lifecycle.set(id, { state: 'trust-required', diagnostic: 'Plugin review is missing, stale, or denied' });
      throw new RuntimeFailure('trust', `Plugin must be reviewed and trusted before activation: ${id}`);
    }
    if (candidate.grant.expiresAt !== undefined && candidate.grant.expiresAt <= this.#now()) {
      this.#lifecycle.set(id, { state: 'trust-required', diagnostic: 'Plugin capability grant has expired' });
      throw new RuntimeFailure('trust', `Plugin capability grant has expired: ${id}`);
    }
    await this.#activator.activate(candidate.manifest, candidate.grant, (transaction) => (
      this.options.activatePlugin(candidate, {
        add: (contribution) => transaction.add({ ...contribution, owner: candidate.manifest.id }),
        addTool: (id, definition) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
            throw new RuntimeFailure('validation', `Plugin tool requires a safe id: ${id}`);
          }
          transaction.add({
            kind: 'tool',
            id: `${candidate.manifest.id}:${id}`,
            owner: candidate.manifest.id,
            value: definition,
          });
        },
      })
    ));
  }

  /** Activates only candidates that already carry an exact review and complete explicit grant. */
  async activateEligible(): Promise<NativePluginActivationResult> {
    this.#assertDiscovered();
    const activated: string[] = [];
    const skipped: { id: string; reason: 'trust' | 'capabilities' | 'expired' }[] = [];
    try {
      for (const candidate of [...this.#plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
        const id = String(candidate.manifest.id);
        if (!this.#isApproved(candidate)) { skipped.push({ id, reason: 'trust' }); continue; }
        if (candidate.grant.expiresAt !== undefined && candidate.grant.expiresAt <= this.#now()) { skipped.push({ id, reason: 'expired' }); continue; }
        if (candidate.manifest.permissions.some((permission) => !candidate.grant.granted.includes(permission))) {
          skipped.push({ id, reason: 'capabilities' }); continue;
        }
        await this.activate(id);
        activated.push(id);
      }
      return Object.freeze({ activated: Object.freeze(activated), skipped: Object.freeze(skipped) });
    } catch (error) {
      for (const id of activated.reverse()) this.deactivate(id);
      throw error;
    }
  }

  /** Reverse-order production shutdown for active contributions. */
  deactivateAll(): void {
    for (const id of [...this.#active].reverse()) this.deactivate(id);
  }

  deactivate(id: string): void {
    this.#assertDiscovered();
    if (!this.#active.has(id)) return;
    this.#leases.assertCanUnload(id);
    this.#activator.deactivate(id);
    const owner = `plugin:${id}`;
    for (const [registry, owners] of this.#toolRegistries) {
      registry.unregisterOwner(owner);
      owners.delete(owner);
      if (owners.size === 0) this.#toolRegistries.delete(registry);
    }
  }

  acquireLease(lease: PluginLease): void {
    const candidate = this.#plugins.get(lease.pluginId);
    if (candidate === undefined || !this.#active.has(lease.pluginId)) {
      throw new RuntimeFailure('plugin', `Cannot lease inactive plugin: ${lease.pluginId}`);
    }
    if (candidate.manifest.version !== lease.version || candidate.manifestHash !== lease.hash) {
      throw new RuntimeFailure('plugin', `Plugin lease identity does not match the active plugin: ${lease.pluginId}`);
    }
    this.#leases.acquire(lease);
  }

  releaseLease(operationId: string, releasedAt = this.#now()): void {
    this.#leases.release(operationId, releasedAt);
  }

  effectiveHooks(options: { readonly workspaceTrusted: boolean; readonly managedOnly: boolean }): readonly EffectiveHookGroup[] {
    return this.#hooks.effective(options.workspaceTrusted, options.managedOnly);
  }

  /** Materialize executable API-provided tool contributions into one runtime registry. */
  registerTools(registry: ToolRegistry, allowedTools?: ReadonlySet<string>): readonly string[] {
    this.#assertDiscovered();
    if (this.#toolRegistries.has(registry)) throw new RuntimeFailure('plugin', 'Plugin tools are already registered in this runtime');
    const pending = this.#contributions.list()
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => {
        if (!this.#active.has(entry.owner)) throw new RuntimeFailure('plugin', `Tool contribution owner is inactive: ${entry.owner}`);
        const candidate = this.#plugins.get(entry.owner)!;
        const definition = executableTool(entry.value, entry.id);
        assertToolPermissions(candidate.grant.granted, definition.policy.effects, entry.id);
        const name = entry.id.startsWith(`${entry.owner}:`) ? entry.id : `${entry.owner}:${entry.id}`;
        return { entry, candidate, definition, name };
      })
      .filter(({ name }) => allowedTools === undefined || allowedTools.has(name));
    const names = new Set<string>();
    for (const item of pending) {
      if (names.has(item.name) || registry.get(item.name) !== undefined) throw new RuntimeFailure('validation', `Duplicate registry identity: ${item.name}`);
      names.add(item.name);
    }
    const owners = new Set<string>();
    try {
      for (const { entry, candidate, definition, name } of pending) {
        const owner = `plugin:${entry.owner}`;
        owners.add(owner);
        registry.register({
          ...definition,
          name,
          execute: async (input) => {
            const operationId = String(input.callId);
            this.acquireLease({
              pluginId: entry.owner,
              version: candidate.manifest.version,
              hash: candidate.manifestHash,
              contributionId: entry.id,
              operationId,
              acquiredAt: this.#now(),
              cancelled: false,
            });
            try { return await definition.execute(input); }
            finally { this.releaseLease(operationId); }
          },
        }, owner);
      }
    } catch (error) {
      for (const owner of owners) registry.unregisterOwner(owner);
      throw error;
    }
    this.#toolRegistries.set(registry, owners);
    return Object.freeze([...names].sort());
  }

  snapshot(): NativeExtensionsSnapshot {
    return {
      discovered: this.#discovered,
      hooks: this.#hooks.snapshot(),
      plugins: [...this.#plugins.values()]
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
        .map((candidate) => {
          const lifecycle = this.#lifecycle.get(candidate.manifest.id) ?? { state: 'discovered' as const };
          return {
            id: candidate.manifest.id,
            version: candidate.manifest.version,
            active: this.#active.has(candidate.manifest.id),
            lifecycle: lifecycle.state,
            review: this.#reviewState(candidate),
            ...(lifecycle.diagnostic === undefined ? {} : { diagnostic: lifecycle.diagnostic }),
          };
        }),
      contributions: this.#contributions.list(),
      activeLeases: this.#leases.active(),
    };
  }

  #assertDiscovered(): void {
    if (!this.#discovered) throw new RuntimeFailure('plugin', 'Native extensions have not been discovered');
  }

  #isApproved(candidate: NativeDiscoveredPlugin): boolean {
    return candidate.trust === 'trusted'
      && candidate.reviewedHash !== undefined
      && candidate.reviewedHash === candidate.manifestHash;
  }

  #reviewState(candidate: NativeDiscoveredPlugin): 'approved' | 'review-required' | 'stale' | 'denied' {
    if (candidate.trust === 'denied') return 'denied';
    if (candidate.reviewedHash !== undefined && candidate.reviewedHash !== candidate.manifestHash) return 'stale';
    return this.#isApproved(candidate) ? 'approved' : 'review-required';
  }
}

function assertUnique(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new RuntimeFailure('validation', `Duplicate discovered ${kind}: ${value}`);
    seen.add(value);
  }
}

function executableTool(value: unknown, id: string): ToolDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RuntimeFailure('validation', `Plugin tool ${id} must be an executable definition`);
  const definition = value as Partial<ToolDefinition>;
  if (typeof definition.execute !== 'function') throw new RuntimeFailure('unsupported-capability', `Plugin tool ${id} requires an executor provided through the activation API`);
  if (typeof definition.label !== 'string' || typeof definition.description !== 'string') throw new RuntimeFailure('validation', `Plugin tool ${id} requires label and description`);
  if (!Number.isSafeInteger(definition.schemaVersion) || !Number.isSafeInteger(definition.outputVersion)) throw new RuntimeFailure('validation', `Plugin tool ${id} requires integer schema versions`);
  if (typeof definition.inputSchema !== 'object' || definition.inputSchema === null || typeof definition.outputSchema !== 'object' || definition.outputSchema === null) throw new RuntimeFailure('validation', `Plugin tool ${id} requires input and output schemas`);
  if (typeof definition.policy !== 'object' || definition.policy === null || !Array.isArray(definition.policy.effects)) throw new RuntimeFailure('validation', `Plugin tool ${id} requires policy metadata`);
  return definition as ToolDefinition;
}

function assertToolPermissions(granted: readonly string[], effects: readonly ToolEffect[], id: string): void {
  const required = new Set<string>(['tools.register']);
  if (effects.includes('network')) required.add('network.access');
  if (effects.includes('process')) required.add('process.execute');
  if (effects.includes('write') || effects.includes('destructive')) required.add('filesystem.write');
  for (const permission of required) if (!granted.includes(permission)) {
    throw new RuntimeFailure('trust', `Plugin tool ${id} requires granted permission ${permission}`);
  }
}
