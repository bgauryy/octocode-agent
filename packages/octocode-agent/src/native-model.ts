import type { ModelDelta, ModelPort, ModelRequest, ModelResponse } from '@octocodeai/agent-core';

export interface OpenAiCompatibleModelOptions {
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  fetch?: typeof globalThis.fetch;
  stream?: boolean;
  headers?: Readonly<Record<string, string>>;
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
  return {
    inputTokens: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0,
    outputTokens: typeof record.completion_tokens === 'number' ? record.completion_tokens : 0,
  };
}

function stopReason(reason: unknown): ModelResponse['stop'] {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool';
  if (reason === 'length') return 'length';
  return 'complete';
}

async function emitText(
  emit: ((delta: ModelDelta) => Promise<void>) | undefined,
  text: unknown,
): Promise<void> {
  if (typeof text === 'string' && text.length > 0) await emit?.({ type: 'text', text });
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

async function emitToolCalls(
  emit: ((delta: ModelDelta) => Promise<void>) | undefined,
  value: unknown,
): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    if (typeof call.id === 'string' && typeof fn?.name === 'string') {
      await emit?.({ type: 'tool-call', id: call.id, name: fn.name, input: parseToolInput(fn.arguments) });
    }
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
  let finalStop: ModelResponse['stop'] = 'complete';
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const delta = first?.delta as Record<string, unknown> | undefined;
      await emitText(emit, delta?.content);
      if (Array.isArray(delta?.tool_calls)) {
        for (const item of delta.tool_calls) {
          const call = item as Record<string, unknown>;
          const index = typeof call.index === 'number' ? call.index : toolCalls.size;
          const fn = call.function as Record<string, unknown> | undefined;
          const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof call.id === 'string') current.id = call.id;
          if (typeof fn?.name === 'string') current.name += fn.name;
          if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
          toolCalls.set(index, current);
        }
      }
      if (first?.finish_reason != null) finalStop = stopReason(first.finish_reason);
      if (parsed.usage != null) finalUsage = usage(parsed.usage);
    }
  }
  for (const call of toolCalls.values()) {
    if (call.id && call.name) await emit?.({ type: 'tool-call', id: call.id, name: call.name, input: parseToolInput(call.arguments) });
  }
  return { stop: finalStop, usage: finalUsage };
}

export function createOpenAiCompatibleModelPort(
  options: OpenAiCompatibleModelOptions,
): ModelPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = endpointUrl(options.endpoint);
  return {
    async run(request: ModelRequest, context): Promise<ModelResponse> {
      if (!options.apiKey) {
        throw new Error('Set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY to run the native agent');
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
        throw error;
      }
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const suffix = retry ? ` (retry-after: ${retry})` : '';
        throw new Error(`Model provider request failed with HTTP ${response.status}${suffix}`);
      }
      if (options.stream !== false) return consumeStream(response, context.emit);

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
