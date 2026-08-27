import { RuntimeFailure } from '../contracts/errors.js';
import type { PluginCapabilityGrant, PluginLifecycleEvent, PluginManifest } from '../contracts/plugins.js';
import { ContributionRegistry, type ContributionTransaction } from './contributions.js';
export class PluginActivator {
  readonly #active = new Map<string, PluginManifest>();
  readonly #listeners = new Set<(event: PluginLifecycleEvent) => void>();
  constructor(readonly registry: ContributionRegistry, readonly now: () => number = Date.now) {}
  subscribe(listener: (event: PluginLifecycleEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async activate(manifest: PluginManifest, grant: PluginCapabilityGrant, activate: (transaction: ContributionTransaction) => Promise<void>): Promise<void> {
    this.#validate(manifest, grant); const transaction = this.registry.begin(); this.#emit(manifest, 'activating');
    try { await activate(transaction); transaction.commit(); this.#active.set(manifest.id, manifest); this.#emit(manifest, 'ready'); }
    catch (error) { transaction.rollback(); this.#emit(manifest, 'failed', error instanceof Error ? error.message : 'Activation failed'); throw error; }
  }
  deactivate(id: string): void { const manifest = this.#active.get(id); if (manifest === undefined) return; this.#emit(manifest, 'deactivating'); this.registry.removeOwner(id); this.#active.delete(id); this.#emit(manifest, 'stopped'); }
  #validate(manifest: PluginManifest, grant: PluginCapabilityGrant): void { if (manifest.apiVersion !== '1') throw new RuntimeFailure('unsupported-version', `Unsupported plugin API ${manifest.apiVersion}`); const denied = manifest.permissions.filter((permission) => !grant.granted.includes(permission)); if (denied.length > 0) throw new RuntimeFailure('trust', `Plugin capabilities denied: ${denied.join(', ')}`); for (const contribution of manifest.contributions) if (!contribution.path.startsWith('./') || contribution.path.includes('..')) throw new RuntimeFailure('validation', `Unsafe contribution path: ${contribution.path}`); }
  #emit(manifest: PluginManifest, state: PluginLifecycleEvent['state'], diagnostic?: string): void { const event: PluginLifecycleEvent = { pluginId: manifest.id, version: manifest.version, state, timestamp: this.now(), ...(diagnostic === undefined ? {} : { diagnostic }) }; for (const listener of this.#listeners) listener(event); }
}
