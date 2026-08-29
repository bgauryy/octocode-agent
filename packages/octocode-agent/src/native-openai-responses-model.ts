import OpenAI from 'openai';
import type * as Responses from 'openai/resources/responses/responses';
import { RuntimeFailure, type ModelDelta, type ModelPort, type ModelRequest, type ModelResponse } from '@octocodeai/agent-core';

export interface OpenAiResponsesModelOptions {
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  fetch?: typeof globalThis.fetch;
  headers?: Readonly<Record<string, string>>;
  promptCacheKey?: string;
}

function baseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Model endpoint must use http or https');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function inputFor(request: ModelRequest): Responses.ResponseInput {
  const input: Responses.ResponseInput = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content.length > 0 || message.role !== 'assistant' || message.toolCalls === undefined) {
      input.push({ type: 'message', role: message.role, content: message.content });
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input) ?? 'null',
        });
      }
    }
  }
  return input;
}

function toolsFor(request: ModelRequest): Responses.FunctionTool[] | undefined {
  return request.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

function toolChoiceFor(request: ModelRequest): Responses.ResponseCreateParamsStreaming['tool_choice'] {
  return typeof request.toolChoice === 'object'
    ? { type: 'function', name: request.toolChoice.name }
    : request.toolChoice;
}

function translatedUsage(value: Responses.ResponseUsage | undefined): ModelResponse['usage'] {
  if (!value) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cachedInputTokens: value.input_tokens_details.cached_tokens,
    cacheWriteInputTokens: value.input_tokens_details.cache_write_tokens,
  };
}

function providerFailure(retry: 'safe' | 'unsafe' = 'safe', errorCode = 'responses'): RuntimeFailure {
  return new RuntimeFailure(
    'provider',
    'OpenAI Responses request failed',
    retry,
    true,
    'public',
    'operation',
    errorCode,
  );
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new RuntimeFailure('adapter-translation', 'Malformed model tool arguments'); }
}

async function emit(
  sink: ((delta: ModelDelta) => Promise<void>) | undefined,
  delta: ModelDelta,
): Promise<void> {
  await sink?.(delta);
}

export function createOpenAiResponsesModelPort(options: OpenAiResponsesModelOptions): ModelPort {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: baseUrl(options.endpoint),
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { defaultHeaders: options.headers }),
  });
  return {
    async run(request, context): Promise<ModelResponse> {
      if (!options.apiKey) throw new Error('Set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY to run the native agent');
      if (request.thinkingLevel !== undefined) {
        throw new RuntimeFailure('adapter-translation', 'Thinking controls are not supported by the configured Responses adapter');
      }
      const tools = toolsFor(request);
      const toolChoice = toolChoiceFor(request);
      const params: Responses.ResponseCreateParamsStreaming = {
        model: request.model?.modelId ?? options.defaultModel,
        input: inputFor(request),
        stream: true,
        ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
        ...(tools === undefined ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      };
      let completed: Responses.Response | undefined;
      let stop: ModelResponse['stop'] | undefined;
      let toolCalls = 0;
      const argumentDeltas = new Map<string, string>();
      try {
        const stream = await client.responses.create(params, { signal: context.signal });
        for await (const event of stream) {
          switch (event.type) {
            case 'response.output_text.delta':
              if (event.delta.length > 0) await emit(context.emit, { type: 'text', text: event.delta });
              break;
            case 'response.function_call_arguments.delta':
              argumentDeltas.set(event.item_id, `${argumentDeltas.get(event.item_id) ?? ''}${event.delta}`);
              break;
            case 'response.output_item.done':
              if (event.item.type === 'function_call') {
                const streamed = event.item.id === undefined ? undefined : argumentDeltas.get(event.item.id);
                const encoded = event.item.arguments || streamed || '';
                await emit(context.emit, {
                  type: 'tool-call',
                  id: event.item.call_id,
                  name: event.item.name,
                  input: parseArguments(encoded),
                });
                toolCalls += 1;
              }
              break;
            case 'response.completed':
              completed = event.response;
              stop = toolCalls > 0 ? 'tool' : 'complete';
              break;
            case 'response.incomplete':
              completed = event.response;
              stop = event.response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error';
              break;
            case 'response.failed':
            case 'error':
              throw providerFailure('safe', event.type);
          }
        }
      } catch (error) {
        if (context.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        if (error instanceof RuntimeFailure) throw error;
        const status = error instanceof OpenAI.APIError ? error.status : undefined;
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        throw providerFailure(retryable ? 'safe' : 'unsafe', status === undefined ? 'network' : `http:${status}`);
      }
      if (context.signal.aborted) {
        return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      if (!completed || stop === undefined) {
        throw new RuntimeFailure('adapter-translation', 'OpenAI Responses stream ended without a terminal event');
      }
      return { stop, usage: translatedUsage(completed.usage) };
    },
  };
}
