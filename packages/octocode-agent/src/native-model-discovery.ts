import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  revision,
  type ApiFamily,
  type ModelDefinition,
  type ModelProviderDefinition,
  type ModelSourceContribution,
  type ModelSourceDescriptor,
} from '@octocodeai/agent-core';
import { workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';
import { repositoryDirectories } from '@octocodeai/octocode-shared/agent-skills';

export interface NativeDiscoveredModelSource {
  readonly descriptor: ModelSourceDescriptor;
  readonly contribution: ModelSourceContribution;
}

export interface NativeModelDiscoveryOptions {
  readonly cwd: string;
  readonly home: string;
  readonly octocodeHome: string;
}

export interface NativeModelRuntimeProviderConfig {
  readonly apiKey?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authHeader: boolean;
  readonly sendSessionAffinityHeaders: boolean;
}

export type NativePiStoredCredential =
  | { readonly type: 'api_key'; readonly key?: string; readonly env: Readonly<Record<string, string>> }
  | { readonly type: 'unsupported'; readonly reason: 'oauth' | 'malformed' };

export interface NativePiModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly sourceId: 'pi.user.settings' | 'pi.workspace.settings';
}

interface SourceCandidate {
  readonly id: string;
  readonly file: string;
  readonly precedence: number;
  readonly scope: 'global' | 'workspace';
  readonly owner: 'octocode-agent' | 'pi';
  readonly kind: 'managed' | 'legacy';
  readonly writable: boolean;
}

const emptyContribution = (): ModelSourceContribution => ({ providers: [], models: [] });
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const MAX_CONFIG_BYTES = 1024 * 1024;

function nearestAncestorFile(cwd: string, relative: readonly string[]): string | undefined {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, ...relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function environmentReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
  return match?.[1] ?? match?.[2];
}

/** Environment names referenced by a Pi-compatible model value, without resolving it. */
export function piModelConfigEnvironmentReferences(configured: string): readonly string[] {
  if (configured.startsWith('!')) return [];
  const references = new Set<string>();
  for (let index = 0; index < configured.length;) {
    if (configured[index] !== '$') { index += 1; continue; }
    const next = configured[index + 1];
    if (next === '$' || next === '!') { index += 2; continue; }
    const braced = configured.slice(index).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    const plain = configured.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
    const match = braced ?? plain;
    if (match === null) { index += 1; continue; }
    references.add(match[1]!);
    index += match[0].length;
  }
  return [...references];
}

export function readNativeModelRuntimeProviderConfig(file: string, providerId: string): NativeModelRuntimeProviderConfig | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const providers = (parsed as Record<string, unknown>)['providers'];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
    const provider = (providers as Record<string, unknown>)[providerId];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return undefined;
    const input = provider as Record<string, unknown>;
    const compat = input['compat'] && typeof input['compat'] === 'object' && !Array.isArray(input['compat'])
      ? input['compat'] as Record<string, unknown>
      : {};
    const headers = input['headers'] && typeof input['headers'] === 'object' && !Array.isArray(input['headers'])
      ? Object.fromEntries(Object.entries(input['headers'] as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    return {
      ...(typeof input['apiKey'] === 'string' ? { apiKey: input['apiKey'] } : {}),
      headers,
      authHeader: input['authHeader'] === true,
      sendSessionAffinityHeaders: compat['sendSessionAffinityHeaders'] === true,
    };
  } catch {
    return undefined;
  }
}

/** Read one exact Pi credential without returning OAuth tokens or other provider entries. */
export function readPiStoredCredential(file: string, providerId: string): NativePiStoredCredential | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const raw = (parsed as Record<string, unknown>)[providerId];
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { type: 'unsupported', reason: 'malformed' };
    const input = raw as Record<string, unknown>;
    if (input['type'] === 'oauth') return { type: 'unsupported', reason: 'oauth' };
    if (input['type'] !== 'api_key') return { type: 'unsupported', reason: 'malformed' };
    const key = input['key'];
    if (key !== undefined && typeof key !== 'string') return { type: 'unsupported', reason: 'malformed' };
    const rawEnv = input['env'];
    if (rawEnv !== undefined && (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)
      || Object.values(rawEnv as Record<string, unknown>).some((value) => typeof value !== 'string'))) {
      return { type: 'unsupported', reason: 'malformed' };
    }
    const env = rawEnv === undefined ? {} : { ...(rawEnv as Record<string, string>) };
    return { type: 'api_key', ...(key === undefined ? {} : { key }), env };
  } catch {
    return undefined;
  }
}

export function resolvePiModelConfigValue(
  configured: string,
  env: NodeJS.ProcessEnv,
  runCommand: (command: string) => string,
): string {
  if (configured.startsWith('!')) return runCommand(configured.slice(1)).trim();
  let resolved = '';
  for (let index = 0; index < configured.length;) {
    if (configured[index] !== '$') {
      resolved += configured[index++];
      continue;
    }
    const next = configured[index + 1];
    if (next === '$') { resolved += '$'; index += 2; continue; }
    if (next === '!') { resolved += '!'; index += 2; continue; }
    const braced = configured.slice(index).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    const plain = configured.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
    const match = braced ?? plain;
    if (match === null) { resolved += '$'; index += 1; continue; }
    const value = env[match[1]!];
    if (value === undefined) throw new Error(`Missing model configuration environment variable: ${match[1]}`);
    resolved += value;
    index += match[0].length;
  }
  return resolved;
}

function apiFamily(value: unknown): ApiFamily {
  if (value === 'openai-responses') return 'responses';
  if (value === 'openai-completions') return 'chat-completions';
  if (value === 'anthropic-messages') return 'anthropic-messages';
  if (value === 'google-generative-ai') return 'google-generative-ai';
  return 'custom';
}

function supportedApi(value: unknown): boolean {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages';
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function modalities(value: unknown): readonly ('text' | 'image' | 'audio')[] {
  if (!Array.isArray(value)) return ['text'];
  const supported = value.filter((item): item is 'text' | 'image' | 'audio' => item === 'text' || item === 'image' || item === 'audio');
  return supported.length > 0 ? [...new Set(supported)] : ['text'];
}

function thinkingLevels(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, mapped]) => typeof mapped === 'string')
    .map(([level]) => level)
    .sort();
}

function promptCaching(value: unknown): { readonly mode: 'auto' | 'enabled' | 'disabled' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'auto' };
  const mode = (value as Record<string, unknown>)['mode'];
  return { mode: mode === 'enabled' || mode === 'disabled' ? mode : 'auto' };
}

function unsupportedSemantics(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  owner: 'provider' | 'model',
): string[] {
  const present = keys.filter((key) => input[key] !== undefined);
  return present.length === 0 ? [] : [`Unsupported Pi ${owner} semantics: ${present.join(', ')}`];
}

function supportedProviderCompat(api: unknown, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const compat = value as Record<string, unknown>;
  if (api === 'anthropic-messages') {
    return Object.entries(compat).every(([key, setting]) => key === 'sendSessionAffinityHeaders' && typeof setting === 'boolean');
  }
  if (api === 'openai-completions' || api === 'openai-responses') {
    return Object.entries(compat).every(([key, setting]) => (
      (key === 'supportsDeveloperRole' || key === 'supportsReasoningEffort')
        ? typeof setting === 'boolean'
        : key === 'maxTokensField' && (setting === 'max_tokens' || setting === 'max_completion_tokens')
    ));
  }
  return false;
}

function parseProvider(
  id: string,
  value: unknown,
  source: SourceCandidate,
): { provider?: ModelProviderDefinition; models: ModelDefinition[]; warned: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { models: [], warned: true };
  const input = value as Record<string, unknown>;
  const configuredModels = Array.isArray(input['models']) ? input['models'] : [];
  const providerApi = input['api'] ?? configuredModels.find((model) => model && typeof model === 'object' && !Array.isArray(model) && typeof (model as Record<string, unknown>)['api'] === 'string')?.api;
  const blockingWarnings = unsupportedSemantics(input, ['oauth', 'modelOverrides'], 'provider');
  const warnings: string[] = [...blockingWarnings];
  if (input['compat'] !== undefined) {
    const compat = input['compat'];
    if (!supportedProviderCompat(providerApi, compat)) {
      const warning = 'Unsupported Pi provider semantics: compat';
      warnings.push(warning);
      blockingWarnings.push(warning);
    }
  }
  let endpoint: string | undefined;
  if (typeof input['baseUrl'] === 'string') {
    try {
      const parsed = new URL(input['baseUrl']);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        const warning = 'Provider baseUrl must not contain credentials, query parameters, or a fragment';
        warnings.push(warning);
        blockingWarnings.push(warning);
      }
      else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') endpoint = input['baseUrl'];
      else {
        const warning = `Unsupported endpoint protocol: ${parsed.protocol}`;
        warnings.push(warning);
        blockingWarnings.push(warning);
      }
    } catch {
      warnings.push('Invalid provider baseUrl');
      blockingWarnings.push('Invalid provider baseUrl');
    }
  } else {
    warnings.push('Missing provider baseUrl');
    blockingWarnings.push('Missing provider baseUrl');
  }
  const supported = supportedApi(providerApi);
  if (!supported) {
    const warning = `Unsupported provider API: ${String(providerApi ?? 'missing')}`;
    warnings.push(warning);
    blockingWarnings.push(warning);
  }
  const credentialName = environmentReference(input['apiKey']);
  const headers: Record<string, { environment: string }> = {};
  if (input['headers'] && typeof input['headers'] === 'object' && !Array.isArray(input['headers'])) {
    for (const [name, headerValue] of Object.entries(input['headers'] as Record<string, unknown>)) {
      const environment = environmentReference(headerValue);
      if (environment !== undefined) headers[name] = { environment };
    }
  }
  const providerEnabled = supported && endpoint !== undefined && blockingWarnings.length === 0;
  const provider: ModelProviderDefinition = {
    id,
    apiFamily: apiFamily(providerApi),
    ...(endpoint === undefined ? {} : { endpoint }),
    enabled: providerEnabled,
    scope: source.scope,
    sourceId: source.id,
    credential: credentialName === undefined ? null : { type: 'environment', name: credentialName },
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    promptCaching: promptCaching(input['promptCaching']),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
  const models: ModelDefinition[] = [];
  for (const rawModel of configuredModels) {
    if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
      warnings.push('Ignored invalid model entry');
      continue;
    }
    const modelInput = rawModel as Record<string, unknown>;
    if (typeof modelInput['id'] !== 'string' || modelInput['id'].trim() === '') {
      warnings.push('Ignored model without an id');
      continue;
    }
    const modelApi = modelInput['api'] ?? providerApi;
    const modelWarnings = unsupportedSemantics(
      modelInput,
      ['baseUrl', 'headers', 'compat', 'samplingParams'],
      'model',
    );
    if (!supportedApi(modelApi)) modelWarnings.push(`Unsupported model API: ${String(modelApi ?? 'missing')}`);
    if (modelApi !== providerApi) modelWarnings.push('Per-model API override cannot use the provider transport');
    const enabled = providerEnabled && modelWarnings.length === 0;
    const cost = modelInput['cost'] && typeof modelInput['cost'] === 'object' && !Array.isArray(modelInput['cost'])
      ? modelInput['cost'] as Record<string, unknown>
      : undefined;
    models.push({
      providerId: id,
      id: modelInput['id'],
      displayName: typeof modelInput['name'] === 'string' ? modelInput['name'] : modelInput['id'],
      enabled,
      limits: { context: positiveInteger(modelInput['contextWindow']), output: positiveInteger(modelInput['maxTokens']) },
      modalities: modalities(modelInput['input']),
      tools: enabled ? 'supported' : 'unknown',
      thinking: {
        supported: enabled && typeof modelInput['reasoning'] === 'boolean' ? modelInput['reasoning'] : null,
        levels: enabled ? thinkingLevels(modelInput['thinkingLevelMap']) : [],
      },
      cost: cost === undefined ? null : {
        currency: 'USD',
        inputPerMillion: typeof cost['input'] === 'number' && Number.isFinite(cost['input']) ? cost['input'] : null,
        outputPerMillion: typeof cost['output'] === 'number' && Number.isFinite(cost['output']) ? cost['output'] : null,
        cacheReadPerMillion: typeof cost['cacheRead'] === 'number' && Number.isFinite(cost['cacheRead']) ? cost['cacheRead'] : null,
        cacheWritePerMillion: typeof cost['cacheWrite'] === 'number' && Number.isFinite(cost['cacheWrite']) ? cost['cacheWrite'] : null,
      },
      sourceId: source.id,
      scope: source.scope,
      warnings: modelWarnings.length > 0 ? modelWarnings : warnings.filter((warning) => warning.startsWith('Unsupported provider API')),
    });
  }
  return { provider, models, warned: warnings.length > 0 };
}

function loadSource(source: SourceCandidate): NativeDiscoveredModelSource {
  let content: string;
  try {
    const stat = fs.lstatSync(source.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('unsafe model source');
    content = fs.readFileSync(source.file, 'utf8');
  } catch {
    return {
      descriptor: {
        id: source.id, kind: source.kind, scope: source.scope, precedence: source.precedence,
        writable: source.writable, revision: revision('unreadable'), path: source.file,
        owner: source.owner, parseState: 'invalid', redaction: 'sensitive',
      },
      contribution: emptyContribution(),
    };
  }
  const descriptorBase = {
    id: source.id,
    kind: source.kind,
    scope: source.scope,
    precedence: source.precedence,
    writable: source.writable,
    revision: revision(hash(content)),
    path: source.file,
    owner: source.owner,
    redaction: 'sensitive' as const,
  };
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root');
    const providersValue = (parsed as Record<string, unknown>)['providers'];
    if (!providersValue || typeof providersValue !== 'object' || Array.isArray(providersValue)) throw new Error('providers');
    const providers: ModelProviderDefinition[] = [];
    const models: ModelDefinition[] = [];
    let warned = false;
    for (const [id, value] of Object.entries(providersValue as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      const result = parseProvider(id, value, source);
      if (result.provider !== undefined) providers.push(result.provider);
      models.push(...result.models);
      warned ||= result.warned;
    }
    return {
      descriptor: { ...descriptorBase, parseState: warned ? 'warning' : 'valid' },
      contribution: { providers, models },
    };
  } catch {
    return { descriptor: { ...descriptorBase, parseState: 'invalid' }, contribution: emptyContribution() };
  }
}

export function discoverNativeModelSources(options: NativeModelDiscoveryOptions): readonly NativeDiscoveredModelSource[] {
  const piWorkspace = nearestAncestorFile(options.cwd, ['.pi', 'models.json']);
  const repository = repositoryDirectories(options.cwd)[0] ?? path.resolve(options.cwd);
  const nativeWorkspace = path.join(workspaceAgentRoot(repository, options.octocodeHome), 'models.json');
  const candidates: Array<SourceCandidate | undefined> = [
    { id: 'pi.user', file: path.join(options.home, '.pi', 'agent', 'models.json'), precedence: 20, scope: 'global', owner: 'pi', kind: 'legacy', writable: false },
    { id: 'native.global', file: path.join(options.octocodeHome, 'agent', 'models.json'), precedence: 30, scope: 'global', owner: 'octocode-agent', kind: 'managed', writable: true },
    piWorkspace === undefined ? undefined : { id: 'pi.workspace', file: piWorkspace, precedence: 40, scope: 'workspace', owner: 'pi', kind: 'legacy', writable: false },
    { id: 'native.workspace', file: nativeWorkspace, precedence: 50, scope: 'workspace', owner: 'octocode-agent', kind: 'managed', writable: true },
  ];
  return candidates
    .filter((candidate): candidate is SourceCandidate => candidate !== undefined && fs.existsSync(candidate.file))
    .map(loadSource);
}

function readPiModelSelection(file: string, sourceId: NativePiModelSelection['sourceId']): NativePiModelSelection | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const input = parsed as Record<string, unknown>;
    const providerId = input['defaultProvider'];
    const modelId = input['defaultModel'];
    if (typeof providerId !== 'string' || !providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) return undefined;
    return { providerId, modelId, sourceId };
  } catch {
    return undefined;
  }
}

/** Pi-compatible selected model, with trusted workspace settings overriding global settings. */
export function discoverPiModelSelection(
  options: NativeModelDiscoveryOptions & { readonly workspaceTrusted?: boolean },
): NativePiModelSelection | undefined {
  const global = readPiModelSelection(path.join(options.home, '.pi', 'agent', 'settings.json'), 'pi.user.settings');
  if (options.workspaceTrusted === false) return global;
  const workspace = nearestAncestorFile(options.cwd, ['.pi', 'settings.json']);
  return workspace === undefined ? global : readPiModelSelection(workspace, 'pi.workspace.settings') ?? global;
}
