import type { NativeProviderProtocol } from './native-provider-registry.js';

export interface NativeProviderCachePolicy {
  readonly enabled: boolean;
  readonly mode: 'auto' | 'enabled' | 'disabled';
  readonly protocol: NativeProviderProtocol;
  readonly support: 'official' | 'declared' | 'disabled' | 'unknown';
  readonly promptCacheKey?: string;
  readonly anthropicTtl?: '5m' | '1h';
  readonly sessionAffinityId?: string;
}

const OFFICIAL_CACHE_HOSTS: Readonly<Partial<Record<NativeProviderProtocol, ReadonlySet<string>>>> = Object.freeze({
  'openai-chat-completions': new Set(['api.openai.com']),
  'openai-responses': new Set(['api.openai.com']),
  'anthropic-messages': new Set(['api.anthropic.com']),
});

export function resolveNativeProviderCachePolicy(input: {
  readonly protocol: NativeProviderProtocol;
  readonly endpoint: string;
  readonly mode: 'auto' | 'enabled' | 'disabled';
  readonly promptHash: string;
  readonly sessionId: string;
  readonly sendSessionAffinityHeaders: boolean;
  readonly anthropicTtl?: '5m' | '1h';
}): NativeProviderCachePolicy {
  const hostname = new URL(input.endpoint).hostname.toLowerCase();
  const official = OFFICIAL_CACHE_HOSTS[input.protocol]?.has(hostname) === true;
  const enabled = input.mode === 'enabled' || (input.mode === 'auto' && official);
  const support = !enabled
    ? input.mode === 'disabled' ? 'disabled' : 'unknown'
    : official ? 'official' : 'declared';
  return Object.freeze({
    enabled,
    mode: input.mode,
    protocol: input.protocol,
    support,
    ...(enabled && input.protocol !== 'anthropic-messages'
      ? { promptCacheKey: `octocode:${input.promptHash.slice(0, 55)}` }
      : {}),
    ...(enabled && input.protocol === 'anthropic-messages'
      ? { anthropicTtl: input.anthropicTtl ?? '5m' }
      : {}),
    ...(input.sendSessionAffinityHeaders ? { sessionAffinityId: input.sessionId } : {}),
  });
}
