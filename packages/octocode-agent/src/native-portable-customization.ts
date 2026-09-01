import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type {
  AgentPortableContributionSetV1,
  AgentPortableCustomizationFactoryContextV1,
  AgentPortableCustomizationFactoryV1,
  JsonValueV1,
  ProductPolicyOverlayV1,
} from './api/v1.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGRITY = /^sha256-([a-f0-9]{64})$/u;
const MAX_MODULE_BYTES = 1_048_576;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_WORKER_CONTRIBUTIONS = 256;
const EVENT_TYPES = new Set([
  'session.starting', 'session.stopping', 'input.received', 'tool.requested',
  'permission.requested', 'tool.ended', 'context.compaction-started',
  'context.compacted', 'worker.started', 'worker.stopped', 'agent.ended',
]);

export type NativePortableContributionSelectorV1 =
  | `tool:${string}`
  | `hook:${string}`
  | `event:${string}`
  | 'compaction';

export interface NativePortableCustomizationEntrypointV1 {
  readonly kind: 'module';
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly integrity: `sha256-${string}`;
}

export interface NativePortableCustomizationDescriptorV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly entrypoint: NativePortableCustomizationEntrypointV1;
  readonly config?: JsonValueV1;
  readonly workerContributions: readonly NativePortableContributionSelectorV1[];
}

export interface NativeResolvedPortableCustomizationDescriptorV1
  extends NativePortableCustomizationDescriptorV1 {
  readonly manifestSha256: string;
}

export type NativePortableContributionSetV1 = AgentPortableContributionSetV1;

export interface NativePortableCustomizationManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly productPolicyOverlay?: ProductPolicyOverlayV1;
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  readonly hooks?: readonly Readonly<Record<string, unknown>>[];
  readonly events?: readonly Readonly<Record<string, unknown>>[];
  readonly compaction?: Readonly<Record<string, unknown>>;
}

export interface NativePortableCustomizationResolutionV1 {
  readonly descriptor: NativeResolvedPortableCustomizationDescriptorV1;
  readonly manifest: NativePortableCustomizationManifestV1;
  readonly customization: NativePortableContributionSetV1;
}

export type NativePortableCustomizationFactoryContextV1 = AgentPortableCustomizationFactoryContextV1;
export type NativePortableCustomizationFactoryV1 = AgentPortableCustomizationFactoryV1;

export function parseNativePortableCustomizationDescriptorV1(
  input: unknown,
): NativePortableCustomizationDescriptorV1 {
  const value = record(input, 'portable customization descriptor');
  closed(value, ['schemaVersion', 'id', 'entrypoint', 'config', 'workerContributions'], 'portable customization descriptor');
  if (value['schemaVersion'] !== 1) throw new TypeError('Portable customization version is unsupported');
  const id = identifier(value['id'], 'portable customization id');
  const entrypoint = parseEntrypoint(value['entrypoint']);
  const config = value['config'] === undefined
    ? undefined
    : cloneJson(value['config'], 'portable customization config');
  if (config !== undefined && Buffer.byteLength(stableJson(config)) > MAX_CONFIG_BYTES)
    throw new TypeError(`Portable customization config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const workerContributions = parseSelectors(value['workerContributions']);
  return deepFreeze({
    schemaVersion: 1,
    id,
    entrypoint,
    ...(config === undefined ? {} : { config }),
    workerContributions,
  });
}

export function parseNativeResolvedPortableCustomizationDescriptorV1(
  input: unknown,
): NativeResolvedPortableCustomizationDescriptorV1 {
  const value = record(input, 'resolved portable customization descriptor');
  closed(
    value,
    ['schemaVersion', 'id', 'entrypoint', 'config', 'workerContributions', 'manifestSha256'],
    'resolved portable customization descriptor',
  );
  const base = parseNativePortableCustomizationDescriptorV1({
    schemaVersion: value['schemaVersion'],
    id: value['id'],
    entrypoint: value['entrypoint'],
    ...(value['config'] === undefined ? {} : { config: value['config'] }),
    workerContributions: value['workerContributions'],
  });
  const manifestSha256 = hash(value['manifestSha256'], 'portable customization manifest');
  return deepFreeze({ ...base, manifestSha256 });
}

export async function resolveNativePortableCustomizationV1(
  input: NativePortableCustomizationDescriptorV1,
  options: {
    readonly target: 'root' | 'worker';
    readonly expectedManifestSha256?: string;
  },
): Promise<NativePortableCustomizationResolutionV1> {
  const parsed = parseNativePortableCustomizationDescriptorV1(input);
  const expectedManifest = options.expectedManifestSha256 === undefined
    ? undefined
    : hash(options.expectedManifestSha256, 'expected portable customization manifest');
  const canonicalPath = await fs.realpath(fileURLToPath(parsed.entrypoint.moduleUrl));
  const metadata = await fs.stat(canonicalPath);
  if (!metadata.isFile()) throw new TypeError('Portable customization module must be a regular file');
  if (metadata.size > MAX_MODULE_BYTES)
    throw new TypeError(`Portable customization module exceeds ${MAX_MODULE_BYTES} bytes`);
  const moduleBytes = await fs.readFile(canonicalPath);
  const actualSha256 = createHash('sha256').update(moduleBytes).digest('hex');
  const expectedSha256 = parsed.entrypoint.integrity.slice('sha256-'.length);
  if (actualSha256 !== expectedSha256)
    throw new TypeError('Portable customization module integrity does not match');
  const canonicalModuleUrl = pathToFileURL(canonicalPath).href;
  // Import the exact verified bytes. A pathname import would permit replacement
  // between hashing and module loading.
  const imported = await import(
    `data:text/javascript;base64,${moduleBytes.toString('base64')}#octocodePortableSha256=${actualSha256}`
  ) as Record<string, unknown>;
  const candidate = imported[parsed.entrypoint.exportName];
  if (typeof candidate !== 'function')
    throw new TypeError(`Portable customization export ${parsed.entrypoint.exportName} is not a factory`);
  const factory = candidate as NativePortableCustomizationFactoryV1;
  const activated = await factory(deepFreeze({
    schemaVersion: 1,
    target: options.target,
    ...(parsed.config === undefined ? {} : { config: parsed.config }),
  }));
  let customization: NativePortableContributionSetV1;
  let manifest: NativePortableCustomizationManifestV1;
  let manifestSha256: string;
  try {
    customization = validateContributionSet(activated, parsed.id);
    manifest = nativePortableCustomizationManifestV1(customization);
    manifestSha256 = createHash('sha256').update(stableJson(manifest)).digest('hex');
    if (expectedManifest !== undefined && expectedManifest !== manifestSha256)
      throw new TypeError('Portable customization manifest does not match the expected identity');
    assertSelectorsExist(parsed.workerContributions, manifest);
  } catch (error) {
    await disposeFailedActivation(activated, error);
    throw error;
  }
  const descriptor = deepFreeze({
    ...parsed,
    entrypoint: {
      ...parsed.entrypoint,
      moduleUrl: canonicalModuleUrl,
      integrity: `sha256-${actualSha256}` as const,
    },
    manifestSha256,
  });
  return deepFreeze({ descriptor, manifest, customization });
}

export async function resolveNativeResolvedPortableCustomizationV1(
  input: unknown,
  options: { readonly target: 'root' | 'worker' },
): Promise<NativePortableCustomizationResolutionV1> {
  const parsed = parseNativeResolvedPortableCustomizationDescriptorV1(input);
  const descriptor: NativePortableCustomizationDescriptorV1 = {
    schemaVersion: 1,
    id: parsed.id,
    entrypoint: parsed.entrypoint,
    ...(parsed.config === undefined ? {} : { config: parsed.config }),
    workerContributions: parsed.workerContributions,
  };
  return resolveNativePortableCustomizationV1(descriptor, {
    target: options.target,
    expectedManifestSha256: parsed.manifestSha256,
  });
}

export function nativePortableCustomizationManifestV1(
  customization: NativePortableContributionSetV1,
): NativePortableCustomizationManifestV1 {
  return deepFreeze({
    schemaVersion: 1,
    id: customization.id,
    ...(customization.productPolicyOverlay === undefined
      ? {}
      : {
          productPolicyOverlay: cloneJson(
            customization.productPolicyOverlay,
            'product policy overlay',
          ) as unknown as ProductPolicyOverlayV1,
        }),
    ...(customization.tools === undefined
      ? {}
      : {
          tools: customization.tools.map((tool) => cloneJson({
            id: tool.id,
            name: tool.name,
            label: tool.label,
            description: tool.description,
            schemaVersion: tool.schemaVersion,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            outputVersion: tool.outputVersion,
            policy: tool.policy,
          }, `tool manifest ${tool.id}`) as unknown as Readonly<Record<string, unknown>>),
        }),
    ...(customization.hooks === undefined
      ? {}
      : {
          hooks: customization.hooks.map(({ id, event, priority, timeoutMs }) => ({
            id, event,
            ...(priority === undefined ? {} : { priority }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })),
        }),
    ...(customization.events === undefined
      ? {}
      : {
          events: customization.events.map(({ id, event, priority, timeoutMs }) => ({
            id, event,
            ...(priority === undefined ? {} : { priority }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })),
        }),
    ...(customization.compaction === undefined
      ? {}
      : {
          compaction: {
            ...(customization.compaction.inputTokenThreshold === undefined
              ? {}
              : { inputTokenThreshold: customization.compaction.inputTokenThreshold }),
            customSummarizer: customization.compaction.summarize !== undefined,
          },
        }),
  });
}

export function selectNativePortableCustomizationForWorkerV1(
  resolution: NativePortableCustomizationResolutionV1,
  input: {
    readonly allowedTools: readonly string[] | ReadonlySet<string>;
    readonly allowedContributions?: readonly NativePortableContributionSelectorV1[];
  },
): NativePortableContributionSetV1 {
  const configured = new Set(resolution.descriptor.workerContributions);
  const requested = input.allowedContributions === undefined
    ? configured
    : new Set(parseSelectors(input.allowedContributions));
  for (const selector of requested) {
    if (!configured.has(selector))
      throw new TypeError(`Worker contribution selector is not authorized: ${selector}`);
  }
  const allowedTools = input.allowedTools instanceof Set
    ? input.allowedTools
    : new Set(input.allowedTools);
  const source = resolution.customization;
  const tools = source.tools?.filter((tool) =>
    requested.has(`tool:${tool.id}`) && allowedTools.has(tool.name));
  const hooks = source.hooks?.filter((hook) => requested.has(`hook:${hook.id}`));
  const events = source.events?.filter((event) => requested.has(`event:${event.id}`));
  return deepFreeze({
    schemaVersion: 1,
    id: source.id,
    ...(source.productPolicyOverlay === undefined ? {} : { productPolicyOverlay: source.productPolicyOverlay }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(hooks === undefined || hooks.length === 0 ? {} : { hooks }),
    ...(events === undefined || events.length === 0 ? {} : { events }),
    ...(!requested.has('compaction') || source.compaction === undefined
      ? {}
      : { compaction: source.compaction }),
    ...(source.dispose === undefined ? {} : { dispose: source.dispose }),
  });
}

function parseEntrypoint(input: unknown): NativePortableCustomizationEntrypointV1 {
  const value = record(input, 'portable customization entrypoint');
  closed(value, ['kind', 'moduleUrl', 'exportName', 'integrity'], 'portable customization entrypoint');
  if (value['kind'] !== 'module') throw new TypeError('Portable customization entrypoint kind is unsupported');
  if (typeof value['moduleUrl'] !== 'string') throw new TypeError('Portable customization module URL is invalid');
  let url: URL;
  try { url = new URL(value['moduleUrl']); }
  catch { throw new TypeError('Portable customization module URL is invalid'); }
  if (url.protocol !== 'file:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('Portable customization module URL must be an absolute file URL without credentials, query, or fragment');
  const exportName = typeof value['exportName'] === 'string' && SAFE_EXPORT.test(value['exportName'])
    ? value['exportName']
    : undefined;
  if (exportName === undefined) throw new TypeError('Portable customization export name is invalid');
  if (typeof value['integrity'] !== 'string' || !INTEGRITY.test(value['integrity']))
    throw new TypeError('Portable customization module integrity is invalid');
  return deepFreeze({
    kind: 'module',
    moduleUrl: url.href,
    exportName,
    integrity: value['integrity'] as `sha256-${string}`,
  });
}

function parseSelectors(input: unknown): readonly NativePortableContributionSelectorV1[] {
  if (!Array.isArray(input)) throw new TypeError('Portable worker contributions must be an array');
  if (input.length > MAX_WORKER_CONTRIBUTIONS)
    throw new TypeError(`Portable worker contributions exceed ${MAX_WORKER_CONTRIBUTIONS}`);
  const result = input.map((value) => {
    if (value === 'compaction') return value;
    if (typeof value !== 'string') throw new TypeError('Portable worker contribution selector is invalid');
    const separator = value.indexOf(':');
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (!['tool', 'hook', 'event'].includes(kind) || !SAFE_ID.test(id))
      throw new TypeError(`Portable worker contribution selector is invalid: ${value}`);
    return value as NativePortableContributionSelectorV1;
  });
  if (new Set(result).size !== result.length)
    throw new TypeError('Portable worker contribution selectors contain a duplicate');
  return Object.freeze(result);
}

function validateContributionSet(input: unknown, expectedId: string): NativePortableContributionSetV1 {
  const value = record(input, 'portable customization factory result');
  closed(
    value,
    ['schemaVersion', 'id', 'productPolicyOverlay', 'tools', 'hooks', 'events', 'compaction', 'dispose'],
    'portable customization factory result',
  );
  if (value['schemaVersion'] !== 1 || value['id'] !== expectedId)
    throw new TypeError('Portable customization factory identity does not match its descriptor');
  if (value['tools'] !== undefined) validateArray(value['tools'], 'tools', validateTool);
  if (value['hooks'] !== undefined) validateArray(value['hooks'], 'hooks', validateHook);
  if (value['events'] !== undefined) validateArray(value['events'], 'events', validateEvent);
  if (value['compaction'] !== undefined) validateCompaction(value['compaction']);
  if (value['productPolicyOverlay'] !== undefined) validateOverlay(value['productPolicyOverlay']);
  if (value['dispose'] !== undefined && typeof value['dispose'] !== 'function')
    throw new TypeError('Portable customization dispose must be a function');
  return deepFreeze(value as unknown as NativePortableContributionSetV1);
}

function validateArray(input: unknown, label: string, validate: (value: unknown) => string): void {
  if (!Array.isArray(input)) throw new TypeError(`Portable customization ${label} must be an array`);
  const ids = input.map(validate);
  if (new Set(ids).size !== ids.length) throw new TypeError(`Portable customization ${label} contain duplicate ids`);
}

function validateTool(input: unknown): string {
  const value = record(input, 'portable tool');
  closed(value, [
    'id', 'name', 'label', 'description', 'schemaVersion', 'inputSchema',
    'outputSchema', 'outputVersion', 'policy', 'execute',
  ], 'portable tool');
  const id = identifier(value['id'], 'portable tool id');
  identifier(value['name'], 'portable tool name');
  if (typeof value['label'] !== 'string' || !value['label'].trim() ||
      typeof value['description'] !== 'string' || !value['description'].trim())
    throw new TypeError(`Portable tool ${id} label and description are required`);
  if (!Number.isSafeInteger(value['schemaVersion']) || (value['schemaVersion'] as number) < 1 ||
      !Number.isSafeInteger(value['outputVersion']) || (value['outputVersion'] as number) < 1)
    throw new TypeError(`Portable tool ${id} versions are invalid`);
  if (typeof value['execute'] !== 'function') throw new TypeError(`Portable tool ${id} requires an executor`);
  record(value['inputSchema'], `portable tool ${id} input schema`);
  record(value['outputSchema'], `portable tool ${id} output schema`);
  cloneJson(value['inputSchema'], `portable tool ${id} input schema`);
  cloneJson(value['outputSchema'], `portable tool ${id} output schema`);
  const policy = record(value['policy'], `portable tool ${id} policy`);
  closed(policy, ['effects', 'trust', 'approval', 'plan'], `portable tool ${id} policy`);
  if (!Array.isArray(policy['effects']) || policy['effects'].length === 0 ||
      policy['effects'].some((effect) => !['read', 'network', 'process', 'write', 'destructive'].includes(String(effect))) ||
      !['none', 'workspace', 'managed'].includes(String(policy['trust'])) ||
      !['never', 'on-request', 'always'].includes(String(policy['approval'])) ||
      !['allowed', 'forbidden', 'required'].includes(String(policy['plan'])))
    throw new TypeError(`Portable tool ${id} policy is invalid`);
  return id;
}

function validateHook(input: unknown): string {
  const value = record(input, 'portable hook');
  closed(value, ['id', 'event', 'priority', 'timeoutMs', 'handle'], 'portable hook');
  const id = identifier(value['id'], 'portable hook id');
  if (typeof value['event'] !== 'string' || !EVENT_TYPES.has(value['event']) || typeof value['handle'] !== 'function')
    throw new TypeError(`Portable hook ${id} is invalid`);
  validateTiming(value, `Portable hook ${id}`);
  return id;
}

function validateEvent(input: unknown): string {
  const value = record(input, 'portable event observer');
  closed(value, ['id', 'event', 'priority', 'timeoutMs', 'observe'], 'portable event observer');
  const id = identifier(value['id'], 'portable event observer id');
  if (typeof value['event'] !== 'string' || !EVENT_TYPES.has(value['event']) || typeof value['observe'] !== 'function')
    throw new TypeError(`Portable event observer ${id} is invalid`);
  validateTiming(value, `Portable event observer ${id}`);
  return id;
}

function validateTiming(value: Record<string, unknown>, label: string): void {
  if (value['priority'] !== undefined &&
      (!Number.isSafeInteger(value['priority']) || (value['priority'] as number) < -10_000 || (value['priority'] as number) > 10_000))
    throw new TypeError(`${label} priority is invalid`);
  if (value['timeoutMs'] !== undefined &&
      (!Number.isSafeInteger(value['timeoutMs']) || (value['timeoutMs'] as number) < 1 || (value['timeoutMs'] as number) > 60_000))
    throw new TypeError(`${label} timeout is invalid`);
}

function validateCompaction(input: unknown): void {
  const value = record(input, 'portable compaction');
  closed(value, ['inputTokenThreshold', 'summarize'], 'portable compaction');
  if (value['summarize'] !== undefined && typeof value['summarize'] !== 'function')
    throw new TypeError('Portable compaction summarizer must be a function');
  if (value['inputTokenThreshold'] !== undefined &&
      (!Number.isSafeInteger(value['inputTokenThreshold']) ||
       (value['inputTokenThreshold'] as number) < 4_096 ||
       (value['inputTokenThreshold'] as number) > 2_000_000))
    throw new TypeError('Portable compaction threshold is invalid');
}

async function disposeFailedActivation(input: unknown, activationError: unknown): Promise<void> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
  const dispose = (input as { dispose?: unknown }).dispose;
  if (typeof dispose !== 'function') return;
  try {
    await dispose.call(input);
  } catch (disposeError) {
    throw new AggregateError(
      [activationError, disposeError],
      'Portable customization activation and cleanup both failed',
    );
  }
}

function validateOverlay(input: unknown): void {
  const value = record(input, 'portable product policy overlay');
  closed(value, ['mode', 'content'], 'portable product policy overlay');
  if (!['prepend', 'append', 'replace'].includes(String(value['mode'])) ||
      typeof value['content'] !== 'string' || !value['content'].trim() ||
      Buffer.byteLength(value['content']) > 128 * 1024)
    throw new TypeError('Portable product policy overlay is invalid');
}

function assertSelectorsExist(
  selectors: readonly NativePortableContributionSelectorV1[],
  manifest: NativePortableCustomizationManifestV1,
): void {
  const available = new Set<NativePortableContributionSelectorV1>();
  for (const tool of manifest.tools ?? []) available.add(`tool:${String(tool['id'])}`);
  for (const hook of manifest.hooks ?? []) available.add(`hook:${String(hook['id'])}`);
  for (const event of manifest.events ?? []) available.add(`event:${String(event['id'])}`);
  if (manifest.compaction !== undefined) available.add('compaction');
  for (const selector of selectors) {
    if (!available.has(selector)) throw new TypeError(`Portable worker selector does not identify a contribution: ${selector}`);
  }
}

function cloneJson(input: unknown, label: string, depth = 0, seen = new Set<object>()): JsonValueV1 {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${label} exceeds the JSON depth limit`);
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`${label} must be JSON data`);
    return input;
  }
  if (typeof input !== 'object') throw new TypeError(`${label} must be JSON data`);
  if (seen.has(input)) throw new TypeError(`${label} must be acyclic JSON data`);
  seen.add(input);
  try {
    if (Array.isArray(input)) return input.map((value) => cloneJson(value, label, depth + 1, seen));
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${label} must contain only plain JSON objects`);
    const output = Object.create(null) as Record<string, JsonValueV1>;
    for (const key of Object.keys(input as object).sort())
      output[key] = cloneJson((input as Record<string, unknown>)[key], label, depth + 1, seen);
    return output;
  } finally {
    seen.delete(input);
  }
}

function stableJson(input: JsonValueV1 | NativePortableCustomizationManifestV1): string {
  return JSON.stringify(input, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object`);
  return input as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`${label} must be closed; unknown field ${unknown}`);
}

function identifier(input: unknown, label: string): string {
  if (typeof input !== 'string' || !SAFE_ID.test(input)) throw new TypeError(`${label} is invalid`);
  return input;
}

function hash(input: unknown, label: string): string {
  if (typeof input !== 'string' || !SHA256.test(input)) throw new TypeError(`${label} SHA-256 is invalid`);
  return input;
}

function deepFreeze<T>(input: T): T {
  if ((typeof input !== 'object' && typeof input !== 'function') || input === null || Object.isFrozen(input)) return input;
  Object.freeze(input);
  for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
  return input;
}
