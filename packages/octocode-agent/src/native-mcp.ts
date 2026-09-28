import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client, StreamableHTTPClientTransport, specTypeSchemas, type Progress, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { RuntimeFailure, createEffectSet, jsonSchemaError, type HookDecision, type JsonSchema, type ToolRegistry } from '@octocodeai/agent-core';
import { discoverMcpSystem, repositoryDirectories } from '@octocodeai/agent-contracts/agent-skills';
import { getOctocodeHome, workspaceAgentRoot } from '@octocodeai/agent-contracts/paths';
import type { NativeMcpOAuthFlow } from './native-mcp-oauth.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const SERVER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MCP_TASK_STORE_VERSION = 1;
const MCP_TASK_LOCK_ATTEMPTS = 100;
const MCP_TASK_LOCK_RETRY_MS = 5;
const MCP_TASK_LOCK_STALE_MS = 30_000;
const MCP_TASK_LOCK_MAX_BYTES = 4_096;

export interface NativeMcpServerConfig {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envRefs?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  headerRefs?: Record<string, string>;
  bearerTokenEnvVar?: string;
  oauth?: true;
  timeoutMs?: number;
  maxConcurrentCalls?: number;
  provenance?: { scope: 'global' | 'workspace'; file: string; discoveryOrder: number };
  defaultEnabled?: boolean;
  discovered?: { host: string; scope: 'project' | 'user'; path: string; originalName: string };
}

export interface NativeMcpClient {
  listTools(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ tools?: Array<Record<string, unknown>>; nextCursor?: string; ttlMs?: number }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: NativeMcpRequestOptions): Promise<unknown>;
  listResources(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ resources?: Array<Record<string, unknown>>; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: NativeMcpRequestOptions): Promise<unknown>;
  listPrompts(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ prompts?: Array<Record<string, unknown>>; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: NativeMcpRequestOptions): Promise<unknown>;
  complete(params: { ref: Record<string, unknown>; argument: { name: string; value: string } }, options?: NativeMcpRequestOptions): Promise<unknown>;
  /** Send a negotiated MCP request. The production client applies its official era-specific result schema. */
  request(
    request: {
      method: 'tasks/get' | 'tasks/list' | 'tasks/result' | 'tasks/cancel';
      params?: { taskId?: string; cursor?: string };
    },
    resultSchema: unknown,
    options?: NativeMcpRequestOptions,
  ): Promise<unknown>;
  getServerCapabilities?(): { tools?: { listChanged?: boolean }; elicitation?: Record<string, unknown>; tasks?: Record<string, unknown> } | undefined;
  setNotificationHandler?(method: 'notifications/tools/list_changed', handler: () => void | Promise<void>): void;
  setRequestHandler?(method: 'elicitation/create', handler: (request: { params: Record<string, unknown> }, extra?: { signal?: AbortSignal }) => Promise<NativeMcpElicitationResult>): void;
  onclose?: () => void;
  close(): Promise<void>;
}

interface NativeMcpRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly onprogress?: (progress: Progress) => void;
}

export interface NativeMcpOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  octocodeHome?: string;
  connect?: (name: string, config: NativeMcpServerConfig, signal: AbortSignal) => Promise<NativeMcpClient>;
  isEnabled?: (server: string, tool?: string, defaultEnabled?: boolean) => boolean;
  catalogTtlMs?: number;
  now?: () => number;
  onCatalogInvalidated?: (notification: NativeMcpCatalogInvalidatedNotification) => void | Promise<void>;
  elicit?: (request: NativeMcpElicitationRequest) => Promise<NativeMcpElicitationResult>;
  taskStoreFile?: string;
  maxStoredTasks?: number;
  oauth?: {
    createFlow(input: { serverName: string; serverUrl: string }): Promise<NativeMcpOAuthFlow>;
    status(input: { serverName: string; serverUrl: string }): Promise<{ state: 'authorization-required' | 'connected'; credentialConfigured: boolean }>;
    revoke(input: { serverName: string; serverUrl: string }): Promise<void>;
  };
}

export interface NativeMcpCatalogInvalidatedNotification {
  readonly schemaVersion: 1;
  readonly kind: 'mcp.catalog-invalidated';
  readonly severity: 'info';
  readonly server: string;
  readonly message: string;
}

export interface NativeMcpLiveSnapshot {
  readonly connectionState: 'disconnected' | 'connecting' | 'connected';
  readonly catalogState: 'not-loaded' | 'ready' | 'stale' | 'empty';
  readonly lastRefreshAt?: number;
  readonly knownCatalogNames: readonly string[];
  readonly knownCatalogCount: number;
  readonly knownCatalogNamesTruncated: boolean;
}

export interface NativeMcpElicitationRequest {
  readonly server: string;
  readonly message: string;
  readonly mode: 'form' | 'url';
  readonly requestedSchema?: Readonly<Record<string, unknown>>;
  readonly url?: string;
  readonly signal?: AbortSignal;
}

export interface NativeMcpElicitationResult {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Readonly<Record<string, unknown>>;
}

interface StoredMcpTask {
  readonly task: unknown;
  readonly provenance: { readonly server: string; readonly operation: 'get' | 'list' | 'result' | 'cancel'; readonly observedAt: number };
}

class McpTaskStoreCorruptionError extends Error {
  readonly code = 'MCP_TASK_STORE_CORRUPT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpTaskStoreCorruptionError';
  }
}

class McpTaskStoreConflictError extends Error {
  readonly code = 'MCP_TASK_STORE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'McpTaskStoreConflictError';
  }
}

export interface NativeMcpHookHandler {
  readonly server: string;
  readonly tool: string;
  readonly input?: unknown;
}

export interface NativeMcpHookResult {
  readonly decision: HookDecision;
  readonly output: unknown;
  readonly stderr: string;
}

const MAX_MCP_CATALOG_PAGES = 100;
const MAX_MCP_CATALOG_ITEMS = 1_000;
const MAX_MCP_CATALOG_ITEM_BYTES = 256 * 1024;
const MAX_MCP_TRANSPORT_BYTES = 1024 * 1024;
const MAX_MCP_CURSOR_BYTES = 8 * 1024;
const MAX_MCP_JSON_DEPTH = 64;
const MAX_MCP_JSON_NODES = 50_000;
const MAX_MCP_OBJECT_PROPERTIES = 2_000;
const MAX_MCP_PROGRESS_UPDATES = 256;
const MAX_MCP_PROGRESS_MESSAGE_BYTES = 4 * 1024;
const MAX_MCP_PROGRESS_BYTES = 16 * 1024;
const MAX_MCP_ELICITATION_BYTES = 64 * 1024;
const MAX_MCP_ELICITATION_URL_BYTES = 8 * 1024;
const MAX_MCP_TASK_ITEM_BYTES = 256 * 1024;
const DEFAULT_MCP_CATALOG_TTL_MS = 0;
const DEFAULT_MAX_STORED_TASKS = 100;
const SENSITIVE_KEY_RE = /(?:api[-_]?key|token|secret|password|authorization|cookie)/i;
const MAX_PARALLEL_MCP_CALLS = 8;

class McpPayloadBoundsError extends Error {
  readonly code = 'MCP_PAYLOAD_BOUNDS';

  constructor(message: string) {
    super(message);
    this.name = 'McpPayloadBoundsError';
  }
}

interface PermitWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

class McpPermitPool {
  readonly #waiters: PermitWaiter[] = [];
  #active = 0;

  constructor(readonly maximum: number) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try { return await operation(); }
    finally { this.release(); }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new RuntimeFailure('cancelled', 'MCP call cancelled'));
    if (this.#active < this.maximum) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PermitWaiter = {
        resolve, reject, signal,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new RuntimeFailure('cancelled', 'MCP call cancelled'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  private release(): void {
    for (;;) {
      const waiter = this.#waiters.shift();
      if (!waiter) {
        this.#active -= 1;
        return;
      }
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) continue;
      waiter.resolve();
      return;
    }
  }
}

type NativeMcpConnect = (name: string, config: NativeMcpServerConfig, signal: AbortSignal) => Promise<NativeMcpClient>;
type NativeMcpCatalog = { expiresAt: number; refreshedAt: number; tools: Array<Record<string, unknown>> };
type NativeMcpManagerOptions = {
  readonly now?: () => number;
  readonly onCatalogInvalidated?: NativeMcpOptions['onCatalogInvalidated'];
};
const MAX_LIVE_MCP_CATALOG_NAMES = 100;

export class NativeMcpSessionManager {
  readonly #connections = new Map<string, Promise<NativeMcpClient>>();
  readonly #clients = new Map<string, NativeMcpClient>();
  readonly #retiredClients = new Set<NativeMcpClient>();
  readonly #connectionStates = new Map<string, 'connecting' | 'connected'>();
  readonly #catalogs = new Map<string, NativeMcpCatalog>();
  readonly #invalidatedCatalogs = new Set<string>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #taskWrites = Promise.resolve();
  #hookCall: ((handler: NativeMcpHookHandler, input: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<NativeMcpHookResult>) | undefined;
  readonly #now: () => number;

  constructor(
    private readonly connect: NativeMcpConnect,
    private readonly options: NativeMcpManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  async acquire(name: string, config: NativeMcpServerConfig, signal: AbortSignal): Promise<NativeMcpClient> {
    if (this.#closed) throw new Error('MCP session manager is closed');
    const existing = this.#connections.get(name);
    if (existing) return withMcpCancellation(existing, signal, `MCP connection cancelled for ${name}`);
    this.#connectionStates.set(name, 'connecting');
    const connection = this.connect(name, config, signal).then((client) => {
      this.#connectionStates.set(name, 'connected');
      this.#clients.set(name, client);
      const previousOnClose = client.onclose;
      client.onclose = () => {
        previousOnClose?.();
        if (this.#connections.get(name) !== connection) return;
        this.#connections.delete(name);
        this.#clients.delete(name);
        this.#connectionStates.delete(name);
        this.#invalidatedCatalogs.add(name);
      };
      if (client.getServerCapabilities?.()?.tools?.listChanged === true && client.setNotificationHandler) {
        client.setNotificationHandler('notifications/tools/list_changed', async () => {
          this.#invalidatedCatalogs.add(name);
          const notification: NativeMcpCatalogInvalidatedNotification = {
            schemaVersion: 1,
            kind: 'mcp.catalog-invalidated',
            severity: 'info',
            server: name,
            message: `MCP tool catalog changed · ${name} · refresh required`,
          };
          await Promise.resolve(this.options.onCatalogInvalidated?.(notification)).catch(() => undefined);
        });
      }
      return client;
    }).catch((error: unknown) => {
      if (this.#connections.get(name) === connection) this.#connections.delete(name);
      this.#clients.delete(name);
      this.#connectionStates.delete(name);
      throw error;
    });
    this.#connections.set(name, connection);
    return withMcpCancellation(connection, signal, `MCP connection cancelled for ${name}`);
  }

  evictFailedConnection(name: string, client: NativeMcpClient): void {
    if (this.#clients.get(name) !== client) return;
    this.#retiredClients.add(client);
    this.#clients.delete(name);
    this.#connections.delete(name);
    this.#connectionStates.delete(name);
    this.#invalidatedCatalogs.add(name);
  }

  catalog(name: string, now: number): Array<Record<string, unknown>> | undefined {
    if (this.#invalidatedCatalogs.has(name)) return undefined;
    const catalog = this.#catalogs.get(name);
    return catalog && catalog.expiresAt > now ? catalog.tools : undefined;
  }

  hasCatalog(name: string): boolean {
    return this.#catalogs.has(name);
  }

  catalogState(name: string, now: number): NativeMcpLiveSnapshot['catalogState'] {
    const catalog = this.#catalogs.get(name);
    if (!catalog) return this.#invalidatedCatalogs.has(name) ? 'stale' : 'not-loaded';
    if (this.#invalidatedCatalogs.has(name) || catalog.expiresAt <= now) return 'stale';
    return catalog.tools.length === 0 ? 'empty' : 'ready';
  }

  setCatalog(name: string, catalog: Omit<NativeMcpCatalog, 'refreshedAt'>): void {
    this.#catalogs.set(name, { ...catalog, refreshedAt: this.#now() });
    this.#invalidatedCatalogs.delete(name);
  }

  liveSnapshot(name: string, now = this.#now()): NativeMcpLiveSnapshot {
    const catalog = this.#catalogs.get(name);
    const names = catalog?.tools
      .map((tool) => tool.name)
      .filter((toolName): toolName is string => typeof toolName === 'string')
      .sort((left, right) => left.localeCompare(right)) ?? [];
    return {
      connectionState: this.#connectionStates.get(name) ?? 'disconnected',
      catalogState: this.catalogState(name, now),
      ...(catalog === undefined ? {} : { lastRefreshAt: catalog.refreshedAt }),
      knownCatalogNames: names.slice(0, MAX_LIVE_MCP_CATALOG_NAMES),
      knownCatalogCount: names.length,
      knownCatalogNamesTruncated: names.length > MAX_LIVE_MCP_CATALOG_NAMES,
    };
  }

  persistTask(file: string, entry: StoredMcpTask, maximum: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('MCP session manager is closed'));
    const write = this.#taskWrites.then(() => persistTask(file, entry, maximum));
    this.#taskWrites = write.catch(() => undefined);
    return write;
  }

  setHookCall(execute: (handler: NativeMcpHookHandler, input: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<NativeMcpHookResult>): void {
    if (this.#hookCall !== undefined) throw new Error('MCP hook executor is already configured');
    this.#hookCall = execute;
  }

  executeHook(handler: NativeMcpHookHandler, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<NativeMcpHookResult> {
    if (this.#closed) return Promise.reject(new Error('MCP session manager is closed'));
    if (!this.#hookCall) return Promise.reject(new Error('MCP hook executor is not configured'));
    return this.#hookCall(handler, input, signal);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#catalogs.clear();
    this.#invalidatedCatalogs.clear();
    this.#connectionStates.clear();
    this.#clients.clear();
    const connections = [...this.#connections.values()];
    const retiredClients = [...this.#retiredClients];
    this.#connections.clear();
    this.#retiredClients.clear();
    this.#closePromise = (async () => {
      await this.#taskWrites;
      const clients = await Promise.all(connections.map((connection) => connection.catch(() => undefined)));
      const uniqueClients = new Set([
        ...retiredClients,
        ...clients.filter((client): client is NativeMcpClient => client !== undefined),
      ]);
      await Promise.all([...uniqueClients].map((client) => client.close().catch(() => undefined)));
    })();
    return this.#closePromise;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfMcpAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new RuntimeFailure('cancelled', message);
}

function withMcpCancellation<T>(operation: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new RuntimeFailure('cancelled', message));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new RuntimeFailure('cancelled', message));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function boundedMcpValue(value: unknown, label: string, maximumBytes: number, redact = false): unknown {
  let nodes = 0;
  let approximateBytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (bytes: number): void => {
    approximateBytes += bytes;
    if (approximateBytes > maximumBytes) throw new McpPayloadBoundsError(`${label} exceeds the ${maximumBytes} byte limit`);
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_MCP_JSON_NODES) throw new McpPayloadBoundsError(`${label} exceeds the JSON node-count limit`);
    if (depth > MAX_MCP_JSON_DEPTH) throw new McpPayloadBoundsError(`${label} exceeds the JSON depth limit`);
    if (candidate === null) { addBytes(4); return null; }
    if (typeof candidate === 'string') { addBytes(Buffer.byteLength(candidate, 'utf8') + 2); return candidate; }
    if (typeof candidate === 'boolean') { addBytes(candidate ? 4 : 5); return candidate; }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
      addBytes(24);
      return candidate;
    }
    if (typeof candidate !== 'object') throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
    if (ancestors.has(candidate)) throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_MCP_JSON_NODES) throw new McpPayloadBoundsError(`${label} exceeds the JSON item-count limit`);
        addBytes(2 + candidate.length);
        return candidate.map((item) => visit(item, depth + 1));
      }
      if (!isRecord(candidate)) throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
      const entries = Object.entries(candidate);
      if (entries.length > MAX_MCP_OBJECT_PROPERTIES) throw new McpPayloadBoundsError(`${label} exceeds the object-property limit`);
      addBytes(2 + entries.length);
      const result: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        addBytes(Buffer.byteLength(key, 'utf8') + 3);
        result[key] = visit(item, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };
  const cloned = visit(value, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(cloned);
  } catch (error) {
    throw new McpPayloadBoundsError(`${label} is not valid bounded JSON`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new McpPayloadBoundsError(`${label} exceeds the ${maximumBytes} byte limit`);
  }
  return redact ? redactMcpValue(cloned) : cloned;
}

function boundedMcpRecord(value: unknown, label: string, maximumBytes: number, redact = false): Record<string, unknown> {
  const bounded = boundedMcpValue(value, label, maximumBytes, redact);
  if (!isRecord(bounded)) throw new McpPayloadBoundsError(`${label} must be a JSON object`);
  return bounded;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < value.length) {
    const previous = value.charCodeAt(low - 1);
    const next = value.charCodeAt(low);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) low -= 1;
  }
  return value.slice(0, low);
}

function boundedMcpProgress(value: unknown): Progress {
  if (!isRecord(value) || typeof value.progress !== 'number' || !Number.isFinite(value.progress)) {
    throw new McpPayloadBoundsError('MCP progress update is invalid');
  }
  const progress: Progress = {
    progress: value.progress,
    ...(typeof value.total === 'number' && Number.isFinite(value.total) ? { total: value.total } : {}),
    ...(typeof value.message === 'string' ? { message: truncateUtf8(value.message, MAX_MCP_PROGRESS_MESSAGE_BYTES) } : {}),
  };
  return boundedMcpValue(progress, 'MCP progress update', MAX_MCP_PROGRESS_BYTES) as Progress;
}

interface McpCatalogAccumulator {
  readonly items: Array<Record<string, unknown>>;
  encodedBytes: number;
}

function appendMcpCatalogItems(accumulator: McpCatalogAccumulator, value: unknown, family: 'tools' | 'resources' | 'prompts'): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new McpPayloadBoundsError(`MCP ${family} catalog items must be an array`);
  if (accumulator.items.length + value.length > MAX_MCP_CATALOG_ITEMS) {
    throw new McpPayloadBoundsError(`MCP ${family} catalog exceeds the item-count limit`);
  }
  for (const candidate of value) {
    const item = boundedMcpRecord(candidate, `MCP ${family} catalog item`, MAX_MCP_CATALOG_ITEM_BYTES);
    if (family === 'tools') {
      if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 256) {
        throw new McpPayloadBoundsError('MCP tools catalog item has an invalid name');
      }
      if (item.inputSchema !== undefined && !isRecord(item.inputSchema)) {
        throw new McpPayloadBoundsError('MCP tools catalog item has an invalid input schema');
      }
    }
    accumulator.encodedBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (accumulator.encodedBytes > MAX_MCP_TRANSPORT_BYTES) {
      throw new McpPayloadBoundsError(`MCP ${family} catalog exceeds the aggregate byte limit`);
    }
    accumulator.items.push(item);
  }
}

function boundedMcpCursor(value: unknown, family: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_MCP_CURSOR_BYTES) {
    throw new McpPayloadBoundsError(`MCP ${family} cursor is invalid or exceeds the byte limit`);
  }
  return value;
}

function redactMcpValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactMcpValue(item, seen),
  ]));
}

function canonicalPath(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const canonical = fs.realpathSync(current);
  return path.join(canonical, ...missing);
}

function containedFile(file: string, options: NativeMcpOptions): string {
  const resolved = canonicalPath(file);
  const roots = [canonicalPath(options.cwd), canonicalPath(options.octocodeHome ?? getOctocodeHome(options.env ?? process.env))];
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error('MCP task storage must stay within the workspace or Octocode home');
  }
  return resolved;
}

function isStoredMcpTask(value: unknown): value is StoredMcpTask {
  if (!isRecord(value) || !Object.hasOwn(value, 'task') || !isRecord(value.provenance)) return false;
  if (Object.keys(value).some((key) => key !== 'task' && key !== 'provenance')) return false;
  if (Object.keys(value.provenance).some((key) => !['server', 'operation', 'observedAt'].includes(key))) return false;
  const { server, operation, observedAt } = value.provenance;
  return typeof server === 'string'
    && SERVER_NAME_RE.test(server)
    && (operation === 'get' || operation === 'list' || operation === 'result' || operation === 'cancel')
    && typeof observedAt === 'number'
    && Number.isFinite(observedAt)
    && observedAt >= 0;
}

function boundedStoredMcpTask(value: unknown): StoredMcpTask {
  const entry = boundedMcpValue(value, 'MCP task entry', MAX_MCP_TASK_ITEM_BYTES);
  if (!isStoredMcpTask(entry)) throw new McpPayloadBoundsError('MCP task entry is not a valid JSON task record');
  return entry;
}

function readTaskStore(file: string): StoredMcpTask[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    throw new McpTaskStoreCorruptionError('MCP task state is not a bounded regular file');
  }
  try {
    const parsed = boundedMcpValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'MCP task state', MAX_CONFIG_BYTES);
    if (!isRecord(parsed)
      || Object.keys(parsed).some((key) => key !== 'version' && key !== 'tasks')
      || parsed.version !== MCP_TASK_STORE_VERSION
      || !Array.isArray(parsed.tasks)
      || parsed.tasks.length > 1_000
      || !parsed.tasks.every(isStoredMcpTask)) {
      throw new McpTaskStoreCorruptionError('MCP task state has an invalid versioned record');
    }
    return parsed.tasks;
  } catch (error) {
    if (error instanceof McpTaskStoreCorruptionError) throw error;
    if (error instanceof SyntaxError) {
      throw new McpTaskStoreCorruptionError('MCP task state contains invalid JSON', { cause: error });
    }
    throw error;
  }
}

function encodedTaskStore(tasks: readonly StoredMcpTask[]): string {
  const state = boundedMcpValue({ version: MCP_TASK_STORE_VERSION, tasks }, 'MCP task state', MAX_CONFIG_BYTES);
  const content = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new McpPayloadBoundsError('MCP task state exceeds the encoded byte limit');
  }
  return content;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function acquireTaskStoreLock(lockFile: string): Promise<void> {
  for (let attempt = 0; attempt < MCP_TASK_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomUUID() })}\n`);
        fs.fsyncSync(descriptor);
      } catch (error) {
        fs.closeSync(descriptor);
        try { fs.unlinkSync(lockFile); } catch { /* preserve the lock initialization error */ }
        throw error;
      }
      fs.closeSync(descriptor);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (tryRemoveStaleTaskStoreLock(lockFile)) {
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (attempt + 1 === MCP_TASK_LOCK_ATTEMPTS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, MCP_TASK_LOCK_RETRY_MS));
    }
  }
  throw new McpTaskStoreConflictError('MCP task state is busy; retry the operation');
}

interface McpTaskLockOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly nonce: string;
}

function parseTaskStoreLockOwner(content: string): McpTaskLockOwner | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || typeof value.nonce !== 'string' || value.nonce.length === 0 || value.nonce.length > 128) return undefined;
    return { pid: value.pid as number, createdAt: value.createdAt, nonce: value.nonce };
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function sameLockIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function tryRemoveStaleTaskStoreLock(lockFile: string): boolean {
  const before = fs.lstatSync(lockFile);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MCP_TASK_LOCK_MAX_BYTES) return false;
  if (Date.now() - before.mtimeMs <= MCP_TASK_LOCK_STALE_MS) return false;
  const content = fs.readFileSync(lockFile, 'utf8');
  const owner = parseTaskStoreLockOwner(content);
  if (owner !== undefined && processIsAlive(owner.pid)) return false;
  const after = fs.lstatSync(lockFile);
  if (!sameLockIdentity(before, after) || fs.readFileSync(lockFile, 'utf8') !== content) return false;
  fs.unlinkSync(lockFile);
  return true;
}

async function persistTask(file: string, entry: StoredMcpTask, maximum: number): Promise<void> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) {
    throw new McpPayloadBoundsError('MCP task maximum must be an integer from 1 through 1000');
  }
  const boundedEntry = boundedStoredMcpTask(entry);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  await acquireTaskStoreLock(lockFile);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const tasks = [...readTaskStore(file), boundedEntry].slice(-maximum);
    let content: string | undefined;
    while (content === undefined) {
      try {
        content = encodedTaskStore(tasks);
      } catch (error) {
        if (!(error instanceof McpPayloadBoundsError) || tasks.length <= 1) throw error;
        tasks.shift();
      }
    }
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    syncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { fs.unlinkSync(lockFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function hookOutput(content: unknown): unknown {
  if (!isRecord(content)) return content;
  if ('structuredContent' in content) return redactMcpValue(content.structuredContent);
  if (Array.isArray(content.content) && content.content.length === 1) {
    const block = content.content[0];
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (!text) return {};
      try { return redactMcpValue(JSON.parse(text)); }
      catch { return text; }
    }
  }
  return redactMcpValue(content);
}

function hookDecision(output: unknown): HookDecision {
  if (typeof output === 'string') return { kind: 'context', text: output };
  if (!isRecord(output)) return { kind: 'continue' };
  const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : undefined;
  if (specific?.permissionDecision === 'deny') return { kind: 'deny', reason: typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : 'Denied by MCP hook' };
  if (specific?.permissionDecision === 'allow') return { kind: 'allow' };
  if (output.continue === false) return { kind: 'stop', reason: typeof output.stopReason === 'string' ? output.stopReason : 'Stopped by MCP hook' };
  if (typeof output.systemMessage === 'string') return { kind: 'context', text: output.systemMessage };
  if (output.suppressOutput === true) return { kind: 'suppress' };
  return { kind: 'continue' };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) return undefined;
  return value as Record<string, string>;
}

function splitReferences(value: unknown): { values?: Record<string, string>; refs?: Record<string, string> } {
  const record = stringRecord(value);
  if (!record) return {};
  const values: Record<string, string> = {};
  const refs: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const match = raw.match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) refs[key] = match[1]!;
    else values[key] = raw;
  }
  return {
    ...(Object.keys(values).length ? { values } : {}),
    ...(Object.keys(refs).length ? { refs } : {}),
  };
}

function normalizeServer(value: unknown): NativeMcpServerConfig | undefined {
  if (!isRecord(value) || value.disabled === true) return undefined;
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : undefined;
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined;
  if ((command ? 1 : 0) + (url ? 1 : 0) !== 1) return undefined;
  if (url) {
    try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return undefined; }
    catch { return undefined; }
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== 'string'))) return undefined;
  const timeout = Number(value.timeoutMs);
  const maxConcurrentCalls = Number(value.maxConcurrentCalls);
  const env = splitReferences(value.env);
  const headers = splitReferences(value.headers);
  const explicitEnvRefs = stringRecord(value.envRefs);
  const explicitHeaderRefs = stringRecord(value.headerRefs);
  const oauth = value.oauth === true;
  const hasStaticAuthorization = value.bearerTokenEnvVar !== undefined
    || Object.keys(headers.values ?? {}).some((key) => key.toLowerCase() === 'authorization')
    || Object.keys({ ...(headers.refs ?? {}), ...(explicitHeaderRefs ?? {}) }).some((key) => key.toLowerCase() === 'authorization');
  if (oauth && (hasStaticAuthorization || !url)) return undefined;
  return {
    transport: url ? 'http' : 'stdio',
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(env.values ? { env: env.values } : {}),
    ...((env.refs || explicitEnvRefs) ? { envRefs: { ...(env.refs ?? {}), ...(explicitEnvRefs ?? {}) } } : {}),
    ...(headers.values ? { headers: headers.values } : {}),
    ...((headers.refs || explicitHeaderRefs) ? { headerRefs: { ...(headers.refs ?? {}), ...(explicitHeaderRefs ?? {}) } } : {}),
    ...(typeof value.bearerTokenEnvVar === 'string' ? { bearerTokenEnvVar: value.bearerTokenEnvVar } : {}),
    ...(oauth ? { oauth: true as const } : {}),
    ...(Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 120_000 ? { timeoutMs: timeout } : {}),
    ...(Number.isSafeInteger(maxConcurrentCalls) && maxConcurrentCalls >= 1 && maxConcurrentCalls <= 4 ? { maxConcurrentCalls } : {}),
  };
}

function readConfigFile(
  file: string,
  provenance: NativeMcpServerConfig['provenance'],
): Record<string, NativeMcpServerConfig> {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed)) return {};
    const container = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
    const entries: Array<[string, NativeMcpServerConfig]> = [];
    for (const [name, value] of Object.entries(container)) {
      const config = SERVER_NAME_RE.test(name) ? normalizeServer(value) : undefined;
      if (config) entries.push([name, { ...config, provenance }]);
    }
    return Object.fromEntries(entries);
  } catch { return {}; }
}

export function loadNativeMcpServers(options: NativeMcpOptions): Record<string, NativeMcpServerConfig> {
  const env = options.env ?? process.env;
  const octocodeHome = options.octocodeHome ?? getOctocodeHome(env);
  const homeDir = options.homeDir ?? env.HOME ?? process.cwd();
  const globalFiles = [path.join(octocodeHome, 'agent', 'mcp', 'servers.json')];
  const global: Record<string, NativeMcpServerConfig> = Object.assign({}, ...globalFiles.map((file, index) => readConfigFile(file, {
    scope: 'global', file, discoveryOrder: index,
  })));
  const repository = repositoryDirectories(options.cwd)[0] ?? path.resolve(options.cwd);
  const workspaceFile = path.join(workspaceAgentRoot(repository, octocodeHome), 'mcp', 'servers.json');
  const workspace = readConfigFile(workspaceFile, {
    scope: 'workspace', file: workspaceFile, discoveryOrder: globalFiles.length,
  });
  const discovered = Object.fromEntries(repositoryDirectories(options.cwd).flatMap((directory) =>
    discoverMcpSystem(directory, { homeDir, octocodeHome }).definitions,
  ).map(({ name, config }) => [name, {
    ...config,
    transport: config.transport ?? (config.url ? 'http' as const : 'stdio' as const),
    defaultEnabled: false,
    provenance: {
      scope: config.discovered.scope === 'project' ? 'workspace' as const : 'global' as const,
      file: config.discovered.path,
      discoveryOrder: Number.MAX_SAFE_INTEGER,
    },
  }]));
  const canonical = Object.fromEntries(Object.entries({ ...global, ...workspace }).map(([name, config]) => [name, {
    ...config,
    defaultEnabled: true,
  }]));
  return { ...discovered, ...canonical };
}

function referencedValues(values: Record<string, string> | undefined, refs: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const result = { ...(values ?? {}) };
  for (const [key, variable] of Object.entries(refs ?? {})) {
    const value = env[variable];
    if (value === undefined) throw new Error(`Missing referenced environment variable: ${variable}`);
    result[key] = value;
  }
  return result;
}

function resolveServerCwd(config: NativeMcpServerConfig, workspace: string): string {
  const root = fs.realpathSync(path.resolve(workspace));
  const resolved = fs.realpathSync(path.resolve(root, config.cwd ?? '.'));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('MCP server cwd must stay within the workspace');
  if (!fs.statSync(resolved).isDirectory()) throw new Error('MCP server cwd must be a directory');
  return resolved;
}

export async function connectNativeMcp(name: string, config: NativeMcpServerConfig, signal: AbortSignal, options: NativeMcpOptions): Promise<NativeMcpClient> {
  const env = options.env ?? process.env;
  let transport: Transport;
  let oauthFlow: NativeMcpOAuthFlow | undefined;
  if (config.transport === 'http') {
    const headers = referencedValues(config.headers, config.headerRefs, env);
    if (config.bearerTokenEnvVar) {
      const token = env[config.bearerTokenEnvVar];
      if (!token) throw new Error(`Missing bearer token environment variable: ${config.bearerTokenEnvVar}`);
      headers.Authorization = `Bearer ${token}`;
    }
    if (config.oauth) {
      if (!options.oauth) throw new Error(`MCP OAuth server ${name} requires an interactive OAuth host`);
      oauthFlow = await options.oauth.createFlow({ serverName: name, serverUrl: config.url! });
    }
    const httpTransport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: { headers },
      ...(oauthFlow ? { authProvider: oauthFlow.provider } : {}),
    });
    oauthFlow?.attachTransport(httpTransport);
    transport = httpTransport;
  } else {
    transport = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      cwd: resolveServerCwd(config, options.cwd),
      env: { ...getDefaultEnvironment(), ...referencedValues(config.env, config.envRefs, env) },
      stderr: 'pipe',
    });
  }
  const client = new Client(
    { name: 'octocode-agent', version: '1.1.0' },
    { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(transport, { signal, timeout: config.timeoutMs ?? 30_000 });
  } catch (error) {
    await oauthFlow?.close();
    throw error;
  }
  if (!oauthFlow) return client as unknown as NativeMcpClient;
  const nativeClient = client as unknown as NativeMcpClient;
  const closeClient = nativeClient.close.bind(nativeClient);
  nativeClient.close = async () => {
    await Promise.allSettled([closeClient(), oauthFlow.close()]);
  };
  return nativeClient;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`MCP ${key} is required`);
  return value;
}

const MCP_NAME_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
const MCP_ARGUMENTS_SCHEMA: JsonSchema = { type: 'object', maxProperties: MAX_MCP_OBJECT_PROPERTIES };
const MCP_CALL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { server: MCP_NAME_SCHEMA, tool: MCP_NAME_SCHEMA, arguments: MCP_ARGUMENTS_SCHEMA },
  required: ['server', 'tool'],
  additionalProperties: false,
};

function actionSchema(action: string, properties: Readonly<Record<string, JsonSchema>> = {}, required: readonly string[] = []): JsonSchema {
  return {
    type: 'object',
    properties: { action: { const: action }, ...properties },
    required: ['action', ...required],
    additionalProperties: false,
  };
}

const MCP_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    actionSchema('status'),
    actionSchema('auth-status', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('auth-revoke', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('capabilities', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('discover', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('refresh', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('describe', { server: MCP_NAME_SCHEMA, tool: MCP_NAME_SCHEMA }, ['server', 'tool']),
    actionSchema('call', MCP_CALL_SCHEMA.properties, MCP_CALL_SCHEMA.required),
    actionSchema('parallel-call', {
      calls: { type: 'array', minItems: 1, maxItems: MAX_PARALLEL_MCP_CALLS, items: MCP_CALL_SCHEMA },
    }, ['calls']),
    actionSchema('resources', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('read-resource', { server: MCP_NAME_SCHEMA, uri: { type: 'string', minLength: 1, maxLength: 8_192 } }, ['server', 'uri']),
    actionSchema('prompts', { server: MCP_NAME_SCHEMA }, ['server']),
    actionSchema('get-prompt', { server: MCP_NAME_SCHEMA, prompt: MCP_NAME_SCHEMA, arguments: MCP_ARGUMENTS_SCHEMA }, ['server', 'prompt']),
    actionSchema('complete', {
      server: MCP_NAME_SCHEMA,
      ref: { type: 'object' },
      argument: {
        type: 'object',
        properties: { name: MCP_NAME_SCHEMA, value: { type: 'string', maxLength: 65_536 } },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    }, ['server', 'ref', 'argument']),
    actionSchema('task-get', { server: MCP_NAME_SCHEMA, taskId: MCP_NAME_SCHEMA }, ['server', 'taskId']),
    actionSchema('task-list', {
      server: MCP_NAME_SCHEMA,
      cursor: { type: 'string', minLength: 1, maxLength: 8_192 },
    }, ['server']),
    actionSchema('task-result', { server: MCP_NAME_SCHEMA, taskId: MCP_NAME_SCHEMA }, ['server', 'taskId']),
    actionSchema('task-cancel', { server: MCP_NAME_SCHEMA, taskId: MCP_NAME_SCHEMA }, ['server', 'taskId']),
  ],
};

function mapMcpBounded<T, R>(items: readonly T[], maximum: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  return Promise.all(Array.from({ length: Math.min(maximum, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!, index);
    }
  })).then(() => results);
}

export function registerNativeMcpTool(registry: ToolRegistry, options: NativeMcpOptions): NativeMcpSessionManager {
  const servers = loadNativeMcpServers(options);
  const enabled = (server: string, tool?: string): boolean => {
    const defaultEnabled = servers[server]?.defaultEnabled ?? true;
    return options.isEnabled?.(server, tool, defaultEnabled) ?? defaultEnabled;
  };
  const connect = options.connect ?? ((name, config, signal) => connectNativeMcp(name, config, signal, options));
  const now = options.now ?? Date.now;
  const manager = new NativeMcpSessionManager(connect, {
    now,
    onCatalogInvalidated: options.onCatalogInvalidated,
  });
  const ajv = new Ajv({ allErrors: true, strict: false });
  const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
  const catalogTtlMs = options.catalogTtlMs ?? DEFAULT_MCP_CATALOG_TTL_MS;
  const configuredClients = new WeakSet<object>();
  const globalCallPool = new McpPermitPool(4);
  const serverCallPools = new Map<string, McpPermitPool>();
  const configureClient = (server: string, client: NativeMcpClient): void => {
    if (configuredClients.has(client as object)) return;
    configuredClients.add(client as object);
    // Elicitation is a client capability advertised during initialize; a server does not echo it
    // in getServerCapabilities(). Presence of the configured broker is the local authorization gate.
    if (client.setRequestHandler && options.elicit) {
      client.setRequestHandler('elicitation/create', async ({ params }, extra) => {
        throwIfMcpAborted(extra?.signal, `MCP elicitation cancelled for ${server}`);
        const message = typeof params.message === 'string'
          ? truncateUtf8(params.message, MAX_MCP_PROGRESS_MESSAGE_BYTES)
          : `MCP ${server} requests input.`;
        const mode = params.mode === 'url' ? 'url' : 'form';
        const requestedSchema = params.requestedSchema === undefined
          ? undefined
          : boundedMcpRecord(params.requestedSchema, 'MCP elicitation requested schema', MAX_MCP_ELICITATION_BYTES);
        const url = params.url === undefined ? undefined : params.url;
        if (url !== undefined && (typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > MAX_MCP_ELICITATION_URL_BYTES)) {
          throw new McpPayloadBoundsError('MCP elicitation URL exceeds the byte limit');
        }
        const rawResult = await withMcpCancellation(options.elicit!({
          server, message, mode,
          ...(requestedSchema ? { requestedSchema } : {}),
          ...(url ? { url } : {}),
          ...(extra?.signal ? { signal: extra.signal } : {}),
        }), extra?.signal, `MCP elicitation cancelled for ${server}`);
        const result = boundedMcpRecord(rawResult, 'MCP elicitation result', MAX_MCP_ELICITATION_BYTES, true);
        if (!['accept', 'decline', 'cancel'].includes(String(result.action))
          || (result.content !== undefined && !isRecord(result.content))) {
          throw new McpPayloadBoundsError('MCP elicitation result is invalid');
        }
        return {
          action: result.action as NativeMcpElicitationResult['action'],
          ...(isRecord(result.content) ? { content: result.content } : {}),
        };
      });
    }
  };
  const paginatedList = async (
    server: string,
    family: 'resources' | 'prompts',
    requestOptions: { signal: AbortSignal; timeout: number },
    fetchPage: (params: { cursor?: string } | undefined) => Promise<{ nextCursor?: string } & Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const accumulator: McpCatalogAccumulator = { items: [], encodedBytes: 2 };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_MCP_CATALOG_PAGES; page += 1) {
      const result = boundedMcpRecord(await withMcpCancellation(
        fetchPage(cursor === undefined ? undefined : { cursor }),
        requestOptions.signal,
        `MCP ${family} listing cancelled for ${server}`,
      ), `MCP ${family} catalog transport response`, MAX_MCP_TRANSPORT_BYTES);
      appendMcpCatalogItems(accumulator, result[family], family);
      const nextCursor = boundedMcpCursor(result.nextCursor, family);
      if (nextCursor === undefined) return { [family]: accumulator.items };
      if (nextCursor === cursor || seenCursors.has(nextCursor)) throw new Error(`MCP ${family} pagination did not advance for ${server}`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      throwIfMcpAborted(requestOptions.signal, `MCP ${family} listing cancelled for ${server}`);
    }
    throw new Error(`MCP ${family} pagination exceeded ${MAX_MCP_CATALOG_PAGES} pages for ${server}`);
  };
  const toolsFor = async (
    server: string,
    client: NativeMcpClient,
    requestOptions: { signal: AbortSignal; timeout: number },
    force = false,
  ): Promise<Array<Record<string, unknown>>> => {
    const cached = manager.catalog(server, now());
    if (!force && cached) return cached;
    const accumulator: McpCatalogAccumulator = { items: [], encodedBytes: 2 };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let minimumTtlMs = Number.POSITIVE_INFINITY;
    for (let page = 0; page < MAX_MCP_CATALOG_PAGES; page += 1) {
      let listed: unknown;
      try {
        listed = await withMcpCancellation(
          client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions),
          requestOptions.signal,
          `MCP tools listing cancelled for ${server}`,
        );
      } catch (error) {
        if (!(error instanceof RuntimeFailure && error.category === 'cancelled')) {
          manager.evictFailedConnection(server, client);
        }
        throw error;
      }
      const result = boundedMcpRecord(listed, 'MCP tools catalog transport response', MAX_MCP_TRANSPORT_BYTES);
      const pageTtlMs = Number.isSafeInteger(result.ttlMs) && (result.ttlMs as number) >= 0 ? result.ttlMs as number : catalogTtlMs;
      minimumTtlMs = Math.min(minimumTtlMs, pageTtlMs);
      appendMcpCatalogItems(accumulator, result.tools, 'tools');
      const nextCursor = boundedMcpCursor(result.nextCursor, 'tools');
      if (nextCursor === undefined) {
        accumulator.items.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
        manager.setCatalog(server, { expiresAt: now() + (Number.isFinite(minimumTtlMs) ? minimumTtlMs : 0), tools: accumulator.items });
        return accumulator.items;
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) throw new Error(`MCP tools pagination did not advance for ${server}`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`MCP tools pagination exceeded ${MAX_MCP_CATALOG_PAGES} pages for ${server}`);
  };
  interface PreparedMcpToolCall {
    readonly server: string;
    readonly tool: string;
    readonly client: NativeMcpClient;
    readonly arguments: Record<string, unknown>;
    readonly requestOptions: NativeMcpRequestOptions;
  }
  const prepareConfiguredTool = async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PreparedMcpToolCall> => {
    throwIfMcpAborted(signal, `MCP call cancelled for ${server}/${tool}`);
    const config = servers[server];
    if (!config || !enabled(server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
    if (!enabled(server, tool)) throw new Error(`Unknown or disabled MCP tool: ${server}/${tool}`);
    const client = await manager.acquire(server, config, signal);
    configureClient(server, client);
    const requestOptions = { signal, timeout: config.timeoutMs ?? 30_000 };
    let catalog = await toolsFor(server, client, requestOptions);
    let definition = catalog.find((item) => item.name === tool);
    if (!definition && manager.hasCatalog(server)) {
      catalog = await toolsFor(server, client, requestOptions, true);
      definition = catalog.find((item) => item.name === tool);
    }
    if (!definition) throw new Error(`Unknown MCP tool: ${server}/${tool}`);
    const boundedArgs = boundedMcpRecord(args, 'MCP tool arguments transport payload', MAX_MCP_TRANSPORT_BYTES);
    const schema = isRecord(definition.inputSchema) ? definition.inputSchema as JsonSchema : { type: 'object' };
    const validator = schema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? ajv2020 : ajv;
    const validate = validator.compile(schema);
    if (!validate(boundedArgs)) throw new Error(`Invalid MCP arguments: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
    return { server, tool, client, arguments: boundedArgs, requestOptions };
  };
  const executePreparedTool = async (
    prepared: PreparedMcpToolCall,
    signal: AbortSignal,
    update?: (value: { version: 1; kind: 'progress'; message?: string; value: Progress }) => Promise<void>,
  ): Promise<unknown> => {
    const { server, tool, client, arguments: boundedArgs, requestOptions } = prepared;
    throwIfMcpAborted(signal, `MCP call cancelled for ${server}/${tool}`);
    let progressTail = Promise.resolve();
    let progressError: unknown;
    let progressCount = 0;
    let content: unknown;
    try {
      content = await withMcpCancellation(client.callTool({ name: tool, arguments: boundedArgs }, {
        ...requestOptions,
        onprogress: (progress) => {
          if (!update || signal.aborted || progressCount >= MAX_MCP_PROGRESS_UPDATES || progressError !== undefined) return;
          let bounded: Progress;
          try {
            bounded = boundedMcpProgress(progress);
          } catch (error) {
            progressError = error;
            return;
          }
          progressCount += 1;
          progressTail = progressTail.then(() => update({
            version: 1,
            kind: 'progress',
            ...(typeof bounded.message === 'string' ? { message: bounded.message } : {}),
            value: bounded,
          }));
        },
      }), signal, `MCP call cancelled for ${server}/${tool}`);
    } finally {
      await withMcpCancellation(progressTail, signal, `MCP call cancelled for ${server}/${tool}`);
      if (progressError !== undefined) throw progressError;
    }
    throwIfMcpAborted(signal, `MCP call cancelled for ${server}/${tool}`);
    return boundedMcpValue(content, 'MCP tool transport result', MAX_MCP_TRANSPORT_BYTES);
  };
  const withCallPermits = async <T>(
    server: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const config = servers[server];
    if (!config || !enabled(server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
    let pool = serverCallPools.get(server);
    if (!pool) {
      pool = new McpPermitPool(config.maxConcurrentCalls ?? 1);
      serverCallPools.set(server, pool);
    }
    return pool.run(signal, () => globalCallPool.run(signal, operation));
  };
  const callConfiguredTool = async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    update?: (value: { version: 1; kind: 'progress'; message?: string; value: Progress }) => Promise<void>,
  ): Promise<unknown> => {
    return withCallPermits(server, signal, async () => {
      const prepared = await prepareConfiguredTool(server, tool, args, signal);
      return executePreparedTool(prepared, signal, update);
    });
  };
  manager.setHookCall(async (handler, input, signal) => {
    const configured = handler.input === undefined
      ? {}
      : isRecord(handler.input)
        ? structuredClone(handler.input)
        : { configuredInput: structuredClone(handler.input) };
    const content = await callConfiguredTool(handler.server, handler.tool, { ...configured, hook: structuredClone(input) }, signal);
    if (isRecord(content) && content.isError === true) throw new Error(`MCP hook execution failed for ${handler.server}/${handler.tool}`);
    const output = hookOutput(content);
    return { decision: hookDecision(output), output, stderr: '' };
  });
  const readActions = new Set(['auth-status', 'capabilities', 'discover', 'refresh', 'describe', 'resources', 'read-resource', 'prompts', 'get-prompt', 'complete', 'task-get', 'task-list', 'task-result']);
  const transportEffects = (server: unknown, mutating: boolean) => {
    if (typeof server !== 'string' || !servers[server]) return createEffectSet('network', 'process', 'write');
    const transport = servers[server]!.transport === 'http' ? 'network' : 'process';
    return mutating ? createEffectSet(transport, 'write') : createEffectSet('read', transport);
  };
  registry.register({
    name: 'MCPTool',
    label: 'MCP',
    description: `Use explicitly configured Model Context Protocol servers for tools, resources, prompts, completion, and negotiated tasks. Configured servers: ${Object.keys(servers).filter((name) => enabled(name)).sort((left, right) => left.localeCompare(right)).join(', ') || 'none'}.`,
    schemaVersion: 1,
    inputSchema: MCP_INPUT_SCHEMA,
    outputSchema: {},
    outputVersion: 1,
    policy: {
      effects: createEffectSet('network', 'process', 'write'),
      trust: 'workspace',
      approval: 'on-request',
      plan: 'allowed',
      resolve: (input) => {
        if (!isRecord(input) || typeof input.action !== 'string')
          return { effects: createEffectSet('network', 'process', 'write'), trust: 'workspace', approval: 'always' };
        if (input.action === 'status') return { effects: createEffectSet('read'), trust: 'none', approval: 'never' };
        if (readActions.has(input.action)) return { effects: transportEffects(input.server, false), trust: 'workspace', approval: 'never' };
        if (input.action === 'call' || input.action === 'task-cancel')
          return { effects: transportEffects(input.server, true), trust: 'workspace', approval: 'on-request' };
        if (input.action === 'parallel-call')
          return { effects: createEffectSet('network', 'process', 'write'), trust: 'workspace', approval: 'on-request' };
        return { effects: createEffectSet('network', 'process', 'write'), trust: 'workspace', approval: 'always' };
      },
      concurrency: (input) => {
        if (!isRecord(input)) return undefined;
        if (input.action === 'parallel-call') return { lane: 'mcp:parallel-call', maxActive: 4 };
        if (input.action !== 'call' || typeof input.server !== 'string') return undefined;
        const config = servers[input.server];
        if (!config) return undefined;
        return { lane: `mcp:${input.server}`, maxActive: config.maxConcurrentCalls ?? 1 };
      },
    },
    async execute({ input: rawInput, signal, update }) {
      const input = boundedMcpRecord(rawInput, 'MCP input transport payload', MAX_MCP_TRANSPORT_BYTES);
      const invalid = jsonSchemaError(input, MCP_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const action = requiredString(input, 'action');
      if (action === 'status') {
        const content = boundedMcpValue({ servers: Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)).map(([name, config]) => ({ name, transport: config.transport, enabled: enabled(name), ...manager.liveSnapshot(name, now()), provenance: config.provenance })) }, 'MCP status transport result', MAX_MCP_TRANSPORT_BYTES, true);
        return { ok: true, content, detailsVersion: 1 };
      }
      if (action === 'parallel-call') {
        const calls = input.calls as Array<{ server: string; tool: string; arguments?: Record<string, unknown> }>;
        const prepared = await mapMcpBounded(calls, 4, (call) => withCallPermits(
          call.server,
          signal,
          () => prepareConfiguredTool(call.server, call.tool, call.arguments ?? {}, signal),
        ));
        const results = await mapMcpBounded(prepared, 4, async (call) => {
          if (signal.aborted) throw new RuntimeFailure('cancelled', 'MCP parallel call cancelled');
          try {
            const content = await withCallPermits(call.server, signal, () => executePreparedTool(call, signal, update));
            return {
              ok: !(isRecord(content) && content.isError === true),
              server: call.server,
              tool: call.tool,
              content: redactMcpValue(content),
            };
          } catch (error) {
            if (signal.aborted) throw new RuntimeFailure('cancelled', 'MCP parallel call cancelled');
            const message = error instanceof Error && /^(?:Invalid MCP arguments|Unknown (?:or disabled )?MCP)/.test(error.message)
              ? error.message.slice(0, 2_048)
              : `MCP call failed for ${call.server}/${call.tool}`;
            return { ok: false, server: call.server, tool: call.tool, error: message };
          }
        });
        return { ok: results.every((result) => result.ok), content: { results }, detailsVersion: 1 };
      }
      const server = requiredString(input, 'server');
      const config = servers[server];
      if (!config || !enabled(server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
      if (action === 'auth-status' || action === 'auth-revoke') {
        if (!config.oauth || !config.url || !options.oauth) throw new Error(`MCP server ${server} does not use OAuth`);
        if (action === 'auth-revoke') await options.oauth.revoke({ serverName: server, serverUrl: config.url });
        const status = await options.oauth.status({ serverName: server, serverUrl: config.url });
        return { ok: true, content: { server, ...status }, detailsVersion: 1 };
      }
      if (action === 'discover' || action === 'refresh') {
        const previousState = manager.catalogState(server, now());
        const cached = action === 'discover' ? manager.catalog(server, now()) : undefined;
        await update({
          version: 1,
          kind: 'progress',
          message: cached === undefined
            ? `${action === 'refresh' || previousState === 'stale' ? 'Refreshing' : 'Discovering'} MCP tools from ${server}`
            : `Using cached MCP tools from ${server}`,
          value: { progress: 0, total: 1 },
        });
        const client = await manager.acquire(server, config, signal);
        configureClient(server, client);
        const requestOptions = { signal, timeout: config.timeoutMs ?? 30_000 };
        const tools = cached ?? await toolsFor(server, client, requestOptions, action === 'refresh');
        await update({
          version: 1,
          kind: 'progress',
          message: `MCP catalog ready: ${server} (${tools.length} tools)`,
          value: { progress: 1, total: 1 },
        });
        return {
          ok: true,
          content: boundedMcpValue({
            server,
            source: cached === undefined ? 'server' : 'cache',
            phase: cached !== undefined ? 'cached' : previousState === 'stale' ? 'updated' : 'discovered',
            toolCount: tools.length,
            tools,
          }, 'MCP discovery transport result', MAX_MCP_TRANSPORT_BYTES),
          detailsVersion: 1,
        };
      }
      const client = await manager.acquire(server, config, signal);
      configureClient(server, client);
      const requestOptions = { signal, timeout: config.timeoutMs ?? 30_000 };
      if (action === 'capabilities') {
        const capabilities = client.getServerCapabilities?.() ?? {};
        return { ok: true, content: boundedMcpValue({ server, capabilities }, 'MCP capabilities transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      if (action === 'task-get' || action === 'task-list' || action === 'task-result' || action === 'task-cancel') {
        throwIfMcpAborted(signal, `MCP task request cancelled for ${server}`);
        const tasks = client.getServerCapabilities?.()?.tasks;
        if (!tasks) throw new Error(`MCP server ${server} did not negotiate the tasks capability`);
        const operation = action === 'task-get'
          ? 'get'
          : action === 'task-list'
            ? 'list'
            : action === 'task-result'
              ? 'result'
              : 'cancel';
        if (operation === 'list' && !isRecord(tasks.list))
          throw new Error(`MCP server ${server} did not negotiate tasks/list`);
        if (operation === 'cancel' && !isRecord(tasks.cancel))
          throw new Error(`MCP server ${server} did not negotiate tasks/cancel`);
        const params = operation === 'list'
          ? (typeof input.cursor === 'string' ? { cursor: input.cursor } : {})
          : { taskId: requiredString(input, 'taskId') };
        const resultSchema = operation === 'get'
          ? specTypeSchemas.GetTaskResult
          : operation === 'list'
            ? specTypeSchemas.ListTasksResult
            : operation === 'result'
              ? specTypeSchemas.GetTaskPayloadResult
              : specTypeSchemas.CancelTaskResult;
        const task = boundedMcpValue(await withMcpCancellation(
          client.request({ method: `tasks/${operation}`, params }, resultSchema, requestOptions),
          signal,
          `MCP task request cancelled for ${server}`,
        ), 'MCP task transport result', MAX_MCP_TASK_ITEM_BYTES, true);
        throwIfMcpAborted(signal, `MCP task request cancelled for ${server}`);
        const entry: StoredMcpTask = { task, provenance: { server, operation, observedAt: now() } };
        const maximum = Math.max(1, Math.min(1_000, options.maxStoredTasks ?? DEFAULT_MAX_STORED_TASKS));
        const storeFile = containedFile(options.taskStoreFile ?? path.join(options.octocodeHome ?? getOctocodeHome(options.env ?? process.env), 'agent', 'mcp', 'tasks.json'), options);
        await manager.persistTask(storeFile, entry, maximum);
        return { ok: true, content: entry, detailsVersion: 1 };
      }
      if (action === 'describe' || action === 'call') {
        const tool = requiredString(input, 'tool');
        if (!enabled(server, tool)) throw new Error(`Unknown or disabled MCP tool: ${server}/${tool}`);
        if (action === 'describe') {
          let catalog = await toolsFor(server, client, requestOptions);
          let definition = catalog.find((item) => item.name === tool);
          if (!definition && manager.hasCatalog(server)) {
            catalog = await toolsFor(server, client, requestOptions, true);
            definition = catalog.find((item) => item.name === tool);
          }
          if (!definition) throw new Error(`Unknown MCP tool: ${server}/${tool}`);
          return { ok: true, content: boundedMcpValue(definition, 'MCP tool description transport result', MAX_MCP_CATALOG_ITEM_BYTES), detailsVersion: 1 };
        }
        const args = input.arguments === undefined ? {} : input.arguments;
        if (!isRecord(args)) throw new Error('MCP arguments must be an object');
        const content = redactMcpValue(await callConfiguredTool(server, tool, args, signal, update));
        return isRecord(content) && content.isError === true
          ? { ok: false, category: 'tool-execution', content, detailsVersion: 1 }
          : { ok: true, content, detailsVersion: 1 };
      }
      if (action === 'resources') {
        const content = await paginatedList(server, 'resources', requestOptions, (params) => client.listResources(params, requestOptions));
        return { ok: true, content: boundedMcpValue(content, 'MCP resources transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      if (action === 'read-resource') {
        const content = await withMcpCancellation(client.readResource({ uri: requiredString(input, 'uri') }, requestOptions), signal, `MCP resource read cancelled for ${server}`);
        return { ok: true, content: boundedMcpValue(content, 'MCP resource transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      if (action === 'prompts') {
        const content = await paginatedList(server, 'prompts', requestOptions, (params) => client.listPrompts(params, requestOptions));
        return { ok: true, content: boundedMcpValue(content, 'MCP prompts transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      if (action === 'get-prompt') {
        const args = input.arguments === undefined ? undefined : input.arguments;
        if (args !== undefined && (!isRecord(args) || Object.values(args).some((value) => typeof value !== 'string'))) throw new Error('MCP prompt arguments must be strings');
        const promptArgs = args === undefined ? undefined : boundedMcpRecord(args, 'MCP prompt arguments transport payload', MAX_MCP_TRANSPORT_BYTES) as Record<string, string>;
        const content = await withMcpCancellation(client.getPrompt({ name: requiredString(input, 'prompt'), ...(promptArgs ? { arguments: promptArgs } : {}) }, requestOptions), signal, `MCP prompt request cancelled for ${server}`);
        return { ok: true, content: boundedMcpValue(content, 'MCP prompt transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      if (action === 'complete') {
        if (!isRecord(input.ref) || !isRecord(input.argument) || typeof input.argument.name !== 'string' || typeof input.argument.value !== 'string') throw new Error('MCP complete requires ref and string argument fields');
        const ref = boundedMcpRecord(input.ref, 'MCP completion reference transport payload', MAX_MCP_TRANSPORT_BYTES);
        const content = await withMcpCancellation(client.complete({ ref, argument: { name: input.argument.name, value: input.argument.value } }, requestOptions), signal, `MCP completion request cancelled for ${server}`);
        return { ok: true, content: boundedMcpValue(content, 'MCP completion transport result', MAX_MCP_TRANSPORT_BYTES, true), detailsVersion: 1 };
      }
      throw new Error(`Unsupported MCP action: ${action}`);
    },
  }, 'model-context-protocol');
  return manager;
}
