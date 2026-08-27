import { RuntimeFailure } from '../contracts/errors.js';
import type { CodexHookConfiguration, HookMatcherGroup, HookSourceDescriptor } from '../contracts/hooks.js';
import type { Revision } from '../contracts/identity.js';

export interface HookCatalogEntry { readonly source: HookSourceDescriptor; readonly enabled: boolean; readonly configuration: CodexHookConfiguration; }
export interface EffectiveHookGroup { readonly event: string; readonly source: HookSourceDescriptor; readonly group: HookMatcherGroup; readonly sourceOrder: number; }
export class HookCatalog {
  readonly #entries = new Map<string, HookCatalogEntry>();
  readonly #reviewedHashes = new Map<string, string>();
  #revision = 0;
  register(source: HookSourceDescriptor, configuration: CodexHookConfiguration, enabled = true): void {
    const current = this.#entries.get(source.id); if (current !== undefined && current.source.revision === source.revision) throw new RuntimeFailure('validation', `Duplicate hook source revision: ${source.id}`);
    this.#entries.set(source.id, { source, configuration, enabled }); this.#revision += 1;
  }
  review(sourceId: string, normalizedHash: string): void { const entry = this.#entries.get(sourceId); if (entry === undefined || entry.source.normalizedHash !== normalizedHash) throw new RuntimeFailure('trust', 'Hook review hash does not match current definition'); this.#reviewedHashes.set(sourceId, normalizedHash); this.#revision += 1; }
  setEnabled(sourceId: string, enabled: boolean): void { const entry = this.#entries.get(sourceId); if (entry === undefined) throw new RuntimeFailure('validation', `Unknown hook source: ${sourceId}`); if (entry.source.managed) throw new RuntimeFailure('trust', 'Managed hook enablement is read-only'); this.#entries.set(sourceId, { ...entry, enabled }); this.#revision += 1; }
  effective(workspaceTrusted: boolean, managedOnly: boolean): readonly EffectiveHookGroup[] {
    const entries = [...this.#entries.values()].filter((entry) => entry.enabled && this.#eligible(entry.source, workspaceTrusted, managedOnly)).sort((a, b) => scopeOrder(a.source.scope) - scopeOrder(b.source.scope) || a.source.discoveryOrder - b.source.discoveryOrder || a.source.id.localeCompare(b.source.id));
    const output: EffectiveHookGroup[] = []; for (const [sourceOrder, entry] of entries.entries()) for (const [event, groups] of Object.entries(entry.configuration.hooks)) for (const group of groups ?? []) output.push({ event, source: entry.source, group, sourceOrder }); return output;
  }
  snapshot(): { readonly revision: Revision; readonly entries: readonly { readonly source: HookSourceDescriptor; readonly enabled: boolean; readonly executable: boolean }[] } { return { revision: String(this.#revision) as Revision, entries: [...this.#entries.values()].sort((a, b) => a.source.id.localeCompare(b.source.id)).map((entry) => ({ source: entry.source, enabled: entry.enabled, executable: this.#reviewedHashes.get(entry.source.id) === entry.source.normalizedHash || entry.source.managed })) }; }
  #eligible(source: HookSourceDescriptor, workspaceTrusted: boolean, managedOnly: boolean): boolean { if (managedOnly && !source.managed) return false; if (source.scope === 'workspace' && !workspaceTrusted) return false; if (source.trust === 'denied') return false; return source.managed || (source.trust === 'trusted' && this.#reviewedHashes.get(source.id) === source.normalizedHash); }
}
const scopeOrder = (scope: HookSourceDescriptor['scope']): number => scope === 'managed' ? 0 : scope === 'user' ? 1 : scope === 'workspace' ? 2 : 3;
