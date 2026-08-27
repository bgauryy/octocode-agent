import { RuntimeFailure } from '../contracts/errors.js';
import { revision } from '../contracts/identity.js';
import type { ModelCatalogSnapshot, ModelSourceContribution, ModelSourceDescriptor } from '../contracts/models.js';
export class ModelCatalog {
  readonly #sources = new Map<string, { descriptor: ModelSourceDescriptor; contribution: ModelSourceContribution }>();
  #default: { providerId: string; modelId: string } | null = null;
  #revision = 0;
  replaceSource(descriptor: ModelSourceDescriptor, contribution: ModelSourceContribution): void { validateContribution(contribution); this.#sources.set(descriptor.id, { descriptor, contribution }); this.#revision += 1; if (this.#default !== null) this.#assertModel(this.#default.providerId, this.#default.modelId); }
  removeSource(id: string): void { this.#sources.delete(id); this.#revision += 1; }
  selectDefault(providerId: string, modelId: string): void { this.#assertModel(providerId, modelId); this.#default = { providerId, modelId }; this.#revision += 1; }
  snapshot(): ModelCatalogSnapshot {
    const sources = [...this.#sources.values()].sort((a, b) => b.descriptor.precedence - a.descriptor.precedence || a.descriptor.id.localeCompare(b.descriptor.id));
    const providers = new Map<string, ModelSourceContribution['providers'][number]>(); const models = new Map<string, ModelSourceContribution['models'][number]>();
    for (const source of sources) { for (const provider of source.contribution.providers) if (!providers.has(provider.id)) providers.set(provider.id, provider); for (const model of source.contribution.models) { const key = `${model.providerId}:${model.id}`; if (!models.has(key)) models.set(key, model); } }
    return { schemaVersion: 1, revision: revision(String(this.#revision)), providers: [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)), models: [...models.values()].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id)), sources: sources.map(({ descriptor }) => descriptor), defaultModel: this.#default, refreshState: 'ready', revisionVector: Object.fromEntries(sources.map(({ descriptor }) => [descriptor.id, descriptor.revision])) };
  }
  #assertModel(providerId: string, modelId: string): void { const snapshot = this.snapshot(); if (!snapshot.providers.some(({ id, enabled }) => id === providerId && enabled) || !snapshot.models.some(({ providerId: p, id, enabled }) => p === providerId && id === modelId && enabled)) throw new RuntimeFailure('model', `Unknown model: ${providerId}/${modelId}`); }
}
const validateContribution = (contribution: ModelSourceContribution): void => { for (const provider of contribution.providers) { if (provider.endpoint !== undefined) { const protocol = new URL(provider.endpoint).protocol; if (protocol !== 'https:' && protocol !== 'http:') throw new RuntimeFailure('validation', `Unsupported endpoint protocol: ${protocol}`); } } for (const model of contribution.models) if ((model.limits.context !== null && model.limits.context <= 0) || (model.limits.output !== null && model.limits.output <= 0)) throw new RuntimeFailure('validation', 'Model limits must be positive or null'); };
