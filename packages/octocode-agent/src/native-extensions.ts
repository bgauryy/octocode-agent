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
  readonly now?: () => number;
}

export interface NativePluginContributionWriter {
  add(contribution: Omit<PluginContribution, 'owner'>): void;
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
