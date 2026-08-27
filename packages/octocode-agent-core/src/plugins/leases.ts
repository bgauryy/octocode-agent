import { RuntimeFailure } from '../contracts/errors.js';
import type { PluginLease } from '../contracts/plugins.js';
export class PluginLeaseRegistry {
  readonly #leases = new Map<string, PluginLease>();
  acquire(lease: PluginLease): void { if (this.#leases.has(lease.operationId)) throw new RuntimeFailure('plugin', `Duplicate plugin lease: ${lease.operationId}`); this.#leases.set(lease.operationId, lease); }
  release(operationId: string, releasedAt: number): void { const lease = this.#leases.get(operationId); if (lease === undefined) return; this.#leases.set(operationId, { ...lease, releasedAt }); }
  active(pluginId?: string): readonly PluginLease[] { return [...this.#leases.values()].filter((lease) => lease.releasedAt === undefined && (pluginId === undefined || lease.pluginId === pluginId)).sort((a, b) => a.acquiredAt - b.acquiredAt || a.operationId.localeCompare(b.operationId)); }
  assertCanUnload(pluginId: string): void { const active = this.active(pluginId); if (active.length > 0) throw new RuntimeFailure('plugin', `Plugin has ${active.length} active lease(s)`, 'safe'); }
}
