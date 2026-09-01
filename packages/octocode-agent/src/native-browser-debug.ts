import {
  RuntimeFailure,
  createEffectSet,
  jsonSchemaError,
  type JsonSchema,
  type ToolDefinition,
  type ToolRegistry,
} from '@octocodeai/agent-core';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 5 * 1024 * 1024;
const MAX_TARGETS = 100;

export interface NativeBrowserTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface NativeBrowserDebugPort {
  listTargets(endpoint: string, signal: AbortSignal): Promise<readonly NativeBrowserTarget[]>;
  command(endpoint: string, targetId: string, method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  observe(endpoint: string, targetId: string, methods: readonly string[], observeMs: number, signal: AbortSignal): Promise<readonly unknown[]>;
}

export interface NativeBrowserDebugOptions {
  readonly port?: NativeBrowserDebugPort;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly maxResultBytes?: number;
}

type BrowserInput =
  | { action: 'targets'; endpoint?: string }
  | { action: 'snapshot' | 'screenshot'; endpoint?: string; targetId: string }
  | { action: 'console' | 'network'; endpoint?: string; targetId: string; observeMs?: number };

const ENDPOINT_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
const TARGET_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 };
function actionSchema(action: BrowserInput['action'], extra: Readonly<Record<string, JsonSchema>> = {}, required: readonly string[] = []): JsonSchema {
  return {
    type: 'object',
    properties: { action: { const: action }, endpoint: ENDPOINT_SCHEMA, ...extra },
    required: ['action', ...required],
    additionalProperties: false,
  };
}
export const NATIVE_BROWSER_DEBUG_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    actionSchema('targets'),
    actionSchema('snapshot', { targetId: TARGET_SCHEMA }, ['targetId']),
    actionSchema('screenshot', { targetId: TARGET_SCHEMA }, ['targetId']),
    actionSchema('console', { targetId: TARGET_SCHEMA, observeMs: { type: 'integer', minimum: 10, maximum: 5_000 } }, ['targetId']),
    actionSchema('network', { targetId: TARGET_SCHEMA, observeMs: { type: 'integer', minimum: 10, maximum: 5_000 } }, ['targetId']),
  ],
};

function endpointOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
    || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new RuntimeFailure('validation', 'Browser debugging endpoint must be a credential-free loopback HTTP origin');
  }
  return new URL(url.origin);
}

function publicPageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Chrome DevTools discovery returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Chrome DevTools discovery exceeded its byte limit');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Chrome DevTools discovery exceeded its byte limit');
    }
    chunks.push(item.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseTargets(value: unknown, endpoint: URL): NativeBrowserTarget[] {
  if (!Array.isArray(value)) throw new Error('Chrome DevTools target discovery returned invalid JSON');
  return value.slice(0, MAX_TARGETS).map((candidate): NativeBrowserTarget | undefined => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined;
    const item = candidate as Record<string, unknown>;
    if (!['id', 'type', 'title', 'url', 'webSocketDebuggerUrl'].every((key) => typeof item[key] === 'string')) return undefined;
    const socket = new URL(item.webSocketDebuggerUrl as string);
    if (!['ws:', 'wss:'].includes(socket.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(socket.hostname)
      || socket.port !== endpoint.port || socket.username || socket.password) return undefined;
    return item as unknown as NativeBrowserTarget;
  }).filter((target): target is NativeBrowserTarget => target !== undefined);
}

interface CdpSession {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  events: unknown[];
  close(): void;
}

async function openSession(socketUrl: string, signal: AbortSignal, timeoutMs: number): Promise<CdpSession> {
  const socket = new WebSocket(socketUrl);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const events: unknown[] = [];
  let nextId = 1;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome DevTools websocket timed out')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools websocket failed')); }, { once: true });
    signal.addEventListener('abort', () => { clearTimeout(timer); socket.close(); reject(new RuntimeFailure('cancelled', 'Browser debugging cancelled')); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    try {
      const value = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof value.id === 'number') {
        const waiter = pending.get(value.id);
        if (!waiter) return;
        pending.delete(value.id);
        if (value.error) waiter.reject(new Error('Chrome DevTools command failed'));
        else waiter.resolve(value.result);
      } else if (typeof value.method === 'string' && events.length < 1_000) events.push(value);
    } catch {
      // Ignore malformed remote frames; pending commands remain bounded by their timeout.
    }
  });
  return {
    events,
    send(method, params = {}) {
      if (signal.aborted) return Promise.reject(new RuntimeFailure('cancelled', 'Browser debugging cancelled'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Chrome DevTools command timed out'));
        }, timeoutMs);
        pending.set(id, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

export function createNodeNativeBrowserDebugPort(options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}): NativeBrowserDebugPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targets = async (rawEndpoint: string, signal: AbortSignal) => {
    const endpoint = endpointOrigin(rawEndpoint);
    const response = await fetcher(new URL('/json/list', endpoint), { signal, redirect: 'error', credentials: 'omit' });
    return parseTargets(JSON.parse(await boundedResponseText(response, 1024 * 1024)) as unknown, endpoint);
  };
  const target = async (endpoint: string, targetId: string, signal: AbortSignal) => {
    const match = (await targets(endpoint, signal)).find((candidate) => candidate.id === targetId);
    if (!match) throw new Error('Chrome DevTools target was not found');
    return match;
  };
  return {
    listTargets: targets,
    async command(endpoint, targetId, method, params, signal) {
      const match = await target(endpoint, targetId, signal);
      const session = await openSession(match.webSocketDebuggerUrl, signal, timeoutMs);
      try { return await session.send(method, params); } finally { session.close(); }
    },
    async observe(endpoint, targetId, methods, observeMs, signal) {
      const match = await target(endpoint, targetId, signal);
      const session = await openSession(match.webSocketDebuggerUrl, signal, timeoutMs);
      try {
        if (methods.some((method) => method.startsWith('Runtime.'))) await session.send('Runtime.enable');
        if (methods.some((method) => method.startsWith('Log.'))) await session.send('Log.enable');
        if (methods.some((method) => method.startsWith('Network.'))) await session.send('Network.enable');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, observeMs);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new RuntimeFailure('cancelled', 'Browser debugging cancelled')); }, { once: true });
        });
        return session.events.filter((event) => {
          const method = typeof event === 'object' && event !== null ? (event as Record<string, unknown>).method : undefined;
          return typeof method === 'string' && methods.includes(method);
        });
      } finally { session.close(); }
    },
  };
}

function assertBounded(value: unknown, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new RuntimeFailure('tool-execution', 'Browser diagnostic result exceeded its byte limit');
}

export function createNativeBrowserDebugTool(options: NativeBrowserDebugOptions = {}): ToolDefinition {
  const endpoint = endpointOrigin(options.endpoint ?? DEFAULT_ENDPOINT).origin;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! >= 100 && options.timeoutMs! <= 60_000 ? options.timeoutMs! : DEFAULT_TIMEOUT_MS;
  const maxResultBytes = Number.isSafeInteger(options.maxResultBytes) && options.maxResultBytes! >= 256 && options.maxResultBytes! <= 10 * 1024 * 1024
    ? options.maxResultBytes! : DEFAULT_MAX_RESULT_BYTES;
  const port = options.port ?? createNodeNativeBrowserDebugPort({ timeoutMs });
  return {
    name: 'browserDebug',
    label: 'Browser Debug',
    description: 'Inspect an explicitly approved local Chrome DevTools session with fixed, read-only target, DOM snapshot, screenshot, console, and network diagnostics.',
    schemaVersion: 1,
    inputSchema: NATIVE_BROWSER_DEBUG_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: {
      effects: createEffectSet('read', 'network'),
      trust: 'workspace', approval: 'on-request', plan: 'allowed',
      concurrency: () => ({ lane: 'native-browser-debug', maxActive: 1 }),
    },
    async execute(request) {
      const invalid = jsonSchemaError(request.input, NATIVE_BROWSER_DEBUG_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = request.input as BrowserInput;
      const selectedEndpoint = endpointOrigin(input.endpoint ?? endpoint).origin;
      let content: unknown;
      if (input.action === 'targets') {
        const targets = await port.listTargets(selectedEndpoint, request.signal);
        content = {
          action: 'targets',
          targets: targets.slice(0, MAX_TARGETS).map(({ id, type, title, url }) => ({ id, type, title: title.slice(0, 512), url: publicPageUrl(url) })),
        };
      } else if (input.action === 'snapshot') {
        content = { action: 'snapshot', targetId: input.targetId, snapshot: await port.command(selectedEndpoint, input.targetId, 'DOMSnapshot.captureSnapshot', { computedStyles: [], includePaintOrder: false, includeDOMRects: false }, request.signal) };
      } else if (input.action === 'screenshot') {
        const result = await port.command(selectedEndpoint, input.targetId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, request.signal) as Record<string, unknown>;
        content = { action: 'screenshot', targetId: input.targetId, mediaType: 'image/png', data: typeof result?.data === 'string' ? result.data : '' };
      } else if (input.action === 'console' || input.action === 'network') {
        const methods = input.action === 'console'
          ? ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']
          : ['Network.responseReceived', 'Network.loadingFailed'];
        content = { action: input.action, targetId: input.targetId, events: await port.observe(selectedEndpoint, input.targetId, methods, input.observeMs ?? 250, request.signal) };
      } else {
        throw new RuntimeFailure('validation', 'Unsupported browser diagnostic action');
      }
      assertBounded(content, maxResultBytes);
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeBrowserDebugTool(registry: ToolRegistry, options: NativeBrowserDebugOptions = {}): ToolDefinition {
  const tool = createNativeBrowserDebugTool(options);
  registry.register(tool, 'native-browser-debug');
  return tool;
}
