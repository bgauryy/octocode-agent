import {
  RuntimeFailure,
  type JsonSchema,
  type ModelMessage,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from '@octocodeai/agent-core';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, streamText, type ModelMessage as AiModelMessage, type SystemModelMessage, type ToolSet } from 'ai';

export type NativeModelProtocol =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'amazon-bedrock-converse'
  | 'azure-openai';

export interface NativeModelProtocolSupport {
  readonly protocol: NativeModelProtocol;
  readonly supported: boolean;
  readonly reason?: string;
}

/** Explicit capability ledger for the composed native runtime. */
export const NATIVE_MODEL_PROTOCOL_SUPPORT: readonly NativeModelProtocolSupport[] = [
  { protocol: 'openai-chat-completions', supported: true },
  { protocol: 'openai-responses', supported: true },
  { protocol: 'anthropic-messages', supported: true },
  { protocol: 'google-gemini', supported: false, reason: 'GenerateContent/Interactions roles, function calls, thinking, and authentication require a dedicated adapter.' },
  { protocol: 'amazon-bedrock-converse', supported: false, reason: 'Converse streaming and AWS request signing require a dedicated adapter.' },
  { protocol: 'azure-openai', supported: false, reason: 'Deployment URLs, API versions, and Azure authentication require a dedicated adapter.' },
];

interface SharedModelOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly resolveAuth?: () => { readonly apiKey?: string; readonly headers: Readonly<Record<string, string>> };
  /** Permit explicitly configured header-only or unauthenticated endpoints. */
  readonly allowMissingApiKey?: boolean;
}

export interface OpenAiCompatibleModelOptions extends SharedModelOptions {
  readonly protocol?: 'openai-chat-completions' | 'openai-responses';
  /** Retained for configuration compatibility; all Vercel adapters stream internally. */
  readonly stream?: boolean;
  /** Stable routing key for providers that implement OpenAI prompt caching. */
  readonly promptCacheKey?: string;
}

export interface AnthropicMessagesModelOptions extends SharedModelOptions {
  readonly maxOutputTokens?: number;
  readonly promptCaching?: boolean;
  readonly sessionAffinityId?: string;
}

type ResolvedAuth = { readonly apiKey?: string; readonly headers: Readonly<Record<string, string>> };

function providerBaseUrl(endpoint: string, protocol: 'chat' | 'responses' | 'anthropic'): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RuntimeFailure('validation', 'Model endpoint must use http or https');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const suffix = protocol === 'chat' ? '/chat/completions' : protocol === 'responses' ? '/responses' : '/messages';
  if (url.pathname.endsWith(suffix)) url.pathname = url.pathname.slice(0, -suffix.length) || '/';
  if (protocol === 'anthropic' && !url.pathname.replace(/\/$/, '').endsWith('/v1')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1`;
  }
  return url.toString().replace(/\/$/, '');
}

function thinkingBudget(level: ModelRequest['thinkingLevel']): number | undefined {
  if (level === undefined || level === 'none') return undefined;
  if (level === 'minimal' || level === 'low') return 1_024;
  if (level === 'medium') return 4_096;
  if (level === 'high') return 8_192;
  if (level === 'xhigh') return 16_384;
  throw new RuntimeFailure('adapter-translation', 'Unsupported thinking level for Anthropic Messages');
}

function toolNames(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

function aiMessages(request: ModelRequest, cacheAnthropic: boolean): AiModelMessage[] {
  const names = toolNames(request.messages);
  const messages: AiModelMessage[] = request.messages.flatMap((message) => {
    if (message.role === 'system') return [];
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (message.content.length > 0) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.input });
      }
      return { role: 'assistant', content } as AiModelMessage;
    }
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: message.toolCallId,
        toolName: names.get(message.toolCallId ?? '') ?? 'unknown-tool',
        output: { type: 'text', value: message.content },
      }],
    } as AiModelMessage;
  });
  if (!cacheAnthropic || messages.length === 0) return messages;
  let lastSystem = -1;
  let lastConversation = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]!.role === 'system') lastSystem = index;
    else lastConversation = index;
  }
  for (const index of [lastSystem, lastConversation]) {
    if (index >= 0) {
      messages[index] = {
        ...messages[index],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      } as AiModelMessage;
    }
  }
  return messages;
}

function aiInstructions(request: ModelRequest, cacheAnthropic: boolean): SystemModelMessage[] | undefined {
  const instructions: SystemModelMessage[] = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => ({ role: 'system' as const, content: message.content }));
  if (instructions.length === 0) return undefined;
  if (cacheAnthropic) {
    const last = instructions[instructions.length - 1]!;
    instructions[instructions.length - 1] = {
      role: 'system',
      content: last.content,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    } as unknown as SystemModelMessage;
  }
  return instructions;
}

function mergedProviderProperty(schemas: readonly JsonSchema[]): JsonSchema {
  const unique = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
  const constants = unique.map((schema) => schema.const);
  if (constants.every((value) => value !== undefined)) {
    const values = [...new Map(constants.map((value) => [JSON.stringify(value), value])).values()];
    const first = values[0];
    return {
      ...(first === null ? {} : { type: typeof first }),
      enum: values,
    };
  }
  return unique.length === 1 ? unique[0]! : { anyOf: unique };
}

/**
 * Provider tool APIs require an object at the root. Anthropic additionally
 * rejects top-level combinators, so project object alternatives into one
 * permissive wire schema. The runtime still validates the original schema.
 */
function providerToolInputSchema(schema: JsonSchema): JsonSchema {
  const alternatives = schema.oneOf ?? schema.anyOf ?? schema.allOf;
  if (alternatives === undefined || alternatives.length === 0) {
    return { ...schema, type: schema.type ?? 'object' };
  }

  const propertySchemas = new Map<string, JsonSchema[]>();
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    propertySchemas.set(name, [property]);
  }
  for (const alternative of alternatives) {
    for (const [name, property] of Object.entries(alternative.properties ?? {})) {
      propertySchemas.set(name, [...(propertySchemas.get(name) ?? []), property]);
    }
  }

  const requiredSets = alternatives.map((alternative) => new Set(alternative.required ?? []));
  const alternativeRequired = schema.allOf !== undefined
    ? [...new Set(requiredSets.flatMap((set) => [...set]))]
    : [...(requiredSets[0] ?? new Set<string>())].filter((name) => requiredSets.every((set) => set.has(name)));
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...base } = schema;
  return {
    ...base,
    type: 'object',
    properties: Object.fromEntries(
      [...propertySchemas].map(([name, properties]) => [name, mergedProviderProperty(properties)]),
    ),
    required: [...new Set([...(schema.required ?? []), ...alternativeRequired])],
  };
}

function aiTools(request: ModelRequest, cacheAnthropic: boolean): ToolSet | undefined {
  if (request.tools === undefined) return undefined;
  return Object.fromEntries(request.tools.map((tool, index) => [tool.name, {
    description: tool.description,
    inputSchema: jsonSchema(providerToolInputSchema(tool.inputSchema) as Parameters<typeof jsonSchema>[0]),
    ...(cacheAnthropic && index === request.tools!.length - 1
      ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
      : {}),
  }])) as ToolSet;
}

function aiToolChoice(request: ModelRequest): 'auto' | 'none' | { type: 'tool'; toolName: string } | undefined {
  if (request.toolChoice === undefined || typeof request.toolChoice === 'string') return request.toolChoice;
  return { type: 'tool', toolName: request.toolChoice.name };
}

function usage(value: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly inputTokenDetails?: { readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number };
}): ModelResponse['usage'] {
  return {
    inputTokens: value.inputTokens ?? 0,
    outputTokens: value.outputTokens ?? 0,
    ...(value.inputTokenDetails?.cacheReadTokens === undefined ? {} : { cachedInputTokens: value.inputTokenDetails.cacheReadTokens }),
    ...(value.inputTokenDetails?.cacheWriteTokens === undefined ? {} : { cacheWriteInputTokens: value.inputTokenDetails.cacheWriteTokens }),
  };
}

function stopReason(reason: string): ModelResponse['stop'] {
  if (reason === 'tool-calls') return 'tool';
  if (reason === 'length') return 'length';
  if (reason === 'stop') return 'complete';
  return 'error';
}

function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function providerFailure(error: unknown): RuntimeFailure {
  let source = error;
  for (let depth = 0; depth < 3; depth += 1) {
    const candidate = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {};
    if (typeof candidate.statusCode === 'number') break;
    if (candidate.cause === undefined) break;
    source = candidate.cause;
  }
  const record = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {};
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const headers = typeof record.responseHeaders === 'object' && record.responseHeaders !== null
    ? record.responseHeaders as Record<string, unknown>
    : {};
  const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  return new RuntimeFailure(
    'provider',
    status === undefined ? 'Model provider request failed' : `Model provider request failed with HTTP ${status}`,
    retryable ? 'safe' : 'unsafe',
    true,
    'public',
    'operation',
    status === undefined ? 'network' : `http:${status}`,
    retryAfterMs(headers['retry-after']),
  );
}

function resolvedAuth(options: SharedModelOptions): ResolvedAuth {
  const dynamic = options.resolveAuth?.();
  const apiKey = dynamic?.apiKey ?? options.apiKey;
  const headers = dynamic?.headers ?? options.headers ?? {};
  if (!apiKey && options.allowMissingApiKey !== true) {
    throw new Error('Set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY to run the native agent');
  }
  return { ...(apiKey ? { apiKey } : {}), headers };
}

function credentialFetch(
  fetchImpl: typeof globalThis.fetch,
  input: { readonly removeBearer: boolean; readonly removeAnthropicKey: boolean },
): typeof globalThis.fetch {
  return async (resource, init) => {
    const headers = new Headers(init?.headers);
    if (input.removeBearer && headers.get('authorization') === 'Bearer octocode-no-auth') headers.delete('authorization');
    if (input.removeAnthropicKey && headers.get('x-api-key') === 'octocode-no-auth') headers.delete('x-api-key');
    const normalizedHeaders = Object.fromEntries(headers.entries());
    if (normalizedHeaders.authorization !== undefined) {
      normalizedHeaders.Authorization = normalizedHeaders.authorization;
      delete normalizedHeaders.authorization;
    }
    return fetchImpl(resource, { ...init, headers: normalizedHeaders });
  };
}

function captureOpenAiToolCallOrder(
  fetchImpl: typeof globalThis.fetch,
  orderById: Map<string, number>,
): typeof globalThis.fetch {
  return async (resource, init) => {
    const response = await fetchImpl(resource, init);
    if (response.body === null) return response;
    const decoder = new TextDecoder();
    let pending = '';
    const capture = (text: string): void => {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const frame = JSON.parse(data) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index?: unknown; id?: unknown }> } }> };
          for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
            if (typeof call.id === 'string' && Number.isInteger(call.index) && (call.index as number) >= 0) {
              orderById.set(call.id, call.index as number);
            }
          }
        } catch {
          // The provider adapter remains responsible for malformed-frame errors.
        }
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        capture(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        capture(`${decoder.decode()}\n`);
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

interface VercelRunOptions {
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
  readonly emit?: (delta: { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool-call'; id: string; name: string; input: unknown }) => Promise<void>;
  readonly model: Parameters<typeof streamText>[0]['model'];
  readonly headers: Readonly<Record<string, string>>;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Parameters<typeof streamText>[0]['providerOptions'];
  readonly cacheAnthropic?: boolean;
  readonly stream?: boolean;
  readonly toolCallOrder?: ReadonlyMap<string, number>;
}

async function runVercelModel(options: VercelRunOptions): Promise<ModelResponse> {
  try {
    const common = {
      model: options.model,
      instructions: aiInstructions(options.request, options.cacheAnthropic === true),
      messages: aiMessages(options.request, options.cacheAnthropic === true),
      tools: aiTools(options.request, options.cacheAnthropic === true),
      toolChoice: aiToolChoice(options.request),
      maxRetries: 0,
      abortSignal: options.signal,
      headers: options.headers,
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    };
    if (options.stream === false) {
      const result = await generateText(common);
      if (result.text.length > 0) await options.emit?.({ type: 'text', text: result.text });
      const declaredTools = new Set(options.request.tools?.map((tool) => tool.name) ?? []);
      for (const call of result.toolCalls) {
        if (!declaredTools.has(call.toolName)) {
          throw new RuntimeFailure('adapter-translation', 'Malformed model tool arguments');
        }
        await options.emit?.({ type: 'tool-call', id: call.toolCallId, name: call.toolName, input: call.input });
      }
      if (result.finishReason === 'tool-calls' && result.toolCalls.length === 0) {
        throw new RuntimeFailure('adapter-translation', 'Malformed model tool arguments');
      }
      return { stop: stopReason(result.finishReason), usage: usage(result.totalUsage) };
    }
    const result = streamText({
      ...common,
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' && part.text.length > 0) await options.emit?.({ type: 'text', text: part.text });
      if (part.type === 'reasoning-delta' && part.text.length > 0) await options.emit?.({ type: 'thinking', text: part.text });
      if (part.type === 'error') throw part.error;
    }
    const toolCalls = [...await result.toolCalls].sort((left, right) => {
      const leftIndex = options.toolCallOrder?.get(left.toolCallId);
      const rightIndex = options.toolCallOrder?.get(right.toolCallId);
      if (leftIndex === undefined || rightIndex === undefined) return 0;
      return leftIndex - rightIndex;
    });
    for (const call of toolCalls) {
      if (!options.request.tools?.some((tool) => tool.name === call.toolName)) {
        throw new RuntimeFailure('adapter-translation', 'Malformed model tool arguments');
      }
      await options.emit?.({ type: 'tool-call', id: call.toolCallId, name: call.toolName, input: call.input });
    }
    return { stop: stopReason(await result.finishReason), usage: usage(await result.totalUsage) };
  } catch (error) {
    if (options.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
    if (error instanceof RuntimeFailure) throw error;
    throw providerFailure(error);
  }
}

export function createOpenAiCompatibleModelPort(options: OpenAiCompatibleModelOptions): ModelPort {
  return {
    async run(request, context): Promise<ModelResponse> {
      if (options.protocol !== 'openai-responses' && request.thinkingLevel !== undefined) {
        throw new RuntimeFailure('adapter-translation', 'Thinking controls are not supported by the configured chat-completions adapter');
      }
      const auth = resolvedAuth(options);
      const fetchImpl = credentialFetch(options.fetch ?? globalThis.fetch, {
        removeBearer: auth.apiKey === undefined,
        removeAnthropicKey: false,
      });
      const modelId = request.model?.modelId ?? options.defaultModel;
      if (options.protocol === 'openai-responses') {
        const provider = createOpenAI({
          baseURL: providerBaseUrl(options.endpoint, 'responses'),
          apiKey: auth.apiKey ?? 'octocode-no-auth',
          headers: auth.headers,
          fetch: fetchImpl,
        });
        return runVercelModel({
          request,
          signal: context.signal,
          emit: context.emit,
          model: provider.responses(modelId),
          headers: auth.headers,
          providerOptions: {
            openai: {
              ...(options.promptCacheKey === undefined ? {} : { promptCacheKey: options.promptCacheKey }),
              ...(request.thinkingLevel === undefined ? {} : { reasoningEffort: request.thinkingLevel }),
            },
          },
          stream: options.stream,
        });
      }
      const providerName = request.model?.providerId ?? 'octocode-compatible';
      const officialOpenAI = new URL(options.endpoint).hostname === 'api.openai.com';
      const toolCallOrder = new Map<string, number>();
      const orderedFetch = captureOpenAiToolCallOrder(fetchImpl, toolCallOrder);
      const model = officialOpenAI
        ? createOpenAI({
            baseURL: providerBaseUrl(options.endpoint, 'chat'),
            apiKey: auth.apiKey ?? 'octocode-no-auth',
            headers: auth.headers,
            fetch: orderedFetch,
          }).chat(modelId)
        : createOpenAICompatible({
            name: providerName,
            baseURL: providerBaseUrl(options.endpoint, 'chat'),
            apiKey: auth.apiKey ?? 'octocode-no-auth',
            headers: auth.headers,
            fetch: orderedFetch,
            includeUsage: true,
          }).chatModel(modelId);
      return runVercelModel({
        request,
        signal: context.signal,
        emit: context.emit,
        model,
        headers: auth.headers,
        providerOptions: options.promptCacheKey === undefined
          ? undefined
          : { [officialOpenAI ? 'openai' : providerName]: { promptCacheKey: options.promptCacheKey } },
        stream: options.stream,
        toolCallOrder,
      });
    },
  };
}

export function createAnthropicMessagesModelPort(options: AnthropicMessagesModelOptions): ModelPort {
  return {
    async run(request, context): Promise<ModelResponse> {
      const auth = resolvedAuth(options);
      const fetchImpl = credentialFetch(options.fetch ?? globalThis.fetch, {
        removeBearer: false,
        removeAnthropicKey: auth.apiKey === undefined,
      });
      const provider = createAnthropic({
        baseURL: providerBaseUrl(options.endpoint, 'anthropic'),
        apiKey: auth.apiKey ?? 'octocode-no-auth',
        headers: {
          ...auth.headers,
          ...(options.sessionAffinityId === undefined ? {} : { 'x-session-affinity': options.sessionAffinityId }),
        },
        fetch: fetchImpl,
      });
      const budgetTokens = thinkingBudget(request.thinkingLevel);
      return runVercelModel({
        request,
        signal: context.signal,
        emit: context.emit,
        model: provider.messages(request.model?.modelId ?? options.defaultModel),
        headers: auth.headers,
        maxOutputTokens: options.maxOutputTokens ?? 4_096,
        cacheAnthropic: options.promptCaching === true,
        providerOptions: budgetTokens === undefined
          ? undefined
          : { anthropic: { thinking: { type: 'enabled', budgetTokens } } },
      });
    },
  };
}
