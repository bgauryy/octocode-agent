import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runNativeProviderSmokeMatrix,
  type NativeProviderProtocol,
} from '../src/native-provider-smoke.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function fixtureFrames(pathname: string): string {
  if (pathname.endsWith('/messages')) {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  }
  if (pathname.endsWith('/chat/completions')) {
    return [
      { choices: [{ delta: { content: 'OK' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  }
  const response = {
    id: 'resp_fixture', object: 'response', created_at: 0, status: 'completed', error: null,
    incomplete_details: null, instructions: null, max_output_tokens: null, model: 'fixture', output: [],
    parallel_tool_calls: true, previous_response_id: null, reasoning: null, store: false, temperature: null,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: null, truncation: 'disabled',
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
    user: null, metadata: {},
  };
  return [
    { type: 'response.output_text.delta', sequence_number: 1, item_id: 'item', output_index: 0, content_index: 0, delta: 'OK', logprobs: [] },
    { type: 'response.completed', sequence_number: 2, response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('native provider protocol smoke', () => {
  it('runs every supported production protocol through a real loopback streaming server', async () => {
    const requests: Array<{ path: string; authorization?: string; anthropicKey?: string; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push({
          path: request.url ?? '',
          ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
          ...(request.headers['x-api-key'] === undefined ? {} : { anthropicKey: String(request.headers['x-api-key']) }),
          body: JSON.parse(body),
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(fixtureFrames(request.url ?? ''));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server address unavailable');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const protocols: readonly NativeProviderProtocol[] = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];

    const result = await runNativeProviderSmokeMatrix(protocols.map((protocol) => ({
      protocol, endpoint, apiKey: 'fixture-key', model: 'fixture-model',
    })));

    expect(result).toEqual({
      status: 'PASS', credentialDependent: [],
      results: protocols.map((protocol) => ({ status: 'PASS', protocol, stop: 'complete' })),
    });
    expect(requests.map(({ path }) => path).sort()).toEqual(['/v1/chat/completions', '/v1/messages', '/v1/responses']);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/v1/messages', anthropicKey: 'fixture-key', body: expect.objectContaining({ stream: true }) }),
      expect.objectContaining({ path: '/v1/chat/completions', authorization: 'Bearer fixture-key', body: expect.objectContaining({ stream: true }) }),
      expect.objectContaining({ path: '/v1/responses', authorization: 'Bearer fixture-key', body: expect.objectContaining({ stream: true }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('reports credential-dependent protocols separately without attempting transport', async () => {
    await expect(runNativeProviderSmokeMatrix([
      { protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', apiKey: '', model: 'fixture' },
      { protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'fixture' },
    ])).resolves.toEqual({
      status: 'SKIP', credentialDependent: ['anthropic-messages', 'openai-responses'],
      results: [
        { status: 'SKIP', capability: 'credentials-absent', protocol: 'anthropic-messages' },
        { status: 'SKIP', capability: 'credentials-absent', protocol: 'openai-responses' },
      ],
    });
  });
});
