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
import {
  createAnthropicMessagesModelPort,
  createOpenAiCompatibleModelPort,
  type AnthropicMessagesModelOptions,
  type OpenAiCompatibleModelOptions,
} from './native-model.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  discoverNativeModelSources,
  discoverPiModelSelection,
  piModelConfigEnvironmentReferences,
  readNativeModelRuntimeProviderConfig,
  readPiStoredCredential,
  resolvePiModelConfigValue,
} from './native-model-discovery.js';

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
  readonly selection: { readonly providerId: string; readonly modelId: string };
  readonly selectionSource: 'cli.override' | 'native.settings' | 'worker.capabilities' | 'pi.user.settings' | 'pi.workspace.settings' | 'canonical';
  readonly endpoint: string;
  readonly protocol: NativeProviderProtocol;
  readonly promptCaching: 'auto' | 'enabled' | 'disabled';
  readonly sendSessionAffinityHeaders: boolean;
  readonly maxOutputTokens?: number;
  readonly credential: NativeModelCredentialReadiness;
  readonly credentialEnv?: string;
  readonly resolveRuntimeAuth?: () => { readonly apiKey?: string; readonly headers: Readonly<Record<string, string>> };
}

export interface NativeModelCredentialReadiness {
  readonly providerId: string;
  readonly configured: boolean;
  readonly source: 'environment' | 'command' | 'literal' | 'headers' | 'none' | 'unsupported';
  readonly verification: 'discovery' | 'request-time';
  readonly environmentVariables: readonly string[];
  readonly missingEnvironmentVariables: readonly string[];
}

function environmentConfigured(env: NodeJS.ProcessEnv, name: string): boolean {
  return typeof env[name] === 'string' && env[name]!.trim().length > 0;
}

function modelCredentialReadiness(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly providerId: string;
  readonly protocol: NativeProviderProtocol;
  readonly credentialEnv?: string;
  readonly runtimeProvider?: ReturnType<typeof readNativeModelRuntimeProviderConfig>;
  readonly piCredential?: ReturnType<typeof readPiStoredCredential>;
}): NativeModelCredentialReadiness {
  const runtimeProvider = input.runtimeProvider;
  if (input.piCredential?.type === 'unsupported') {
    return {
      providerId: input.providerId,
      configured: false,
      source: 'unsupported',
      verification: 'discovery',
      environmentVariables: [],
      missingEnvironmentVariables: [],
    };
  }
  if (runtimeProvider !== undefined) {
    const configuredApiKey = input.piCredential?.type === 'api_key'
      ? input.piCredential.key
      : runtimeProvider.apiKey;
    const credentialEnv = input.piCredential?.type === 'api_key'
      ? { ...input.env, ...input.piCredential.env }
      : input.env;
    const configuredValues = [
      ...(configuredApiKey === undefined ? [] : [configuredApiKey]),
      ...Object.values(runtimeProvider.headers),
    ];
    const environmentVariables = [...new Set(configuredValues.flatMap((value) => piModelConfigEnvironmentReferences(value)))];
    const missingEnvironmentVariables = environmentVariables.filter((name) => !environmentConfigured(credentialEnv, name));
    if (environmentVariables.length > 0) {
      return {
        providerId: input.providerId,
        configured: missingEnvironmentVariables.length === 0,
        source: 'environment',
        verification: 'discovery',
        environmentVariables,
        missingEnvironmentVariables,
      };
    }
    if (configuredValues.some((value) => value.startsWith('!'))) {
      return {
        providerId: input.providerId,
        configured: true,
        source: 'command',
        verification: 'request-time',
        environmentVariables: [],
        missingEnvironmentVariables: [],
      };
    }
    if (configuredApiKey !== undefined && configuredApiKey.length > 0) {
      return {
        providerId: input.providerId,
        configured: true,
        source: 'literal',
        verification: 'discovery',
        environmentVariables: [],
        missingEnvironmentVariables: [],
      };
    }
    if (Object.keys(runtimeProvider.headers).length > 0) {
      return {
        providerId: input.providerId,
        configured: true,
        source: 'headers',
        verification: 'discovery',
        environmentVariables: [],
        missingEnvironmentVariables: [],
      };
    }
    return {
      providerId: input.providerId,
      configured: true,
      source: 'none',
      verification: 'discovery',
      environmentVariables: [],
      missingEnvironmentVariables: [],
    };
  }

  const protocolDefault = input.protocol === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const environmentVariables = [...new Set([
    ...(input.credentialEnv === undefined ? [] : [input.credentialEnv]),
    'OCTOCODE_MODEL_API_KEY',
    protocolDefault,
  ])];
  const configured = environmentVariables.some((name) => environmentConfigured(input.env, name));
  return {
    providerId: input.providerId,
    configured,
    source: 'environment',
    verification: 'discovery',
    environmentVariables,
    missingEnvironmentVariables: configured ? [] : environmentVariables,
  };
}

function runPiCredentialCommand(command: string): string {
  const shell = process.platform === 'win32' ? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  try {
    return execFileSync(shell, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new RuntimeFailure('provider', 'Model credential command failed', 'unsafe', true, 'public', 'operation', 'credentials');
  }
}

function apiFamily(protocol: NativeProviderProtocol): ApiFamily {
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  return protocol === 'openai-responses' ? 'responses' : 'chat-completions';
}

function protocolForApiFamily(family: ApiFamily): NativeProviderProtocol | undefined {
  if (family === 'responses') return 'openai-responses';
  if (family === 'chat-completions') return 'openai-chat-completions';
  if (family === 'anthropic-messages') return 'anthropic-messages';
  return undefined;
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
  readonly configuredSelectionSource?: 'cli.override' | 'native.settings' | 'worker.capabilities';
  readonly forceConfiguredSelection?: boolean;
  readonly cwd?: string;
  readonly home?: string;
  readonly octocodeHome?: string;
  readonly workspaceTrusted?: boolean;
}): NativeModelConfiguration {
  const nativeSelectionConfigured = input.configuredProvider !== undefined || input.configuredModel !== undefined;
  let configuredProvider = input.configuredProvider;
  const catalog = new ModelCatalog();
  const discoveredSources = input.cwd !== undefined && input.home !== undefined && input.octocodeHome !== undefined
    ? discoverNativeModelSources({ cwd: input.cwd, home: input.home, octocodeHome: input.octocodeHome })
    : [];
  const discoveredPiSelection = !nativeSelectionConfigured && input.cwd !== undefined && input.home !== undefined && input.octocodeHome !== undefined
    ? discoverPiModelSelection({ cwd: input.cwd, home: input.home, octocodeHome: input.octocodeHome, workspaceTrusted: input.workspaceTrusted })
    : undefined;
  let settingsOriginSourceId: string | undefined;

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

  if (discoveredSources.length > 0) {
    for (const source of discoveredSources) {
      const blocked = source.descriptor.scope === 'workspace' && input.workspaceTrusted === false;
      catalog.replaceSource(
        blocked ? { ...source.descriptor, parseState: 'warning' } : source.descriptor,
        blocked ? {
          ...source.contribution,
          providers: source.contribution.providers.map((provider) => ({ ...provider, enabled: false, warnings: [...(provider.warnings ?? []), 'Workspace model source is blocked until the workspace is trusted'] })),
          models: source.contribution.models.map((entry) => ({ ...entry, enabled: false, warnings: [...entry.warnings, 'Workspace model source is blocked until the workspace is trusted'] })),
        } : source.contribution,
      );
    }
  }

  let piSelection = discoveredPiSelection;
  if (piSelection !== undefined) {
    const discovered = catalog.snapshot();
    const providerAvailable = discovered.providers.some(({ id, enabled }) => id === piSelection!.providerId && enabled);
    const modelAvailable = discovered.models.some(({ providerId, id, enabled }) => providerId === piSelection!.providerId && id === piSelection!.modelId && enabled);
    if (!providerAvailable || !modelAvailable) {
      const piSourceIds = new Set(discoveredSources
        .filter(({ descriptor: source }) => source.owner === 'pi')
        .map(({ descriptor: source }) => source.id));
      const matchingModels = discovered.models.filter(({ sourceId, id, enabled }) => (
        piSourceIds.has(sourceId) && id === piSelection!.modelId && enabled
      ));
      const resolvedProviders = [...new Set(matchingModels
        .map(({ providerId }) => providerId)
        .filter((providerId) => discovered.providers.some(({ id, enabled }) => id === providerId && enabled)))];
      piSelection = resolvedProviders.length === 1
        ? { ...piSelection, providerId: resolvedProviders[0]! }
        : undefined;
    }
    if (piSelection !== undefined) configuredProvider = piSelection.providerId;
  }

  if (input.configuredModel !== undefined) {
    const settingsProvider = configuredProvider ?? 'openai';
    const beforeSettings = catalog.snapshot();
    const existingProvider = beforeSettings.providers.find(({ id }) => id === settingsProvider);
    const existingModel = beforeSettings.models.find(({ providerId, id }) => providerId === settingsProvider && id === input.configuredModel);
    if (existingProvider !== undefined && existingModel !== undefined) {
      settingsOriginSourceId = existingProvider.sourceId;
      catalog.replaceSource(descriptor(SETTINGS_SOURCE_ID, 'managed', 60), {
        providers: [{ ...existingProvider, sourceId: SETTINGS_SOURCE_ID }],
        models: [{ ...existingModel, sourceId: SETTINGS_SOURCE_ID }],
      });
    } else if (settingsProvider === 'openai' || settingsProvider === 'anthropic') {
      const defaults = providerDefaults[settingsProvider];
      catalog.replaceSource(
        descriptor(SETTINGS_SOURCE_ID, 'managed', 60),
        contribution(settingsProvider, input.configuredModel, SETTINGS_SOURCE_ID, defaults.protocol, defaults.endpoint),
      );
    }
  }
  const providerId = configuredProvider ?? piSelection?.providerId ?? 'openai';
  const modelId = input.configuredModel
    ?? piSelection?.modelId
    ?? (providerId === 'anthropic' ? providerDefaults.anthropic.modelId : providerDefaults.openai.modelId);
  catalog.selectDefault(providerId, modelId);
  const snapshot = catalog.snapshot();
  const selectedProvider = snapshot.providers.find(({ id }) => id === providerId)!;
  const selectedModel = snapshot.models.find((entry) => entry.providerId === providerId && entry.id === modelId)!;
  const protocol = protocolForApiFamily(selectedProvider.apiFamily);
  if (protocol === undefined) throw new RuntimeFailure('validation', `Unsupported configured model provider API: ${selectedProvider.apiFamily}`);
  if (selectedProvider.endpoint === undefined) throw new RuntimeFailure('validation', `Configured model provider has no endpoint: ${providerId}`);
  const runtimeSourceId = selectedProvider.sourceId === SETTINGS_SOURCE_ID ? settingsOriginSourceId : selectedProvider.sourceId;
  const runtimeSource = discoveredSources.find(({ descriptor: source }) => source.id === runtimeSourceId);
  const runtimeProvider = runtimeSource?.descriptor.path === undefined
    ? undefined
    : readNativeModelRuntimeProviderConfig(runtimeSource.descriptor.path, providerId);
  const piAuthFile = input.home === undefined ? undefined : path.join(input.home, '.pi', 'agent', 'auth.json');
  const exactPiCredential = runtimeSource?.descriptor.owner === 'pi' && piAuthFile !== undefined
    ? readPiStoredCredential(piAuthFile, providerId)
    : undefined;
  const discoveredPiProviderId = discoveredPiSelection?.providerId;
  const piSelectionCredential = runtimeSource?.descriptor.owner === 'pi'
    && piAuthFile !== undefined
    && piSelection?.providerId === providerId
    && discoveredPiProviderId !== undefined
    && discoveredPiProviderId !== providerId
    ? readPiStoredCredential(piAuthFile, discoveredPiProviderId)
    : undefined;
  const piCredential = exactPiCredential ?? piSelectionCredential;
  const credentialEnv = selectedProvider.credential?.type === 'environment' ? selectedProvider.credential.name : undefined;
  return {
    catalog: snapshot,
    selection: { providerId, modelId },
    selectionSource: nativeSelectionConfigured
      ? input.configuredSelectionSource ?? 'native.settings'
      : piSelection?.sourceId ?? 'canonical',
    endpoint: selectedProvider.endpoint,
    protocol,
    promptCaching: selectedProvider.promptCaching?.mode ?? 'auto',
    sendSessionAffinityHeaders: runtimeProvider?.sendSessionAffinityHeaders === true,
    ...(selectedModel.limits.output === null ? {} : { maxOutputTokens: selectedModel.limits.output }),
    credential: modelCredentialReadiness({ env: input.env, providerId, protocol, credentialEnv, runtimeProvider, piCredential }),
    ...(credentialEnv === undefined ? {} : { credentialEnv }),
    ...(runtimeProvider === undefined ? {} : {
      resolveRuntimeAuth: () => {
        if (piCredential?.type === 'unsupported') {
          throw new RuntimeFailure(
            'provider',
            piCredential.reason === 'oauth'
              ? 'Pi OAuth credentials are unsupported by the native provider runtime'
              : 'The selected Pi credential is malformed and cannot be used by the native provider runtime',
            'unsafe', true, 'public', 'operation', 'credentials',
          );
        }
        const configuredApiKey = piCredential?.type === 'api_key' ? piCredential.key : runtimeProvider.apiKey;
        const credentialValues = piCredential?.type === 'api_key'
          ? { ...input.env, ...piCredential.env }
          : input.env;
        const apiKey = configuredApiKey === undefined
          ? undefined
          : resolvePiModelConfigValue(configuredApiKey, credentialValues, runPiCredentialCommand);
        const headers = Object.fromEntries(Object.entries(runtimeProvider.headers).map(([name, value]) => [
          name,
          resolvePiModelConfigValue(value, credentialValues, runPiCredentialCommand),
        ]));
        if (runtimeProvider.authHeader && apiKey !== undefined && headers['Authorization'] === undefined) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        return { ...(apiKey === undefined ? {} : { apiKey }), headers };
      },
    }),
  };
}
