import { RuntimeFailure, type ModelDelta, type ModelMessage, type ModelPort, type ModelRequest, type ModelResponse } from '@octocodeai/agent-core';

export interface AnthropicMessagesModelOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxOutputTokens?: number;
  readonly promptCaching?: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messagesUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RuntimeFailure('validation', 'Model endpoint must use http or https');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const base = url.pathname.replace(/\/$/, '');
  url.pathname = base.endsWith('/messages') ? base : `${base}/messages`;
  return url;
}

function providerFailure(status?: number, retryAfterMs?: number): RuntimeFailure {
  const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  return new RuntimeFailure(
    'provider',
    status === undefined ? 'Anthropic Messages request failed' : `Anthropic Messages request failed with HTTP ${status}`,
    retryable ? 'safe' : 'unsafe',
    true,
    'public',
    'operation',
    status === undefined ? 'network' : `http:${status}`,
    retryAfterMs,
  );
}

function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function thinkingBudget(level: string | undefined): number | undefined {
  if (level === undefined || level === 'none') return undefined;
  if (level === 'minimal' || level === 'low') return 1_024;
  if (level === 'medium') return 4_096;
  if (level === 'high') return 8_192;
  if (level === 'xhigh') return 16_384;
  throw new RuntimeFailure('adapter-translation', 'Unsupported thinking level for Anthropic Messages');
}

function systemFor(request: ModelRequest, cache: boolean): readonly JsonRecord[] | undefined {
  const blocks = request.messages
    .filter((message) => message.role === 'system' && message.content.length > 0)
    .map((message) => ({ type: 'text', text: message.content } as JsonRecord));
  if (blocks.length === 0) return undefined;
  if (cache) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  return blocks;
}

function contentFor(message: Exclude<ModelMessage, { role: 'system' }>): readonly JsonRecord[] {
  if (message.role === 'tool') return [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }];
  const content: JsonRecord[] = [];
  if (message.content.length > 0) content.push({ type: 'text', text: message.content });
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return content;
}

function messagesFor(request: ModelRequest): readonly JsonRecord[] {
  return request.messages
    .filter((message): message is Exclude<ModelMessage, { role: 'system' }> => message.role !== 'system')
    .map((message) => ({ role: message.role === 'tool' ? 'user' : message.role, content: contentFor(message) }));
}

function toolChoiceFor(request: ModelRequest): JsonRecord | undefined {
  if (request.toolChoice === undefined || request.toolChoice === 'auto') return request.tools === undefined ? undefined : { type: 'auto' };
  if (request.toolChoice === 'none') return undefined;
  return { type: 'tool', name: request.toolChoice.name };
}

function parseToolInput(value: string, fallback: unknown): unknown {
  if (value.length === 0) return fallback;
  try { return JSON.parse(value) as unknown; }
  catch { throw new RuntimeFailure('adapter-translation', 'Malformed Anthropic tool input'); }
}

function stopReason(value: unknown): ModelResponse['stop'] {
  if (value === 'tool_use') return 'tool';
  if (value === 'max_tokens') return 'length';
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'pause_turn') return 'complete';
  return 'error';
}

async function consumeAnthropicStream(response: Response, emit: ((delta: ModelDelta) => Promise<void>) | undefined): Promise<ModelResponse> {
  if (!response.body) throw new RuntimeFailure('adapter-translation', 'Anthropic Messages returned an empty stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let terminal = false;
  let stop: ModelResponse['stop'] = 'error';
  let usage: ModelResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
  const tools = new Map<number, { id: string; name: string; input: unknown; json: string }>();
  const consume = async (frame: string): Promise<void> => {
    const data = frame.split('\n').map((line) => line.trim()).find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!data) return;
    let event: JsonRecord;
    try { event = JSON.parse(data) as JsonRecord; }
    catch { throw new RuntimeFailure('adapter-translation', 'Malformed Anthropic stream frame'); }
    if (event['type'] === 'error') throw providerFailure();
    if (event['type'] === 'message_start') {
      const initial = isRecord(event['message']) && isRecord(event['message']['usage']) ? event['message']['usage'] : {};
      usage = {
        inputTokens: typeof initial['input_tokens'] === 'number' ? initial['input_tokens'] : 0,
        outputTokens: 0,
        ...(typeof initial['cache_read_input_tokens'] === 'number' ? { cachedInputTokens: initial['cache_read_input_tokens'] } : {}),
        ...(typeof initial['cache_creation_input_tokens'] === 'number' ? { cacheWriteInputTokens: initial['cache_creation_input_tokens'] } : {}),
      };
      return;
    }
    if (event['type'] === 'content_block_start') {
      const index = event['index'];
      const block = event['content_block'];
      if (Number.isInteger(index) && isRecord(block) && block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
        tools.set(index as number, { id: block['id'], name: block['name'], input: block['input'], json: '' });
      }
      return;
    }
    if (event['type'] === 'content_block_delta') {
      const delta = event['delta'];
      if (!isRecord(delta)) throw new RuntimeFailure('adapter-translation', 'Malformed Anthropic content delta');
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) await emit?.({ type: 'text', text: delta['text'] });
      else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string' && delta['thinking']) await emit?.({ type: 'thinking', text: delta['thinking'] });
      else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string' && Number.isInteger(event['index'])) {
        const tool = tools.get(event['index'] as number);
        if (!tool) throw new RuntimeFailure('adapter-translation', 'Anthropic tool delta has no matching content block');
        tool.json += delta['partial_json'];
      }
      return;
    }
    if (event['type'] === 'content_block_stop' && Number.isInteger(event['index'])) {
      const tool = tools.get(event['index'] as number);
      if (tool) {
        await emit?.({ type: 'tool-call', id: tool.id, name: tool.name, input: parseToolInput(tool.json, tool.input) });
        tools.delete(event['index'] as number);
      }
      return;
    }
    if (event['type'] === 'message_delta') {
      const delta = isRecord(event['delta']) ? event['delta'] : {};
      const finalUsage = isRecord(event['usage']) ? event['usage'] : {};
      stop = stopReason(delta['stop_reason']);
      usage = { ...usage, outputTokens: typeof finalUsage['output_tokens'] === 'number' ? finalUsage['output_tokens'] : usage.outputTokens };
      return;
    }
    if (event['type'] === 'message_stop') terminal = true;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) await consume(frame);
  }
  if (buffer.trim()) await consume(buffer);
  if (!terminal || tools.size > 0) throw new RuntimeFailure('adapter-translation', 'Anthropic Messages stream ended without a terminal event');
  return { stop, usage };
}

export function createAnthropicMessagesModelPort(options: AnthropicMessagesModelOptions): ModelPort {
  const url = messagesUrl(options.endpoint);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxOutputTokens = options.maxOutputTokens ?? 16_384;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000) throw new RuntimeFailure('validation', 'Anthropic maxOutputTokens is invalid');
  return {
    async run(request, context): Promise<ModelResponse> {
      if (!options.apiKey) throw new RuntimeFailure('provider', 'Anthropic credentials are unavailable', 'unsafe', true, 'public', 'operation', 'credentials');
      const budget = thinkingBudget(request.thinkingLevel);
      if (budget !== undefined && budget >= maxOutputTokens) throw new RuntimeFailure('adapter-translation', 'Anthropic thinking budget must be smaller than max output tokens');
      const system = systemFor(request, options.promptCaching === true);
      const toolChoice = toolChoiceFor(request);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { ...options.headers, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': options.apiKey },
          body: JSON.stringify({
            model: request.model?.modelId ?? options.defaultModel,
            max_tokens: maxOutputTokens,
            stream: true,
            messages: messagesFor(request),
            ...(system === undefined ? {} : { system }),
            ...(budget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }),
            ...(request.tools === undefined ? {} : { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
            ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
          }),
          signal: context.signal,
        });
      } catch {
        if (context.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        throw providerFailure();
      }
      if (!response.ok) throw providerFailure(response.status, retryAfter(response.headers.get('retry-after')));
      try { return await consumeAnthropicStream(response, context.emit); }
      catch (error) {
        if (context.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        throw error;
      }
    },
  };
}
