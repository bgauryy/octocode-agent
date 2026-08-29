import { RuntimeFailure, type ModelDelta, type ModelPort, type ModelRequest, type ModelResponse } from '@octocodeai/agent-core';
import { createOpenAiResponsesModelPort } from './native-openai-responses-model.js';

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

export interface OpenAiCompatibleModelOptions {
  protocol?: 'openai-chat-completions' | 'openai-responses';
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  fetch?: typeof globalThis.fetch;
  stream?: boolean;
  headers?: Readonly<Record<string, string>>;
  /** Stable routing key for providers that implement OpenAI prompt caching. */
  promptCacheKey?: string;
}

function endpointUrl(base: string): URL {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Model endpoint must use http or https');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
  return url;
}

function usage(value: unknown): ModelResponse['usage'] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const promptDetails = record.prompt_tokens_details && typeof record.prompt_tokens_details === 'object'
    ? record.prompt_tokens_details as Record<string, unknown>
    : {};
  const cachedInputTokens = typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined;
  return {
    inputTokens: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0,
    outputTokens: typeof record.completion_tokens === 'number' ? record.completion_tokens : 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function stopReason(reason: unknown): ModelResponse['stop'] {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool';
  if (reason === 'length') return 'length';
  if (reason === 'stop') return 'complete';
  return 'error';
}

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

async function emitText(
  emit: ((delta: ModelDelta) => Promise<void>) | undefined,
  text: unknown,
): Promise<void> {
  if (typeof text === 'string' && text.length > 0) await emit?.({ type: 'text', text });
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; }
  catch { throw new RuntimeFailure('adapter-translation', 'Malformed model tool arguments'); }
}

async function emitToolCalls(
  emit: ((delta: ModelDelta) => Promise<void>) | undefined,
  value: unknown,
): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new RuntimeFailure('adapter-translation', 'Malformed model tool call');
    const call = item as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    if (typeof call.id !== 'string' || call.id.length === 0 || typeof fn?.name !== 'string' || fn.name.length === 0) {
      throw new RuntimeFailure('adapter-translation', 'Malformed model tool call');
    }
    const input = parseToolInput(fn.arguments);
    await emit?.({ type: 'tool-call', id: call.id, name: fn.name, input });
  }
}

async function consumeStream(
  response: Response,
  emit: ((delta: ModelDelta) => Promise<void>) | undefined,
): Promise<ModelResponse> {
  if (!response.body) throw new Error('Model provider returned an empty stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finalUsage: ModelResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
  let finalStop: ModelResponse['stop'] = 'error';
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const consumeLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new RuntimeFailure('adapter-translation', 'Malformed model provider stream frame');
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.delta as Record<string, unknown> | undefined;
    await emitText(emit, delta?.content);
    if (Array.isArray(delta?.tool_calls)) {
      for (const item of delta.tool_calls) {
        const call = item as Record<string, unknown>;
        if (!Number.isInteger(call.index) || (call.index as number) < 0) throw new RuntimeFailure('adapter-translation', 'Malformed model tool call index');
        const index = call.index as number;
        const fn = call.function as Record<string, unknown> | undefined;
        const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call.id === 'string') {
          if (current.id && current.id !== call.id) throw new RuntimeFailure('adapter-translation', 'Inconsistent model tool call index');
          current.id = call.id;
        }
        if (typeof fn?.name === 'string') current.name += fn.name;
        if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
        toolCalls.set(index, current);
      }
    }
    if (first?.finish_reason != null) finalStop = stopReason(first.finish_reason);
    if (parsed.usage != null) finalUsage = usage(parsed.usage);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) await consumeLine(raw);
  }
  if (buffer.trim()) await consumeLine(buffer);
  for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    if (!call.id || !call.name) throw new RuntimeFailure('adapter-translation', 'Incomplete model tool call');
    const input = parseToolInput(call.arguments);
    await emit?.({ type: 'tool-call', id: call.id, name: call.name, input });
  }
  return { stop: finalStop, usage: finalUsage };
}

export function createOpenAiCompatibleModelPort(
  options: OpenAiCompatibleModelOptions,
): ModelPort {
  if (options.protocol === 'openai-responses') return createOpenAiResponsesModelPort(options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = endpointUrl(options.endpoint);
  return {
    async run(request: ModelRequest, context): Promise<ModelResponse> {
      if (!options.apiKey) {
        throw new Error('Set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY to run the native agent');
      }
      if (request.thinkingLevel !== undefined) {
        throw new RuntimeFailure('adapter-translation', 'Thinking controls are not supported by the configured chat-completions adapter');
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
            ...options.headers,
          },
          body: JSON.stringify({
            model: request.model?.modelId ?? options.defaultModel,
            ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.role === 'assistant' && message.toolCalls !== undefined ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input) ?? 'null',
                  },
                })),
              } : {}),
              ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
            })),
            ...(request.tools === undefined ? {} : {
              tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
            }),
            ...(request.toolChoice === undefined ? {} : {
              tool_choice: typeof request.toolChoice === 'string'
                ? request.toolChoice
                : { type: 'function', function: { name: request.toolChoice.name } },
            }),
            stream: options.stream ?? true,
            ...(options.stream === false ? {} : { stream_options: { include_usage: true } }),
          }),
          signal: context.signal,
        });
      } catch (error) {
        if (context.signal.aborted) {
          return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (error instanceof RuntimeFailure) throw error;
        throw new RuntimeFailure('provider', 'Model provider request failed', 'safe', true, 'public', 'operation', 'network');
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw new RuntimeFailure(
          'provider',
          `Model provider request failed with HTTP ${response.status}`,
          retryable ? 'safe' : 'unsafe',
          true,
          'public',
          'operation',
          `http:${response.status}`,
          retryAfterMs(response.headers.get('retry-after')),
        );
      }
      if (options.stream !== false) {
        try { return await consumeStream(response, context.emit); }
        catch (error) {
          if (context.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
          throw error;
        }
      }

      const body = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      await emitText(context.emit, message?.content);
      await emitToolCalls(context.emit, message?.tool_calls);
      return { stop: stopReason(first?.finish_reason), usage: usage(body.usage) };
    },
  };
}
