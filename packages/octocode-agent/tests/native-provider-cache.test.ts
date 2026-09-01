import { describe, expect, it } from 'vitest';
import { resolveNativeProviderCachePolicy } from '../src/native-provider-cache.js';

const base = {
  promptHash: 'a'.repeat(64),
  sessionId: 'session-1',
  sendSessionAffinityHeaders: false,
} as const;

describe('native provider cache policy', () => {
  it('enables automatic caching only for known official provider hosts', () => {
    expect(resolveNativeProviderCachePolicy({ ...base, protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', mode: 'auto' })).toMatchObject({ enabled: true, support: 'official', anthropicTtl: '5m' });
    expect(resolveNativeProviderCachePolicy({ ...base, protocol: 'anthropic-messages', endpoint: 'https://proxy.example/anthropic', mode: 'auto' })).toMatchObject({ enabled: false, support: 'unknown' });
    expect(resolveNativeProviderCachePolicy({ ...base, protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', mode: 'auto' })).toMatchObject({ enabled: true, support: 'official', promptCacheKey: `octocode:${'a'.repeat(55)}` });
  });

  it('allows an explicit compatible-provider declaration and preserves cache options', () => {
    expect(resolveNativeProviderCachePolicy({
      ...base,
      protocol: 'anthropic-messages',
      endpoint: 'https://proxy.example/anthropic',
      mode: 'enabled',
      anthropicTtl: '1h',
      sendSessionAffinityHeaders: true,
    })).toEqual({
      enabled: true,
      mode: 'enabled',
      protocol: 'anthropic-messages',
      support: 'declared',
      anthropicTtl: '1h',
      sessionAffinityId: 'session-1',
    });
  });

  it('makes disabled authoritative even on official hosts', () => {
    expect(resolveNativeProviderCachePolicy({ ...base, protocol: 'openai-chat-completions', endpoint: 'https://api.openai.com/v1', mode: 'disabled' })).toMatchObject({ enabled: false, support: 'disabled' });
  });
});
