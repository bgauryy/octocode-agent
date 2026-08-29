import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Client, StreamableHTTPClientTransport, type Progress, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createEffectSet, type HookDecision, type JsonSchema, type ToolRegistry } from '@octocodeai/agent-core';
import { repositoryDirectories } from '@octocodeai/octocode-shared/agent-skills';
import { getOctocodeHome } from '@octocodeai/octocode-shared/paths';

const MAX_CONFIG_BYTES = 1024 * 1024;
const SERVER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MCP_TASK_STORE_VERSION = 1;
const MCP_TASK_LOCK_ATTEMPTS = 100;
const MCP_TASK_LOCK_RETRY_MS = 5;
const MCP_TASK_LOCK_STALE_MS = 30_000;

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
  timeoutMs?: number;
  provenance?: { scope: 'global' | 'workspace'; file: string; discoveryOrder: number };
}

export interface NativeMcpClient {
  listTools(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ tools?: Array<Record<string, unknown>>; nextCursor?: string; ttlMs?: number; cacheScope?: 'public' | 'private' }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: NativeMcpRequestOptions): Promise<unknown>;
  listResources(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ resources?: Array<Record<string, unknown>>; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: NativeMcpRequestOptions): Promise<unknown>;
  listPrompts(params?: { cursor?: string }, options?: NativeMcpRequestOptions): Promise<{ prompts?: Array<Record<string, unknown>>; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: NativeMcpRequestOptions): Promise<unknown>;
  complete(params: { ref: Record<string, unknown>; argument: { name: string; value: string } }, options?: NativeMcpRequestOptions): Promise<unknown>;
  getTask?(params: { taskId: string }, options?: NativeMcpRequestOptions): Promise<unknown>;
  getTaskResult?(params: { taskId: string }, options?: NativeMcpRequestOptions): Promise<unknown>;
  cancelTask?(params: { taskId: string }, options?: NativeMcpRequestOptions): Promise<unknown>;
  getServerCapabilities?(): { tools?: { listChanged?: boolean }; elicitation?: Record<string, unknown>; tasks?: Record<string, unknown> } | undefined;
  setNotificationHandler?(method: 'notifications/tools/list_changed', handler: () => void | Promise<void>): void;
  setRequestHandler?(method: 'elicitation/create', handler: (request: { params: Record<string, unknown> }, extra?: { signal?: AbortSignal }) => Promise<NativeMcpElicitationResult>): void;
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
  isEnabled?: (server: string, tool?: string) => boolean;
  catalogTtlMs?: number;
  now?: () => number;
  elicit?: (request: NativeMcpElicitationRequest) => Promise<NativeMcpElicitationResult>;
  taskStoreFile?: string;
  maxStoredTasks?: number;
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
  readonly provenance: { readonly server: string; readonly operation: 'get' | 'result' | 'cancel'; readonly observedAt: number };
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
const DEFAULT_MCP_CATALOG_TTL_MS = 0;
const DEFAULT_MAX_STORED_TASKS = 100;
const SENSITIVE_KEY_RE = /(?:api[-_]?key|token|secret|password|authorization|cookie)/i;

type NativeMcpConnect = (name: string, config: NativeMcpServerConfig, signal: AbortSignal) => Promise<NativeMcpClient>;
type NativeMcpCatalog = { expiresAt: number; tools: Array<Record<string, unknown>> };

export class NativeMcpSessionManager {
  readonly #connections = new Map<string, Promise<NativeMcpClient>>();
  readonly #catalogs = new Map<string, NativeMcpCatalog>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #taskWrites = Promise.resolve();
  #hookCall: ((handler: NativeMcpHookHandler, input: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<NativeMcpHookResult>) | undefined;

  constructor(private readonly connect: NativeMcpConnect) {}

  async acquire(name: string, config: NativeMcpServerConfig, signal: AbortSignal): Promise<NativeMcpClient> {
    if (this.#closed) throw new Error('MCP session manager is closed');
    const existing = this.#connections.get(name);
    if (existing) return existing;
    const connection = this.connect(name, config, signal).then((client) => {
      if (client.getServerCapabilities?.()?.tools?.listChanged === true && client.setNotificationHandler) {
        client.setNotificationHandler('notifications/tools/list_changed', () => {
          this.#catalogs.delete(name);
        });
      }
      return client;
    }).catch((error: unknown) => {
      this.#connections.delete(name);
      throw error;
    });
    this.#connections.set(name, connection);
    return connection;
  }

  catalog(name: string, now: number): Array<Record<string, unknown>> | undefined {
    const catalog = this.#catalogs.get(name);
    return catalog && catalog.expiresAt > now ? catalog.tools : undefined;
  }

  hasCatalog(name: string): boolean {
    return this.#catalogs.has(name);
  }

  setCatalog(name: string, catalog: NativeMcpCatalog): void {
    this.#catalogs.set(name, catalog);
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
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#closePromise = (async () => {
      await this.#taskWrites;
      const clients = await Promise.all(connections.map((connection) => connection.catch(() => undefined)));
      const uniqueClients = new Set(clients.filter((client): client is NativeMcpClient => client !== undefined));
      await Promise.all([...uniqueClients].map((client) => client.close().catch(() => undefined)));
    })();
    return this.#closePromise;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    && (operation === 'get' || operation === 'result' || operation === 'cancel')
    && typeof observedAt === 'number'
    && Number.isFinite(observedAt)
    && observedAt >= 0;
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
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
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
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
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
        const stat = fs.lstatSync(lockFile);
        if (Date.now() - stat.mtimeMs > MCP_TASK_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
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

async function persistTask(file: string, entry: StoredMcpTask, maximum: number): Promise<void> {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  await acquireTaskStoreLock(lockFile);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const tasks = [...readTaskStore(file), entry].slice(-maximum);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: MCP_TASK_STORE_VERSION, tasks })}\n`);
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
  const env = splitReferences(value.env);
  const headers = splitReferences(value.headers);
  const explicitEnvRefs = stringRecord(value.envRefs);
  const explicitHeaderRefs = stringRecord(value.headerRefs);
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
    ...(Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 120_000 ? { timeoutMs: timeout } : {}),
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
  const globalFile = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
  const global = readConfigFile(globalFile, { scope: 'global', file: globalFile, discoveryOrder: 0 });
  const project = Object.assign({}, ...repositoryDirectories(options.cwd).map((directory, index) => {
    const file = path.join(directory, '.octocode', 'agent', 'mcp', 'servers.json');
    return readConfigFile(file, { scope: 'workspace', file, discoveryOrder: index + 1 });
  }));
  return { ...global, ...project };
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

async function connectNativeMcp(_name: string, config: NativeMcpServerConfig, signal: AbortSignal, options: NativeMcpOptions): Promise<NativeMcpClient> {
  const env = options.env ?? process.env;
  let transport: Transport;
  if (config.transport === 'http') {
    const headers = referencedValues(config.headers, config.headerRefs, env);
    if (config.bearerTokenEnvVar) {
      const token = env[config.bearerTokenEnvVar];
      if (!token) throw new Error(`Missing bearer token environment variable: ${config.bearerTokenEnvVar}`);
      headers.Authorization = `Bearer ${token}`;
    }
    transport = new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers } });
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
  await client.connect(transport, { signal, timeout: config.timeoutMs ?? 30_000 });
  return client as unknown as NativeMcpClient;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`MCP ${key} is required`);
  return value;
}

export function registerNativeMcpTool(registry: ToolRegistry, options: NativeMcpOptions): NativeMcpSessionManager {
  const servers = loadNativeMcpServers(options);
  const enabled = (server: string, tool?: string): boolean => options.isEnabled?.(server, tool) ?? true;
  const connect = options.connect ?? ((name, config, signal) => connectNativeMcp(name, config, signal, options));
  const manager = new NativeMcpSessionManager(connect);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const now = options.now ?? Date.now;
  const catalogTtlMs = options.catalogTtlMs ?? DEFAULT_MCP_CATALOG_TTL_MS;
  const configuredClients = new WeakSet<object>();
  const configureClient = (server: string, client: NativeMcpClient): void => {
    if (configuredClients.has(client as object)) return;
    configuredClients.add(client as object);
    // Elicitation is a client capability advertised during initialize; a server does not echo it
    // in getServerCapabilities(). Presence of the configured broker is the local authorization gate.
    if (client.setRequestHandler && options.elicit) {
      client.setRequestHandler('elicitation/create', async ({ params }, extra) => {
        const message = typeof params.message === 'string' ? params.message.slice(0, 4_096) : `MCP ${server} requests input.`;
        const mode = params.mode === 'url' ? 'url' : 'form';
        const result = await options.elicit!({
          server, message, mode,
          ...(isRecord(params.requestedSchema) ? { requestedSchema: params.requestedSchema } : {}),
          ...(typeof params.url === 'string' ? { url: params.url } : {}),
          ...(extra?.signal ? { signal: extra.signal } : {}),
        });
        return redactMcpValue(result) as NativeMcpElicitationResult;
      });
    }
  };
  const paginatedList = async (
    server: string,
    family: 'resources' | 'prompts',
    requestOptions: { signal: AbortSignal; timeout: number },
    fetchPage: (params: { cursor?: string } | undefined) => Promise<{ nextCursor?: string } & Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_CATALOG_PAGES; page += 1) {
      const result = await fetchPage(cursor === undefined ? undefined : { cursor });
      const pageItems = result[family];
      if (Array.isArray(pageItems)) items.push(...pageItems.filter(isRecord));
      if (!result.nextCursor) return { [family]: items };
      if (result.nextCursor === cursor) throw new Error(`MCP ${family} pagination did not advance for ${server}`);
      cursor = result.nextCursor;
      if (requestOptions.signal.aborted) throw new Error(`MCP ${family} listing cancelled for ${server}`);
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
    const tools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let minimumTtlMs = Number.POSITIVE_INFINITY;
    let cacheScope: 'public' | 'private' | undefined;
    for (let page = 0; page < MAX_MCP_CATALOG_PAGES; page += 1) {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions);
      const pageTtlMs = Number.isSafeInteger(result.ttlMs) && result.ttlMs! >= 0 ? result.ttlMs! : catalogTtlMs;
      minimumTtlMs = Math.min(minimumTtlMs, pageTtlMs);
      if (result.cacheScope !== undefined) {
        if (cacheScope !== undefined && cacheScope !== result.cacheScope) throw new Error(`MCP tools pages disagree on cache scope for ${server}`);
        cacheScope = result.cacheScope;
      }
      tools.push(...(result.tools ?? []));
      if (!result.nextCursor) {
        tools.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
        manager.setCatalog(server, { expiresAt: now() + (Number.isFinite(minimumTtlMs) ? minimumTtlMs : 0), tools });
        return tools;
      }
      if (result.nextCursor === cursor) throw new Error(`MCP tools pagination did not advance for ${server}`);
      cursor = result.nextCursor;
    }
    throw new Error(`MCP tools pagination exceeded ${MAX_MCP_CATALOG_PAGES} pages for ${server}`);
  };
  const callConfiguredTool = async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    update?: (value: { version: 1; kind: 'progress'; message?: string; value: Progress }) => Promise<void>,
  ): Promise<unknown> => {
    if (signal.aborted) throw new Error(`MCP call cancelled for ${server}/${tool}`);
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
    const schema = isRecord(definition.inputSchema) ? definition.inputSchema as JsonSchema : { type: 'object' };
    const validate = ajv.compile(schema);
    if (!validate(args)) throw new Error(`Invalid MCP arguments: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
    let progressTail = Promise.resolve();
    let content: unknown;
    try {
      content = await client.callTool({ name: tool, arguments: args }, {
        ...requestOptions,
        onprogress: (progress) => {
          if (!update) return;
          progressTail = progressTail.then(() => update({ version: 1, kind: 'progress', ...(typeof progress.message === 'string' ? { message: progress.message } : {}), value: progress }));
        },
      });
    } finally { await progressTail; }
    return content;
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
  registry.register({
    name: 'MCPTool',
    label: 'MCP',
    description: `Use explicitly configured Model Context Protocol servers for tools, resources, prompts, and completion. Configured servers: ${Object.keys(servers).filter((name) => enabled(name)).sort((left, right) => left.localeCompare(right)).join(', ') || 'none'}.`,
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'capabilities', 'describe', 'call', 'resources', 'read-resource', 'prompts', 'get-prompt', 'complete', 'task-get', 'task-result', 'task-cancel'] },
        server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' }, uri: { type: 'string' }, prompt: { type: 'string' }, ref: { type: 'object' }, argument: { type: 'object' }, taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    outputVersion: 1,
    policy: { effects: createEffectSet('network', 'process', 'write'), trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    async execute({ input, signal, update }) {
      if (!isRecord(input)) throw new Error('MCP input must be an object');
      const action = requiredString(input, 'action');
      if (action === 'status') {
        return { ok: true, content: { servers: Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)).map(([name, config]) => ({ name, transport: config.transport, enabled: enabled(name), provenance: config.provenance })) }, detailsVersion: 1 };
      }
      const server = requiredString(input, 'server');
      const config = servers[server];
      if (!config || !enabled(server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
      const client = await manager.acquire(server, config, signal);
      configureClient(server, client);
      const requestOptions = { signal, timeout: config.timeoutMs ?? 30_000 };
      if (action === 'capabilities') {
        const capabilities = client.getServerCapabilities?.() ?? {};
        return { ok: true, content: { server, capabilities: redactMcpValue(capabilities) }, detailsVersion: 1 };
      }
      if (action === 'task-get' || action === 'task-result' || action === 'task-cancel') {
        if (signal.aborted) throw new Error(`MCP task request cancelled for ${server}`);
        if (!client.getServerCapabilities?.()?.tasks) throw new Error(`MCP server ${server} did not negotiate the tasks capability`);
        const taskId = requiredString(input, 'taskId');
        const operation = action === 'task-get' ? 'get' : action === 'task-result' ? 'result' : 'cancel';
        const method = operation === 'get' ? client.getTask : operation === 'result' ? client.getTaskResult : client.cancelTask;
        if (!method) throw new Error(`MCP server ${server} negotiated tasks without ${operation} support`);
        const task = redactMcpValue(await method.call(client, { taskId }, requestOptions));
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
          return { ok: true, content: definition, detailsVersion: 1 };
        }
        const args = input.arguments === undefined ? {} : input.arguments;
        if (!isRecord(args)) throw new Error('MCP arguments must be an object');
        const content = await callConfiguredTool(server, tool, args, signal, update);
        return isRecord(content) && content.isError === true
          ? { ok: false, category: 'tool-execution', content, detailsVersion: 1 }
          : { ok: true, content, detailsVersion: 1 };
      }
      if (action === 'resources') return { ok: true, content: await paginatedList(server, 'resources', requestOptions, (params) => client.listResources(params, requestOptions)), detailsVersion: 1 };
      if (action === 'read-resource') return { ok: true, content: await client.readResource({ uri: requiredString(input, 'uri') }, requestOptions), detailsVersion: 1 };
      if (action === 'prompts') return { ok: true, content: await paginatedList(server, 'prompts', requestOptions, (params) => client.listPrompts(params, requestOptions)), detailsVersion: 1 };
      if (action === 'get-prompt') {
        const args = input.arguments === undefined ? undefined : input.arguments;
        if (args !== undefined && (!isRecord(args) || Object.values(args).some((value) => typeof value !== 'string'))) throw new Error('MCP prompt arguments must be strings');
        return { ok: true, content: await client.getPrompt({ name: requiredString(input, 'prompt'), ...(args ? { arguments: args as Record<string, string> } : {}) }, requestOptions), detailsVersion: 1 };
      }
      if (action === 'complete') {
        if (!isRecord(input.ref) || !isRecord(input.argument) || typeof input.argument.name !== 'string' || typeof input.argument.value !== 'string') throw new Error('MCP complete requires ref and string argument fields');
        return { ok: true, content: await client.complete({ ref: input.ref, argument: { name: input.argument.name, value: input.argument.value } }, requestOptions), detailsVersion: 1 };
      }
      throw new Error(`Unsupported MCP action: ${action}`);
    },
  }, 'model-context-protocol');
  return manager;
}
