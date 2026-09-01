import dns from 'node:dns/promises';
import net from 'node:net';
import {
  RuntimeFailure,
  createEffectSet,
  jsonSchemaError,
  type JsonSchema,
  type ToolDefinition,
  type ToolRegistry,
} from '@octocodeai/agent-core';

export type NativeWebLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }> | { address: string; family: number }>;
export type NativeWebFetch = (
  url: string,
  init: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

export interface NativeWebToolOptions {
  readonly lookup?: NativeWebLookup;
  readonly fetch?: NativeWebFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxResponseBytes?: number;
  readonly maxTextChars?: number;
}

type WebOperation =
  | { readonly url: string; readonly maxChars?: number }
  | { readonly query: string; readonly maxResults?: number };

const MAX_BATCH = 8;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 15_000;
const USER_AGENT = 'Octocode-Agent/1.0 (+https://octocode.ai)';

const urlOperation: JsonSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 4096 },
    maxChars: { type: 'integer', minimum: 1, maximum: 50_000 },
  },
  required: ['url'],
  additionalProperties: false,
};
const searchOperation: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    maxResults: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['query'],
  additionalProperties: false,
};
export const NATIVE_WEB_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    urlOperation,
    searchOperation,
    {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          items: { oneOf: [urlOperation, searchOperation] },
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
  ],
};

const V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return null;
  return (((values[0]! << 24) >>> 0) + (values[1]! << 16) + (values[2]! << 8) + values[3]!) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(ip);
  const network = ipv4ToInt(base);
  if (value === null || network === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function expandIpv6(ip: string): number[] | null {
  let value = ip.toLowerCase();
  const dotted = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]!);
    if (v4 === null) return null;
    value = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => /^[0-9a-f]{1,4}$/.test(group || '0') ? Number.parseInt(group || '0', 16) : Number.NaN);
  return parsed.some(Number.isNaN) ? null : parsed;
}

function embeddedIpv4(groups: number[]): string | null {
  const dotted = (left: number, right: number) => `${left >>> 8}.${left & 255}.${right >>> 8}.${right & 255}`;
  const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  if (zeroPrefix && (groups[5] === 0 || groups[5] === 0xffff)) return dotted(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
    return dotted(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return dotted(groups[1]!, groups[2]!);
  return null;
}

export function isBlockedWebIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return V4_BLOCKS.some(([base, bits]) => inV4(ip, base, bits));
  if (version !== 6) return true;
  const groups = expandIpv6(ip);
  if (groups === null) return true;
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return isBlockedWebIp(embedded);
  const first = groups[0]!;
  return groups.every((group) => group === 0)
    || groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (groups[0] === 0x2001 && groups[1] === 0x0db8);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function assertPublicUrl(value: string, lookup: NativeWebLookup, signal: AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RuntimeFailure('validation', 'Invalid web URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new RuntimeFailure('validation', 'Web URLs must use HTTP(S)');
  if (url.username || url.password) throw new RuntimeFailure('validation', 'Web URLs cannot contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedWebIp(hostname)) throw new RuntimeFailure('approval', 'Blocked private or non-public web address');
    return url;
  }
  let records: Awaited<ReturnType<NativeWebLookup>>;
  try { records = await abortable(lookup(hostname, { all: true }), signal); }
  catch { throw new RuntimeFailure('tool-execution', 'Web host resolution failed'); }
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0 || list.some(({ address }) => isBlockedWebIp(address)))
    throw new RuntimeFailure('approval', 'Blocked private or non-public web address');
  return url;
}

function abortFailure(caller: AbortSignal, timedOut: boolean): RuntimeFailure {
  return caller.aborted
    ? new RuntimeFailure('cancelled', 'Web request cancelled')
    : timedOut
      ? new RuntimeFailure('timeout', 'Web request timed out')
      : new RuntimeFailure('tool-execution', 'Web request aborted');
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  for (;;) {
    const next = await Promise.race([reader.read(), aborted]);
    if (next.done) break;
    if (!next.value) continue;
    const remaining = maxBytes - total;
    if (next.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(next.value);
    total += next.value.byteLength;
    if (total === maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: bytes.toString('utf8'), truncated };
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:nbsp|#160);/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function normalizedText(value: string): string {
  return decodeEntities(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function cleanText(value: string, maxChars: number): string {
  return normalizedText(value).slice(0, maxChars);
}

function htmlText(html: string, maxChars: number): { title: string; text: string; truncated: boolean } {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', 512);
  const text = normalizedText(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|aside|footer)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  return { title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

async function productionDispatcher(lookup: NativeWebLookup): Promise<{ dispatcher: unknown; close(): Promise<void> }> {
  const { Agent } = await import('undici');
  const agent = new Agent({ connect: { lookup: (hostname: string, _options: unknown, callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void) => {
    lookup(hostname, { all: true }).then((records) => {
      const list = Array.isArray(records) ? records : [records];
      if (list.length === 0 || list.some(({ address }) => isBlockedWebIp(address)))
        callback(new Error('Blocked private or non-public web address'), []);
      else callback(null, list);
    }).catch((error: Error) => callback(error, []));
  } } });
  return { dispatcher: agent, close: () => agent.close() };
}

async function fetchOperation(
  operation: WebOperation,
  options: Required<Pick<NativeWebToolOptions, 'timeoutMs' | 'maxRedirects' | 'maxResponseBytes' | 'maxTextChars'>> & {
    lookup: NativeWebLookup;
    fetch: NativeWebFetch;
    injectedFetch: boolean;
  },
  callerSignal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  const cancel = () => controller.abort();
  if (callerSignal.aborted) controller.abort();
  else callerSignal.addEventListener('abort', cancel, { once: true });
  let pinned: Awaited<ReturnType<typeof productionDispatcher>> | undefined;
  try {
    pinned = options.injectedFetch ? undefined : await productionDispatcher(options.lookup);
    const target = 'url' in operation
      ? operation.url
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(operation.query)}`;
    let current = target;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
      const admitted = await assertPublicUrl(current, options.lookup, controller.signal);
      await assertPublicUrl(admitted.toString(), options.lookup, controller.signal);
      if (controller.signal.aborted) throw abortFailure(callerSignal, timedOut);
      try {
        response = await options.fetch(admitted.toString(), {
          redirect: 'manual', signal: controller.signal,
          headers: { accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1', 'user-agent': USER_AGENT },
          ...(pinned === undefined ? {} : { dispatcher: pinned.dispatcher }),
        });
      } catch (error) {
        if (controller.signal.aborted) throw abortFailure(callerSignal, timedOut);
        throw error;
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (location === null) break;
      current = new URL(location, admitted).toString();
      response = undefined;
    }
    if (response === undefined) throw new RuntimeFailure('tool-execution', 'Web redirect limit exceeded');
    if (!response.ok) throw new RuntimeFailure('tool-execution', `Web request failed with HTTP ${response.status}`);
    const capped = await readCapped(response, options.maxResponseBytes, controller.signal).catch((error) => {
      if (controller.signal.aborted) throw abortFailure(callerSignal, timedOut);
      throw error;
    });
    const contentType = response.headers.get('content-type') ?? '';
    const textLimit = 'url' in operation
      ? Math.min(operation.maxChars ?? options.maxTextChars, options.maxTextChars)
      : options.maxTextChars;
    const parsed = /html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(capped.text)
      ? htmlText(capped.text, textLimit)
      : (() => {
          const text = normalizedText(capped.text);
          return { title: '', text: text.slice(0, textLimit), truncated: text.length > textLimit };
        })();
    if ('url' in operation)
      return { kind: 'fetch', url: current, title: parsed.title, contentType, text: parsed.text, truncated: capped.truncated || parsed.truncated };
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const anchors = [...capped.text.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const snippets = [...capped.text.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (let index = 0; index < Math.min(operation.maxResults ?? 5, anchors.length); index += 1) {
      const raw = anchors[index]![1] ?? '';
      let url = raw;
      try {
        const wrapped = new URL(raw, 'https://duckduckgo.com');
        url = wrapped.searchParams.get('uddg') ?? wrapped.toString();
        const sanitized = new URL(url);
        if (sanitized.protocol !== 'http:' && sanitized.protocol !== 'https:') continue;
        sanitized.username = ''; sanitized.password = ''; sanitized.hash = '';
        url = sanitized.toString();
      } catch { continue; }
      results.push({ title: htmlText(anchors[index]![2] ?? '', 512).text, url, snippet: htmlText(snippets[index]?.[1] ?? '', 1_000).text });
    }
    return { kind: 'search', engine: 'duckduckgo', query: cleanText(operation.query, 500), results };
  } catch (error) {
    if (controller.signal.aborted) throw abortFailure(callerSignal, timedOut);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener('abort', cancel);
    await pinned?.close().catch(() => undefined);
  }
}

async function mapBounded<T, R>(items: readonly T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!);
    }
  }));
  return results;
}

function createAdmissionPool(limit: number) {
  let active = 0;
  const waiters: Array<{
    readonly signal: AbortSignal;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly cancelled: () => RuntimeFailure;
    readonly onAbort: () => void;
  }> = [];
  const admit = (): void => {
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.cancelled());
        continue;
      }
      active += 1;
      waiter.resolve();
    }
  };
  return async <T>(signal: AbortSignal, cancelled: () => RuntimeFailure, operation: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }
      const waiter = {
        signal,
        resolve,
        reject,
        cancelled,
        onAbort: () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(cancelled());
        },
      };
      waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      admit();
    });
    try {
      if (signal.aborted) throw cancelled();
      return await operation();
    } finally {
      active -= 1;
      admit();
    }
  };
}

export function createNativeWebTool(options: NativeWebToolOptions = {}): ToolDefinition {
  const lookup = options.lookup ?? (dns.lookup as unknown as NativeWebLookup);
  const fetch = options.fetch ?? (globalThis.fetch as NativeWebFetch);
  const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
  const configured = {
    lookup, fetch, injectedFetch: options.fetch !== undefined,
    timeoutMs: bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60_000),
    maxRedirects: bounded(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 10),
    maxResponseBytes: bounded(options.maxResponseBytes, DEFAULT_MAX_BYTES, 1, 10_000_000),
    maxTextChars: bounded(options.maxTextChars, DEFAULT_MAX_CHARS, 1, 50_000),
  };
  const admitted = createAdmissionPool(4);
  const runOperation = (operation: WebOperation, signal: AbortSignal) => admitted(
    signal,
    () => new RuntimeFailure('cancelled', 'Web request cancelled'),
    () => fetchOperation(operation, configured, signal),
  );
  return {
    name: 'web', label: 'Web', description: 'Fetch public HTTP(S) pages or search the public web with bounded, SSRF-safe requests.', schemaVersion: 1,
    inputSchema: NATIVE_WEB_INPUT_SCHEMA,
    outputSchema: { type: 'object' }, outputVersion: 1,
    policy: { effects: createEffectSet('network'), trust: 'none', approval: 'never', plan: 'allowed', concurrency: () => ({ lane: 'native-web', maxActive: 4 }) },
    async execute(request) {
      const invalid = jsonSchemaError(request.input, NATIVE_WEB_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = request.input as WebOperation | { queries: WebOperation[] };
      const content = 'queries' in input
        ? { kind: 'batch', results: await mapBounded(input.queries, 4, (item) => runOperation(item, request.signal)) }
        : await runOperation(input, request.signal);
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeWebTool(registry: ToolRegistry, options: NativeWebToolOptions = {}): ToolDefinition {
  const tool = createNativeWebTool(options);
  registry.register(tool, 'native-web');
  return tool;
}
