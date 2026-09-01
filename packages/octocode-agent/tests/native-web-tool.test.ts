import { describe, expect, it, vi } from 'vitest';
import { jsonSchemaError, sessionId, type ToolExecutionInput } from '@octocodeai/agent-core';
import {
  createNativeWebTool,
  isBlockedWebIp,
  type NativeWebFetch,
  type NativeWebLookup,
} from '../src/native-web-tool.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const lookup: NativeWebLookup = vi.fn(async () => PUBLIC);

function request(input: unknown, signal = new AbortController().signal): ToolExecutionInput {
  return {
    input,
    callId: 'web-call' as never,
    context: {
      sessionId: sessionId('web-session'), cwd: '/workspace', mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false }, signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe('native web tool', () => {
  it('publishes strict exclusive single and bounded batch schemas', () => {
    const tool = createNativeWebTool({ lookup, fetch: vi.fn() });
    expect(tool.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(jsonSchemaError({ url: 'https://example.com', query: 'x' }, tool.inputSchema)).toMatch(/exactly one schema/i);
    expect(jsonSchemaError({ url: 'https://example.com', extra: true }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ queries: [] }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ queries: Array.from({ length: 9 }, () => ({ query: 'x' })) }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ query: 'x' }, tool.inputSchema)).toBeUndefined();
    expect(jsonSchemaError({ queries: [{ url: 'https://example.com' }, { query: 'x' }] }, tool.inputSchema)).toBeUndefined();
  });

  it('blocks private, link-local, metadata, and embedded IPv4 destinations', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe']) {
      expect(isBlockedWebIp(ip)).toBe(true);
    }
    const fetch = vi.fn<NativeWebFetch>();
    for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1']) {
      const tool = createNativeWebTool({ fetch, lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await expect(tool.execute(request({ url: 'https://blocked.example' }))).rejects.toThrow(/blocked/i);
    }
    await expect(createNativeWebTool({ fetch, lookup }).execute(request({ url: 'ftp://example.com/x' }))).rejects.toThrow(/http/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('revalidates redirects and fails closed when connect-time DNS rebinds private', async () => {
    const answers = [PUBLIC, PUBLIC, PUBLIC, [{ address: '127.0.0.1', family: 4 }]];
    const rebindingLookup: NativeWebLookup = vi.fn(async () => answers.shift() ?? PUBLIC);
    const fetch = vi.fn<NativeWebFetch>(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://redirect.example/private' },
    }));
    const tool = createNativeWebTool({ lookup: rebindingLookup, fetch });

    await expect(tool.execute(request({ url: 'https://public.example' }))).rejects.toThrow(/blocked/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rebindingLookup).toHaveBeenCalledTimes(4);
  });

  it('caps bytes, strips active HTML, and returns bounded sanitized text', async () => {
    const body = `<html><title>Safe title</title><script>SECRET_SCRIPT</script><body>${'é'.repeat(200)}</body></html>`;
    const fetch = vi.fn<NativeWebFetch>(async () => new Response(body, { headers: { 'content-type': 'text/html' } }));
    const tool = createNativeWebTool({ lookup, fetch, maxResponseBytes: 96, maxTextChars: 80 });
    const result = await tool.execute(request({ url: 'https://example.com' }));
    const rendered = JSON.stringify(result.content);

    expect(result.content).toMatchObject({ kind: 'fetch', title: 'Safe title', truncated: true });
    expect(rendered).not.toContain('SECRET_SCRIPT');
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThan(1_000);
  });

  it.each([
    ['text/plain', 'abcdefghij'],
    ['text/html', '<html><body>abcdefghij</body></html>'],
  ])('honors per-request maxChars for %s and reports truncation from the unsliced text', async (contentType, body) => {
    const tool = createNativeWebTool({
      lookup,
      fetch: async () => new Response(body, { headers: { 'content-type': contentType } }),
      maxTextChars: 100,
    });

    const result = await tool.execute(request({ url: 'https://example.com', maxChars: 4 }));

    expect(result.content).toMatchObject({ kind: 'fetch', text: 'abcd', truncated: true });
  });

  it('returns sanitized keyless search results without credentials or non-HTTP links', async () => {
    const target = encodeURIComponent('https://user:password@example.com/result#secret');
    const html = [
      `<a class="result__a" href="/l/?uddg=${target}"><b>Safe result</b></a>`,
      '<a class="result__snippet">Useful <em>snippet</em></a>',
      '<a class="result__a" href="javascript:alert(1)">Unsafe result</a>',
      '<a class="result__snippet">Ignored</a>',
    ].join('');
    const tool = createNativeWebTool({
      lookup,
      fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    });
    const result = await tool.execute(request({ query: 'security research', maxResults: 5 }));
    const rendered = JSON.stringify(result.content);

    expect(result.content).toMatchObject({
      kind: 'search', engine: 'duckduckgo', query: 'security research',
      results: [{ title: 'Safe result', url: 'https://example.com/result', snippet: 'Useful snippet' }],
    });
    expect(rendered).not.toMatch(/password|secret|javascript/i);
  });

  it('enforces a whole-operation timeout and caller cancellation', async () => {
    const waitingFetch: NativeWebFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const timed = createNativeWebTool({ lookup, fetch: waitingFetch, timeoutMs: 5 });
    await expect(timed.execute(request({ url: 'https://example.com' }))).rejects.toThrow(/timed out/i);

    const controller = new AbortController();
    const cancelled = createNativeWebTool({ lookup, fetch: waitingFetch, timeoutMs: 1_000 });
    const execution = cancelled.execute(request({ url: 'https://example.com' }, controller.signal));
    controller.abort();
    await expect(execution).rejects.toThrow(/cancelled/i);
  });

  it('bounds batch network work to four concurrent operations', async () => {
    let active = 0;
    let maximum = 0;
    const fetch: NativeWebFetch = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    };
    const tool = createNativeWebTool({ lookup, fetch });
    const result = await tool.execute(request({
      queries: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/${index}` })),
    }));

    expect(result.content).toMatchObject({ kind: 'batch', results: expect.any(Array) });
    expect((result.content as { results: unknown[] }).results).toHaveLength(8);
    expect(maximum).toBe(4);
    expect(tool.policy).toMatchObject({ effects: ['network'], trust: 'none', approval: 'never' });
    expect(tool.policy.concurrency?.({})).toEqual({ lane: 'native-web', maxActive: 4 });
  });

  it('shares one four-wide network admission pool across concurrent tool executions', async () => {
    let active = 0;
    let maximum = 0;
    const fetch: NativeWebFetch = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    };
    const tool = createNativeWebTool({ lookup, fetch });
    const batch = (prefix: string) => request({
      queries: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/${prefix}/${index}` })),
    });

    await Promise.all([tool.execute(batch('first')), tool.execute(batch('second'))]);

    expect(maximum).toBe(4);
  });

  it('cancels a queued network operation without admitting it', async () => {
    let started = 0;
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saturated = new Promise<void>((resolve) => { ready = resolve; });
    const fetch: NativeWebFetch = async () => {
      started += 1;
      if (started === 4) ready();
      await gate;
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    };
    const tool = createNativeWebTool({ lookup, fetch });
    const occupying = tool.execute(request({
      queries: Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/occupying/${index}` })),
    }));
    await saturated;
    const controller = new AbortController();
    const queued = tool.execute(request({ url: 'https://example.com/queued' }, controller.signal));

    controller.abort();
    await expect(queued).rejects.toThrow(/cancelled/i);
    expect(started).toBe(4);
    release();
    await occupying;
  });
});
