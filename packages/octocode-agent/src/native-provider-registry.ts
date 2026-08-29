import {
  ModelCatalog,
  RuntimeFailure,
  revision,
  type ApiFamily,
  type ModelCatalogSnapshot,
  type ModelDefinition,
  type ModelPort,
  type ModelProviderDefinition,
  type ModelSourceContribution,
  type ModelSourceDescriptor,
} from '@octocodeai/agent-core';
import { createAnthropicMessagesModelPort, type AnthropicMessagesModelOptions } from './native-anthropic-messages-model.js';
import { createOpenAiCompatibleModelPort, type OpenAiCompatibleModelOptions } from './native-model.js';

export type NativeProviderProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

export type NativeProviderModelOptions =
  | ({ readonly protocol: 'anthropic-messages' } & AnthropicMessagesModelOptions)
  | ({ readonly protocol: 'openai-chat-completions' | 'openai-responses' } & OpenAiCompatibleModelOptions);

export function supportedNativeProviderProtocols(): readonly NativeProviderProtocol[] {
  return ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];
}

export function resolveNativeProviderProtocol(input: { readonly endpoint: string; readonly requested?: string }): NativeProviderProtocol {
  if (input.requested === 'anthropic-messages' || input.requested === 'openai-chat-completions' || input.requested === 'openai-responses') return input.requested;
  if (input.requested !== undefined && input.requested !== '') throw new RuntimeFailure('validation', `Unsupported native model protocol: ${input.requested}`);
  const hostname = new URL(input.endpoint).hostname;
  return hostname === 'api.openai.com' ? 'openai-responses' : 'openai-chat-completions';
}

export function createNativeProviderModelPort(options: NativeProviderModelOptions): ModelPort {
  switch (options.protocol) {
    case 'anthropic-messages': return createAnthropicMessagesModelPort(options);
    case 'openai-chat-completions':
    case 'openai-responses': return createOpenAiCompatibleModelPort(options);
  }
}

const CANONICAL_SOURCE_ID = 'native.canonical';
const SETTINGS_SOURCE_ID = 'native.settings';
const ENVIRONMENT_SOURCE_ID = 'native.environment';

const providerDefaults = {
  openai: {
    protocol: 'openai-responses',
    endpoint: 'https://api.openai.com/v1',
    modelId: 'gpt-5',
    credential: 'OPENAI_API_KEY',
  },
  anthropic: {
    protocol: 'anthropic-messages',
    endpoint: 'https://api.anthropic.com/v1',
    modelId: 'claude-sonnet-4-5',
    credential: 'ANTHROPIC_API_KEY',
  },
} as const;
type NativeProviderId = keyof typeof providerDefaults;

export interface NativeModelConfiguration {
  readonly catalog: ModelCatalogSnapshot;
  readonly selection: { readonly providerId: NativeProviderId; readonly modelId: string };
  readonly endpoint: string;
  readonly protocol: NativeProviderProtocol;
}

function providerIdForProtocol(protocol: NativeProviderProtocol): NativeProviderId {
  return protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function apiFamily(protocol: NativeProviderProtocol): ApiFamily {
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  return protocol === 'openai-responses' ? 'responses' : 'chat-completions';
}

function descriptor(id: string, kind: ModelSourceDescriptor['kind'], precedence: number): ModelSourceDescriptor {
  return {
    id,
    kind,
    scope: 'global',
    precedence,
    writable: kind === 'runtime',
    revision: revision('1'),
    owner: 'octocode-agent',
    parseState: 'valid',
    redaction: 'public',
  };
}

function provider(input: {
  readonly id: NativeProviderId;
  readonly sourceId: string;
  readonly protocol: NativeProviderProtocol;
  readonly endpoint: string;
}): ModelProviderDefinition {
  return {
    id: input.id,
    apiFamily: apiFamily(input.protocol),
    endpoint: input.endpoint,
    enabled: true,
    scope: 'global',
    sourceId: input.sourceId,
    credential: { type: 'environment', name: providerDefaults[input.id].credential },
  };
}

function model(providerId: NativeProviderId, modelId: string, sourceId: string): ModelDefinition {
  return {
    providerId,
    id: modelId,
    displayName: modelId,
    enabled: true,
    limits: { context: null, output: null },
    modalities: ['text'],
    tools: 'supported',
    thinking: { supported: null, levels: [] },
    cost: null,
    sourceId,
    scope: 'global',
    warnings: [],
  };
}

function contribution(
  providerId: NativeProviderId,
  modelId: string,
  sourceId: string,
  protocol: NativeProviderProtocol,
  endpoint: string,
): ModelSourceContribution {
  return {
    providers: [provider({ id: providerId, sourceId, protocol, endpoint })],
    models: [model(providerId, modelId, sourceId)],
  };
}

export function resolveNativeModelConfiguration(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly configuredProvider?: string;
  readonly configuredModel?: string;
}): NativeModelConfiguration {
  if (input.configuredProvider !== undefined && input.configuredProvider !== 'openai' && input.configuredProvider !== 'anthropic') {
    throw new RuntimeFailure('validation', `Unsupported configured model provider: ${input.configuredProvider}`);
  }
  const configuredProvider = input.configuredProvider as NativeProviderId | undefined;
  const hasEnvironmentProvider = input.env.OCTOCODE_MODEL_PROTOCOL !== undefined || input.env.OCTOCODE_MODEL_ENDPOINT !== undefined;
  const requestedProtocol = input.env.OCTOCODE_MODEL_PROTOCOL
    ?? (!hasEnvironmentProvider && configuredProvider === 'anthropic' ? 'anthropic-messages' : undefined);
  const endpoint = input.env.OCTOCODE_MODEL_ENDPOINT
    ?? (requestedProtocol === 'anthropic-messages' ? providerDefaults.anthropic.endpoint : providerDefaults.openai.endpoint);
  const protocol = resolveNativeProviderProtocol({ endpoint, requested: requestedProtocol });
  const providerId = providerIdForProtocol(protocol);
  const matchingConfiguredModel = configuredProvider === undefined || configuredProvider === providerId
    ? input.configuredModel
    : undefined;
  const modelId = input.env.OCTOCODE_MODEL ?? matchingConfiguredModel ?? providerDefaults[providerId].modelId;
  const catalog = new ModelCatalog();

  catalog.replaceSource(descriptor(CANONICAL_SOURCE_ID, 'canonical', 10), {
    providers: [
      provider({ id: 'openai', sourceId: CANONICAL_SOURCE_ID, protocol: 'openai-responses', endpoint: providerDefaults.openai.endpoint }),
      provider({ id: 'anthropic', sourceId: CANONICAL_SOURCE_ID, protocol: 'anthropic-messages', endpoint: providerDefaults.anthropic.endpoint }),
    ],
    models: [
      model('openai', providerDefaults.openai.modelId, CANONICAL_SOURCE_ID),
      model('anthropic', providerDefaults.anthropic.modelId, CANONICAL_SOURCE_ID),
    ],
  });
  if (input.configuredModel !== undefined) {
    const settingsProvider = configuredProvider ?? providerId;
    const defaults = providerDefaults[settingsProvider];
    catalog.replaceSource(
      descriptor(SETTINGS_SOURCE_ID, 'canonical', 20),
      contribution(settingsProvider, input.configuredModel, SETTINGS_SOURCE_ID, defaults.protocol, defaults.endpoint),
    );
  }
  if (input.env.OCTOCODE_MODEL !== undefined || hasEnvironmentProvider) {
    catalog.replaceSource(
      descriptor(ENVIRONMENT_SOURCE_ID, 'runtime', 30),
      contribution(providerId, modelId, ENVIRONMENT_SOURCE_ID, protocol, endpoint),
    );
  }
  catalog.selectDefault(providerId, modelId);
  return { catalog: catalog.snapshot(), selection: { providerId, modelId }, endpoint, protocol };
}
