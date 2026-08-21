import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { NotifyFn, PiCommandContext, PiContext, PiInstance, PiTheme, RenderCallReturn, RenderContext, ToolCallResult, ToolDefinition, TSchema } from '../types.js';
import { PI_CONFIG_DIR } from '../constants.js';
import { assertPathAllowed } from './path-guard.js';
import { stringEnumSchema } from './schema-helpers.js';
import { runSelectOverlay } from './ui-overlays.js';
import { recordFileReadState } from './file-state.js';
import { buildOctocodeRenderCall, buildOctocodeRenderResult, makeRenderer } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];

type McpAction = 'list' | 'describe' | 'call' | 'status' | 'restart' | 'stop' | 'config' | 'add' | 'remove';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  description?: string;
  timeoutMs?: number;
}

interface McpConfigSource {
  scope: 'built-in' | 'project' | 'global';
  path: string;
  trusted: boolean;
}

interface McpLoadedConfig {
  servers: Map<string, McpServerConfig>;
  sources: McpConfigSource[];
  warnings: string[];
}

interface McpConnection {
  name: string;
  config: McpServerConfig;
  /** Stable signature of the normalized config; used to auto-reconnect on config drift. */
  configSig: string;
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
  startedAt: number;
}

const MCP_STATUS_NAME = 'octocode-mcp';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 24_000;
const DEFAULT_OCTOCODE_MCP_SERVER_NAME = 'octocode';
const DEFAULT_OCTOCODE_MCP_NPX_CACHE = path.join(os.homedir(), '.cache', 'octocode', 'mcp-npx');
/**
 * Env defaults every octocode MCP server spawn must carry:
 * - OCTOCODE_MCP_FULL_TEXT: octocode-mcp compacts text content to a
 *   "structuredContent available …" stub for structured-content-aware clients;
 *   Pi's MCP surfaces only read text blocks, so full text must stay on or the
 *   model sees counts instead of data.
 * - ENABLE_LOCAL: turns on the local* tool family (localSearchCode etc). Force
 *   it rather than trusting octocode-mcp's own internal default — if that
 *   upstream default ever flips, local tools must not silently disappear here.
 * - npm_config_*: ensure npx resolves the local cache with the native addon.
 * User-supplied env values always take precedence over these defaults.
 */
export const OCTOCODE_MCP_ENV_DEFAULTS: Record<string, string> = {
  OCTOCODE_MCP_FULL_TEXT: 'true',
  ENABLE_LOCAL: 'true',
  npm_config_include: 'optional',
  npm_config_cache: DEFAULT_OCTOCODE_MCP_NPX_CACHE,
};
/**
 * Resolve the pinned, locally-installed `octocode-mcp` entry (its bin === main
 * === dist/index.js) relative to this extension's own module. Returns null when
 * the dependency is not resolvable, so the caller can fall back to npx.
 *
 * octocode-mcp's package.json `exports` only defines the "import" condition, so
 * require.resolve fails — use import.meta.resolve (ESM), which honours it.
 */
function resolveLocalOctocodeMcpBin(): string | null {
  try {
    const url = import.meta.resolve('octocode-mcp');
    const binPath = fileURLToPath(url);
    return fs.existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

/**
 * Build the built-in Octocode MCP server spawn config. Prefer the pinned local
 * binary (fast, offline, reproducible against the version we ship); fall back to
 * `npx -y octocode-mcp@latest` (cache-first) when the dependency is unresolvable.
 */
function buildDefaultOctocodeMcpServer(): McpServerConfig {
  const localBin = resolveLocalOctocodeMcpBin();
  const spawn = localBin
    ? { command: process.execPath, args: [localBin] }
    : // No --prefer-online: use the local npm cache (~/.cache/octocode/mcp-npx)
      // for sub-100ms cold start when the pinned dep is unavailable.
      { command: 'npx', args: ['-y', 'octocode-mcp@latest'] };
  return {
    ...spawn,
    env: { ...OCTOCODE_MCP_ENV_DEFAULTS },
    description: 'Built-in Octocode MCP server (lazy stdio bridge, pinned-local first).',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
const connections = new Map<string, McpConnection>();
const pendingConnections = new Map<string, Promise<McpConnection>>();
const cachedCatalogs = new Map<string, ListedMcpServer[]>();

/**
 * Ambient env forwarded to every MCP server: the SDK's minimal safe default
 * (PATH, HOME, …) plus proxy/CA settings. Process secrets are NOT inherited —
 * a server that needs a token must receive it explicitly via its mcp.json
 * `env`. The built-in octocode server additionally gets its own OCTOCODE_* and
 * GitHub auth vars, since its research tools authenticate from the ambient env.
 */
const AMBIENT_ENV_PASSTHROUGH = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];
function buildServerEnv(name: string, config: McpServerConfig): Record<string, string> {
  const base = getDefaultEnvironment();
  for (const key of AMBIENT_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value) base[key] = value;
  }
  if (name === DEFAULT_OCTOCODE_MCP_SERVER_NAME) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (key.startsWith('OCTOCODE_') || key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') base[key] = value;
    }
  }
  return { ...base, ...(config.env ?? {}) };
}

function cacheKey(ctx?: PiContext): string {
  return path.resolve(ctx?.cwd ?? process.cwd());
}

function projectMcpPath(cwd: string): string {
  return path.join(cwd, PI_CONFIG_DIR, 'agent', 'mcp.json');
}

function globalMcpPath(): string {
  return path.join(os.homedir(), PI_CONFIG_DIR, 'agent', 'mcp.json');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('args must be an array of strings');
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('args must be an array of strings');
    return item;
  });
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error('env must be an object');
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') throw new Error(`env.${key} must be a string`);
    out[key] = raw;
  }
  return out;
}

function parseServerConfig(name: string, value: unknown): McpServerConfig {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error(`invalid server name ${JSON.stringify(name)}; use letters, numbers, _, -, or .`);
  }
  if (!isPlainRecord(value)) throw new Error(`server ${name} must be an object`);
  const command = value['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(`server ${name}.command must be a non-empty string`);
  }
  const timeoutMs = value['timeoutMs'];
  return {
    command,
    args: parseStringArray(value['args']),
    env: parseStringRecord(value['env']),
    cwd: value['cwd'] === undefined ? undefined : String(value['cwd']),
    disabled: value['disabled'] === true,
    description: value['description'] === undefined ? undefined : String(value['description']),
    timeoutMs: timeoutMs === undefined ? undefined : Math.max(1_000, Math.min(120_000, Number(timeoutMs))),
  };
}

function parseConfigText(text: string): Map<string, McpServerConfig> {
  const json = JSON.parse(text) as unknown;
  if (!isPlainRecord(json)) throw new Error('mcp.json must contain an object');
  const rawServers = isPlainRecord(json['mcpServers'])
    ? json['mcpServers']
    : isPlainRecord(json['servers'])
      ? json['servers']
      : json;
  const servers = new Map<string, McpServerConfig>();
  for (const [name, raw] of Object.entries(rawServers)) {
    const server = parseServerConfig(name, raw);
    if (!server.disabled) servers.set(name, server);
  }
  return servers;
}

function readConfigFile(filePath: string): Map<string, McpServerConfig> | null {
  if (!fs.existsSync(filePath)) return null;
  return parseConfigText(fs.readFileSync(filePath, 'utf8'));
}

type McpScope = 'project' | 'global';

function scopeTargetPath(scope: McpScope, ctx?: PiContext): string {
  return scope === 'global' ? globalMcpPath() : projectMcpPath(ctx?.cwd ?? process.cwd());
}

/**
 * Return the container object inside a parsed mcp.json that holds the server map,
 * preserving the file's existing shape (`mcpServers` > `servers` > root object).
 */
function serverContainer(raw: Record<string, unknown>): Record<string, unknown> {
  if (isPlainRecord(raw['mcpServers'])) return raw['mcpServers'] as Record<string, unknown>;
  if (isPlainRecord(raw['servers'])) return raw['servers'] as Record<string, unknown>;
  // New/empty file: standardize on the canonical `mcpServers` wrapper.
  const container: Record<string, unknown> = {};
  raw['mcpServers'] = container;
  return container;
}

function writeMcpJsonAtomic(filePath: string, raw: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Insert or update a server in an mcp.json file. Validates via parseServerConfig. */
export function upsertServerInFile(filePath: string, name: string, serverJson: Record<string, unknown>): McpServerConfig {
  const parsed = parseServerConfig(name, serverJson); // throws on invalid name/command
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (text) {
      const json = JSON.parse(text) as unknown;
      if (!isPlainRecord(json)) throw new Error('mcp.json must contain an object');
      raw = json;
    }
  }
  const container = serverContainer(raw);
  // Persist only defined fields, in a stable shape.
  const entry: Record<string, unknown> = { command: parsed.command };
  if (parsed.args && parsed.args.length) entry['args'] = parsed.args;
  if (parsed.env && Object.keys(parsed.env).length) entry['env'] = parsed.env;
  if (parsed.cwd) entry['cwd'] = parsed.cwd;
  if (parsed.timeoutMs) entry['timeoutMs'] = parsed.timeoutMs;
  if (parsed.description) entry['description'] = parsed.description;
  if (parsed.disabled) entry['disabled'] = true;
  container[name] = entry;
  writeMcpJsonAtomic(filePath, raw);
  return parsed;
}

/** Remove a server from an mcp.json file. Returns false if it wasn't present. */
export function removeServerFromFile(filePath: string, name: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return false;
  const json = JSON.parse(text) as unknown;
  if (!isPlainRecord(json)) return false;
  const container = isPlainRecord(json['mcpServers'])
    ? (json['mcpServers'] as Record<string, unknown>)
    : isPlainRecord(json['servers'])
      ? (json['servers'] as Record<string, unknown>)
      : json;
  if (!(name in container)) return false;
  delete container[name];
  writeMcpJsonAtomic(filePath, json);
  return true;
}

async function loadMcpConfig(ctx?: PiContext): Promise<McpLoadedConfig> {
  const cwd = ctx?.cwd ?? process.cwd();
  const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : true;
  const defaultServer = buildDefaultOctocodeMcpServer();
  const servers = new Map<string, McpServerConfig>([[DEFAULT_OCTOCODE_MCP_SERVER_NAME, defaultServer]]);
  const sourcePath = defaultServer.command === 'npx' ? 'npx -y octocode-mcp@latest' : `node ${defaultServer.args?.[0] ?? 'octocode-mcp'}`;
  const sources: McpConfigSource[] = [{ scope: 'built-in', path: sourcePath, trusted: true }];
  const warnings: string[] = [];

  const globalPath = globalMcpPath();
  try {
    const globalServers = readConfigFile(globalPath);
    if (globalServers) {
      sources.push({ scope: 'global', path: globalPath, trusted: true });
      for (const [name, config] of globalServers) servers.set(name, config);
    }
  } catch (error) {
    warnings.push(`${globalPath}: ${(error as Error).message}`);
  }

  for (const candidate of [projectMcpPath(cwd)]) {
    if (!fs.existsSync(candidate)) continue;
    if (!trusted) {
      sources.push({ scope: 'project', path: candidate, trusted: false });
      warnings.push(`${candidate}: skipped because the project is not trusted`);
      continue;
    }
    try {
      const projectServers = readConfigFile(candidate);
      if (projectServers) {
        sources.push({ scope: 'project', path: candidate, trusted: true });
        for (const [name, config] of projectServers) servers.set(name, config);
      }
    } catch (error) {
      warnings.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  return { servers, sources, warnings };
}

function resolveServerCwd(config: McpServerConfig, ctx?: PiContext): string {
  const base = ctx?.cwd ?? process.cwd();
  if (!config.cwd) return base;
  return path.isAbsolute(config.cwd) ? config.cwd : path.resolve(base, config.cwd);
}

function requestOptions(config: McpServerConfig, signal?: AbortSignal): { timeout: number; signal?: AbortSignal } {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return signal ? { timeout, signal } : { timeout };
}

function normalizeServerConfig(name: string, config: McpServerConfig): McpServerConfig {
  if (name !== DEFAULT_OCTOCODE_MCP_SERVER_NAME) return config;
  // Always ensure full-text responses + the npm cache path; user env wins.
  return {
    ...config,
    env: { ...OCTOCODE_MCP_ENV_DEFAULTS, ...(config.env ?? {}) },
  };
}

/** Stable signature of the fields that determine the spawned process, for drift detection. */
export function configSignature(config: McpServerConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd ?? null,
    timeoutMs: config.timeoutMs ?? null,
  });
}

async function ensureConnection(name: string, config: McpServerConfig, ctx?: PiContext, signal?: AbortSignal): Promise<McpConnection> {
  config = normalizeServerConfig(name, config);
  const sig = configSignature(config);
  const existing = connections.get(name);
  if (existing) {
    // Reuse only if the config is unchanged; otherwise the live process is stale —
    // reconnect with the new config so mcp.json edits apply without an agent restart.
    if (existing.configSig === sig) return existing;
    await stopConnection(name);
    invalidateServerCache(name);
  }
  // Dedupe concurrent connects for the same server: two parallel MCPTool calls
  // would otherwise both spawn a process and orphan one of them.
  const pending = pendingConnections.get(name);
  if (pending) {
    const conn = await pending;
    if (conn.configSig === sig) return conn;
  }
  const connectPromise = connectServer(name, config, sig, ctx, signal);
  pendingConnections.set(name, connectPromise);
  try {
    return await connectPromise;
  } finally {
    pendingConnections.delete(name);
  }
}

async function connectServer(name: string, config: McpServerConfig, sig: string, ctx?: PiContext, signal?: AbortSignal): Promise<McpConnection> {
  const cwd = resolveServerCwd(config, ctx);
  assertPathAllowed(cwd, ctx?.cwd ?? process.cwd(), `mcp:${name}`);

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd,
    env: buildServerEnv(name, config),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'octocode-pi-extension', version: '1.0.0' }, { capabilities: {} });
  const connection: McpConnection = { name, config, configSig: sig, client, transport, stderr: [], startedAt: Date.now() };
  // Subscribe to tools/list_changed: when the server announces its tool set changed,
  // drop the cached catalog for this server so the next list/describe re-fetches it.
  try {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      invalidateServerCache(name);
    });
  } catch {
    // Older SDKs / servers without the capability — non-fatal.
  }
  const stderr = transport.stderr;
  stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    connection.stderr.push(text);
    while (connection.stderr.length > 20) connection.stderr.shift();
  });
  transport.onclose = () => {
    // Delete only our own entry — a reconnect may already own the slot.
    if (connections.get(name) === connection) connections.delete(name);
  };
  transport.onerror = (error) => {
    connection.stderr.push(error.message);
  };
  try {
    await client.connect(transport, requestOptions(config, signal));
  } catch (error) {
    const stderrText = connection.stderr.length > 0 ? `\nstderr:\n${connection.stderr.join('\n')}` : '';
    await client.close().catch(() => undefined);
    throw new Error(`${(error as Error).message}${stderrText}`);
  }
  connections.set(name, connection);
  return connection;
}

async function stopConnection(name: string): Promise<boolean> {
  const connection = connections.get(name);
  if (!connection) return false;
  connections.delete(name);
  await connection.client.close().catch(() => undefined);
  return true;
}

export function stopAllMcpServers(): number {
  const names = [...connections.keys()];
  for (const name of names) {
    const connection = connections.get(name);
    connections.delete(name);
    void connection?.client.close().catch(() => undefined);
  }
  // Drop the injected-catalog and recent-schema caches so a following session in the
  // same process (/new, /resume) cannot serve tools from now-stopped servers or keep
  // stale tool schemas inlined in the system prompt. The next warmMcpCatalog repopulates.
  cachedCatalogs.clear();
  recentToolUse.clear();
  return names.length;
}

// ─── mcp.json file watcher: hot-reload on external edits ──────────────────────
// The config is already re-read per MCPTool call and connections auto-reconnect on
// drift; the watcher makes that PROACTIVE — it detects external mcp.json edits, drops
// stale connections + cache immediately, and tells the user, so a long-idle connection
// never lingers on old config and the model's <mcp_cached_catalog> hint stays honest.

const configWatchers: import('node:fs').FSWatcher[] = [];
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Compare running connections against freshly-loaded config. Returns the servers whose
 * config drifted (need reconnect) and those removed from config (need shutdown). Pure and
 * unit-testable — the watcher applies the actions.
 */
export function computeReload(
  running: Map<string, string>,
  servers: Map<string, McpServerConfig>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [name, sig] of running) {
    const cfg = servers.get(name);
    if (!cfg) { removed.push(name); continue; }
    if (configSignature(normalizeServerConfig(name, cfg)) !== sig) changed.push(name);
  }
  return { changed, removed };
}

async function reconcileMcpConfig(ctx: PiContext | undefined, notify: NotifyFn): Promise<void> {
  try {
    const loaded = await loadMcpConfig(ctx);
    const running = new Map<string, string>();
    for (const [name, conn] of connections) running.set(name, conn.configSig);
    const { changed, removed } = computeReload(running, loaded.servers);
    for (const name of [...changed, ...removed]) {
      await stopConnection(name);
      invalidateServerCache(name);
    }
    invalidateCwdCache(ctx);
    if (changed.length || removed.length) {
      const parts: string[] = [];
      if (changed.length) parts.push(`reloaded ${changed.join(', ')}`);
      if (removed.length) parts.push(`removed ${removed.join(', ')}`);
      notify(ctx, `MCP config changed — ${parts.join('; ')}. New tools apply on the next MCPTool call.`, 'info');
    }
  } catch {
    // Best-effort: a bad transient config write must not crash the watcher.
  }
}

/**
 * Start watching the global + project mcp.json directories for changes. Debounced, and
 * best-effort (watching is disabled silently if the platform/dir doesn't allow it). Call
 * stopMcpConfigWatchers() on session shutdown.
 */
export function startMcpConfigWatcher(ctx: PiContext | undefined, notify: NotifyFn): number {
  stopMcpConfigWatchers();
  const cwd = ctx?.cwd ?? process.cwd();
  const dirs = new Set([
    path.dirname(globalMcpPath()),
    path.dirname(projectMcpPath(cwd)),
  ]);
  const globalDir = path.dirname(globalMcpPath());
  for (const dir of dirs) {
    try {
      // Only the global dir (under $HOME) may be created; project dirs are
      // watched only if they already exist — creating them pollutes user repos
      // as a watch side effect.
      if (dir === globalDir) fs.mkdirSync(dir, { recursive: true });
      else if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        // Match mcp.json and our atomic temp writes (mcp.json.<pid>.<ts>.tmp).
        if (filename && !String(filename).startsWith('mcp.json')) return;
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => { void reconcileMcpConfig(ctx, notify); }, 250);
      });
      configWatchers.push(watcher);
    } catch {
      // Watching is best-effort; per-call re-read + drift reconnect remain the safety net.
    }
  }
  return configWatchers.length;
}

export function stopMcpConfigWatchers(): number {
  const count = configWatchers.length;
  for (const watcher of configWatchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  configWatchers.length = 0;
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }
  return count;
}

/**
 * Interop fallback for MCP call results: octocode-mcp (without
 * OCTOCODE_MCP_FULL_TEXT) replaces text content with a compact
 * "structuredContent available …" stub while the real data lives in
 * structuredContent. Pi renders only text blocks, so when the stub sentinel is
 * detected (or content is empty) and structuredContent exists, surface the
 * structured payload instead — otherwise the model researches blind.
 */
export function resolveMcpCallText(payload: unknown): string {
  if (!isPlainRecord(payload)) return stringify(payload);
  const content = Array.isArray(payload['content']) ? payload['content'] : [];
  const textBlocks = content.filter(
    (item): item is Record<string, unknown> => isPlainRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string',
  );
  const structured = payload['structuredContent'];
  const hasStructured = structured !== undefined && structured !== null;
  const onlyStub =
    textBlocks.length > 0 &&
    textBlocks.every((item) => String(item['text']).startsWith('structuredContent available'));
  if (hasStructured && (textBlocks.length === 0 || onlyStub)) {
    return stringify(structured);
  }
  if (textBlocks.length > 0 && textBlocks.length === content.length) {
    return stringify(textBlocks.map((item) => String(item['text'])).join('\n'));
  }
  return stringify(payload);
}

function stringify(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n… truncated ${text.length - MAX_TEXT_CHARS} chars`;
}

function result(text: string, details?: unknown, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text }], details, isError };
}

/**
 * Discovery-cache TTL. The cache is invalidated on stop/restart/add/remove and on
 * `tools/list_changed`, but a server may change its tool set WITHOUT emitting that
 * notification; the TTL bounds how long a stale entry is served before a forced re-list.
 */
const CACHE_TTL_MS = 10 * 60_000;

function cacheListedCatalog(ctx: PiContext | undefined, listed: ListedMcpServer[]): void {
  if (listed.length === 0) return;
  const key = cacheKey(ctx);
  const now = Date.now();
  const existing = new Map((cachedCatalogs.get(key) ?? []).map((entry) => [entry.name, entry]));
  for (const entry of listed) existing.set(entry.name, { ...entry, cachedAt: now });
  cachedCatalogs.set(key, [...existing.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

/** True when a cached entry is still within the TTL window. */
export function isFresh(entry: ListedMcpServer, now = Date.now()): boolean {
  return entry.cachedAt === undefined || now - entry.cachedAt <= CACHE_TTL_MS;
}

/** Drop the entire cached catalog for a cwd (used when servers are added/removed/stopped). */
function invalidateCwdCache(ctx?: PiContext): void {
  cachedCatalogs.delete(cacheKey(ctx));
}

/**
 * Drop one server from every cached catalog. Used on restart / stop / config-drift /
 * tools/list_changed, where we lack the originating cwd but must not serve a stale entry.
 */
function invalidateServerCache(name: string): void {
  for (const [key, entries] of cachedCatalogs) {
    const next = entries.filter((entry) => entry.name !== name);
    if (next.length !== entries.length) {
      if (next.length === 0) cachedCatalogs.delete(key);
      else cachedCatalogs.set(key, next);
    }
  }
}

// ─── Prompt-budget caps for the every-turn <mcp_cached_catalog> block ─────────
//
// The addendum is re-injected every turn, so every byte here is paid on every
// request for the rest of the session. Compact by default: names, brief
// descriptions, and schema field summaries. Exact inputSchema JSON is inlined
// only for tools the agent recently exercised via MCPTool call/describe — the
// set where exact arguments are actually load-bearing.
const CATALOG_INSTRUCTIONS_CAP = 600;
const CATALOG_DESCRIPTION_CAP = 300;
const CATALOG_SERVER_ENTRY_CAP = 4_000;
/** How many recently used tools keep their exact schema inlined (LRU per cwd). */
const RECENT_TOOL_SCHEMA_CAP = 16;

const recentToolUse = new Map<string, Map<string, number>>();

/**
 * Record that a tool was exercised via MCPTool call/describe so its exact
 * inputSchema is worth inlining in the every-turn catalog block. LRU-bounded:
 * only the most recent RECENT_TOOL_SCHEMA_CAP tools per cwd keep full schemas.
 */
export function markMcpToolUsed(ctx: PiContext | undefined, server: string, tool: string): void {
  const key = cacheKey(ctx);
  const used = recentToolUse.get(key) ?? new Map<string, number>();
  const toolKey = `${server}/${tool}`;
  used.delete(toolKey);
  used.set(toolKey, Date.now());
  while (used.size > RECENT_TOOL_SCHEMA_CAP) {
    const oldest = used.keys().next().value as string;
    used.delete(oldest);
  }
  recentToolUse.set(key, used);
}

function wasMcpToolRecentlyUsed(ctx: PiContext | undefined, server: string, tool: string): boolean {
  return recentToolUse.get(cacheKey(ctx))?.has(`${server}/${tool}`) ?? false;
}

function capCatalogText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

function formatCachedCatalogEntry(entry: ListedMcpServer, ctx: PiContext | undefined, now = Date.now()): string {
  const lines = [`server: ${entry.name}`];
  const freshness = isFresh(entry, now) ? 'fresh' : 'stale — re-run MCPTool list/describe before relying on exact current schemas';
  lines.push(`cache: ${freshness}`);
  // No cachedAt timestamp here: any byte change in the system prompt invalidates
  // the provider conversation cache, and the fresh/stale label already carries
  // the model-facing signal.
  if (entry.instructions) lines.push(`instructions: ${capCatalogText(entry.instructions, CATALOG_INSTRUCTIONS_CAP)}`);
  for (const rawTool of entry.tools) {
    if (!isPlainRecord(rawTool)) continue;
    const toolName = String(rawTool['name'] ?? '');
    lines.push(`tool: ${toolName}`);
    if (typeof rawTool['description'] === 'string') lines.push(`description: ${capCatalogText(rawTool['description'], CATALOG_DESCRIPTION_CAP)}`);
    if (rawTool['inputSchema'] !== undefined) {
      if (wasMcpToolRecentlyUsed(ctx, entry.name, toolName)) {
        lines.push(stringify({ inputSchema: rawTool['inputSchema'] }));
      } else {
        const summary = summarizeSchema(rawTool).trim();
        if (summary) lines.push(summary);
      }
    }
  }
  const text = lines.join('\n');
  if (text.length <= CATALOG_SERVER_ENTRY_CAP) return text;
  return `${text.slice(0, CATALOG_SERVER_ENTRY_CAP)}\n…[truncated ${text.length - CATALOG_SERVER_ENTRY_CAP} chars — run MCPTool list server:${entry.name} for the full catalog]`;
}

/**
 * Patch ~/.pi/agent/mcp.json so that Pi's own MCP client starts the octocode
 * server with the correct npm cache env vars. Without these, Pi uses the default
 * npm cache (~/.npm/_npx/) which may not have the optional darwin-arm64 native
 * addon, causing the server to crash on startup.
 *
 * Also ensures OCTOCODE_MCP_FULL_TEXT=true so tool results carry full text —
 * without it octocode-mcp emits a compact "structuredContent available" stub
 * that Pi's MCP client never expands, leaving the model with counts, not data.
 *
 * Idempotent: only writes when the env vars are missing. Silent on errors.
 */
/**
 * Concise stderr warning for best-effort MCP paths. Never throws and never
 * touches the TUI (stderr only) — it makes an otherwise-silent config failure
 * observable in logs/debug output without blocking session start.
 */
function warnMcp(message: string): void {
  try { process.stderr.write(`[octocode-mcp] ${message}\n`); } catch { /* stderr unavailable */ }
}

export function patchGlobalMcpOctocodeEnv(configPath = globalMcpPath()): void {
  try {
    if (!fs.existsSync(configPath)) return; // No global mcp.json — nothing to patch.

    // Re-parse as raw JSON so we can write it back with minimal diff.
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { warnMcp(`global mcp.json is not valid JSON (${configPath}); skipping env patch`); return; }

    const servers = raw['mcpServers'];
    if (!isPlainRecord(servers)) return;
    const entry = servers[DEFAULT_OCTOCODE_MCP_SERVER_NAME];
    if (!isPlainRecord(entry)) return;

    // Check whether every required env var is already present.
    const env = isPlainRecord(entry['env']) ? entry['env'] : {};
    const missing = Object.keys(OCTOCODE_MCP_ENV_DEFAULTS).filter(
      (key) => !(typeof env[key] === 'string' && (env[key] as string).length > 0),
    );
    if (missing.length === 0) return; // Already patched.

    // Merge — user-supplied values take precedence.
    entry['env'] = { ...OCTOCODE_MCP_ENV_DEFAULTS, ...env };
    servers[DEFAULT_OCTOCODE_MCP_SERVER_NAME] = entry;
    raw['mcpServers'] = servers;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  } catch (err) {
    // Must not block session start, but make the failure observable.
    warnMcp(`failed to patch global mcp.json env: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * Pre-warm every configured MCP server catalog at session start so that the
 * <mcp_cached_catalog> block is already populated when before_agent_start fires
 * for turn 1. Non-blocking — errors are swallowed so a slow/missing MCP server
 * never prevents the session from starting.
 */
export async function warmMcpCatalog(ctx?: PiContext, signal?: AbortSignal): Promise<void> {
  const listed: ListedMcpServer[] = [];
  try {
    const loaded = await loadMcpConfig(ctx);
    for (const [name, config] of loaded.servers) {
      try {
        listed.push(await listServerTools(name, config, ctx, signal));
      } catch {
        // Best-effort per server: a slow/broken MCP must not prevent the rest of
        // the catalog from being cached or block session start.
      }
    }
    cacheListedCatalog(ctx, listed);
  } catch (err) {
    // Best-effort: a missing/unreadable MCP config must not block session start,
    // but a genuine load error (e.g. malformed mcp.json) is worth surfacing.
    warnMcp(`catalog warm failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

/** Cheap counts (servers + total tools) from the in-memory MCP catalog cache. */
export function getCachedMcpCounts(ctx?: PiContext): { servers: number; tools: number } {
  const cached = cachedCatalogs.get(cacheKey(ctx));
  if (!cached?.length) return { servers: 0, tools: 0 };
  const tools = cached.reduce((sum, entry) => sum + (Array.isArray(entry.tools) ? entry.tools.length : 0), 0);
  return { servers: cached.length, tools };
}

export function getCachedMcpCatalogAddendum(ctx?: PiContext): string {
  const cached = cachedCatalogs.get(cacheKey(ctx));
  if (!cached?.length) return '';
  const now = Date.now();
  return [
    '<mcp_cached_catalog>',
    'Compact cached MCP catalog: server instructions plus tool names, brief descriptions, and schema field summaries from session warmup or prior MCPTool calls in this Pi process. This block is re-injected every turn so it survives compaction. Exact inputSchema JSON is inlined only for recently used/described tools; treat stale entries as hints and run MCPTool list/describe when the exact current schema matters.',
    ...cached.map((entry) => formatCachedCatalogEntry(entry, ctx, now)),
    '</mcp_cached_catalog>',
  ].join('\n');
}

export const __test__ = {
  setCachedMcpCatalog(ctx: PiContext | undefined, entries: ListedMcpServer[]): void {
    cachedCatalogs.set(cacheKey(ctx), entries);
  },
  clearCachedMcpCatalog(): void {
    cachedCatalogs.clear();
  },
  resetRecentMcpToolUse(): void {
    recentToolUse.clear();
  },
};

function formatConfig(config: McpLoadedConfig, cwd = process.cwd()): string {
  const lines = ['Octocode MCP config'];
  lines.push(`servers: ${config.servers.size === 0 ? 'none' : [...config.servers.keys()].join(', ')}`);
  lines.push(`sources: ${config.sources.length === 0 ? 'none' : config.sources.map((s) => `${s.scope}:${s.path}${s.trusted ? '' : ' (untrusted)'}`).join('; ')}`);
  if (config.warnings.length > 0) lines.push(`warnings:\n- ${config.warnings.join('\n- ')}`);
  lines.push(`canonical project path: ${projectMcpPath(cwd)}`);
  return lines.join('\n');
}

function formatMcpServerStatus(config: McpLoadedConfig): string {
  const running = [...connections.keys()];
  return [
    'Octocode MCP status',
    `configured: ${config.servers.size === 0 ? 'none' : [...config.servers.keys()].join(', ')}`,
    `running: ${running.length === 0 ? 'none' : running.join(', ')}`,
    config.warnings.length ? `warnings:\n- ${config.warnings.join('\n- ')}` : undefined,
  ].filter(Boolean).join('\n');
}

export interface ListedMcpServer {
  name: string;
  instructions?: string;
  tools: unknown[];
  text: string;
  /** When this catalog entry was fetched; drives the cache TTL. */
  cachedAt?: number;
}

function summarizeSchema(tool: Record<string, unknown>): string {
  const schema = tool['inputSchema'];
  if (!isPlainRecord(schema)) return '';
  const required = Array.isArray(schema['required']) ? schema['required'].map(String).filter(Boolean) : [];
  const properties = isPlainRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
  const fields = required.length > 0 ? required : properties;
  return fields.length > 0 ? ` schema: ${fields.slice(0, 8).join(', ')}${fields.length > 8 ? ', …' : ''}` : ' schema: object';
}

async function listServerTools(name: string, config: McpServerConfig, ctx: PiContext | undefined, signal: AbortSignal | undefined): Promise<ListedMcpServer> {
  const connection = await ensureConnection(name, config, ctx, signal);
  const payload = await connection.client.listTools(undefined, requestOptions(config, signal));
  const instructions = connection.client.getInstructions();
  const lines = [`${name}: ${payload.tools.length} tool(s)`];
  if (instructions) lines.push(`instructions: ${instructions.slice(0, 300)}`);
  for (const rawTool of payload.tools) {
    const tool = rawTool as Record<string, unknown>;
    const description = typeof tool['description'] === 'string' ? tool['description'] : '';
    lines.push(`- ${String(tool['name'])}: ${description.slice(0, 180)}${summarizeSchema(tool)}`);
  }
  return { name, instructions, tools: payload.tools, text: lines.join('\n') };
}

export async function handleMcpAction(params: Record<string, unknown>, signal?: AbortSignal, ctx?: PiContext): Promise<ToolCallResult> {
  const action = (params['action'] ?? 'list') as McpAction;
  const loaded = await loadMcpConfig(ctx);
  const serverName = typeof params['server'] === 'string' ? params['server'] : undefined;

  if (action === 'config') return result(formatConfig(loaded, ctx?.cwd ?? process.cwd()), { sources: loaded.sources, warnings: loaded.warnings });
  if (action === 'status') return result(formatMcpServerStatus(loaded), { running: [...connections.keys()], warnings: loaded.warnings });
  if (action === 'stop') {
    const stopped = serverName ? await stopConnection(serverName) : stopAllMcpServers() > 0;
    if (serverName) invalidateServerCache(serverName);
    else invalidateCwdCache(ctx);
    return result(serverName ? `${serverName}: ${stopped ? 'stopped' : 'not running'}` : `stopped ${stopped ? 'MCP servers' : 'no MCP servers'}`);
  }

  if (action === 'add') {
    if (!serverName) return result('MCPTool add requires server', undefined, true);
    const scope: McpScope = params['scope'] === 'global' ? 'global' : 'project';
    if (scope === 'project') {
      const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : true;
      if (!trusted) return result('Refusing to write project mcp.json: project is not trusted. Use scope:"global" or trust the project.', undefined, true);
    }
    const cfg = isPlainRecord(params['config']) ? params['config'] : undefined;
    if (!cfg) return result('MCPTool add requires a config object, e.g. {command, args, env, cwd}.', undefined, true);
    if (scope === 'global') {
      // Adding a server means spawning an arbitrary local process on the next
      // call — that decision belongs to the user, not the model. Hard gate:
      // interactive approval, or refuse when no UI is available.
      const cmd = typeof cfg['command'] === 'string' ? cfg['command'] : '?';
      const argText = Array.isArray(cfg['args']) ? (cfg['args'] as unknown[]).map(String).join(' ') : '';
      const choice = await runSelectOverlay(ctx, {
        title: `Add MCP server "${serverName}" to GLOBAL mcp.json? It will run locally as: ${cmd} ${argText}`.trim(),
        items: [
          { value: 'deny', label: 'Deny', description: 'Do not modify ~/.pi/agent/mcp.json' },
          { value: 'allow', label: 'Allow', description: 'Write the server config; it spawns on next MCPTool call' },
        ],
      });
      if (choice !== 'allow') {
        const why = choice === undefined ? 'no interactive UI to approve it' : 'the user denied it';
        return result(`Global MCP add refused: ${why}. Ask the user to edit ~/.pi/agent/mcp.json directly if they want this server.`, undefined, true);
      }
    }
    const target = scopeTargetPath(scope, ctx);
    let parsed: McpServerConfig;
    try {
      parsed = upsertServerInFile(target, serverName, cfg);
    } catch (error) {
      return result(`MCPTool add failed: ${(error as Error).message}`, undefined, true);
    }
    // Apply immediately: drop any stale connection + cache so the next call spawns fresh.
    await stopConnection(serverName);
    invalidateServerCache(serverName);
    invalidateCwdCache(ctx);
    const shadowNote = serverName === DEFAULT_OCTOCODE_MCP_SERVER_NAME
      ? ' (overrides the built-in octocode default — env defaults for full-text + npm cache are still merged in)'
      : '';
    return result(`${serverName}: added to ${scope} mcp.json (${target}) as \`${parsed.command}${parsed.args?.length ? ' ' + parsed.args.join(' ') : ''}\`.${shadowNote} Active on next MCPTool call — no agent restart needed.`);
  }

  if (action === 'remove') {
    if (!serverName) return result('MCPTool remove requires server', undefined, true);
    if (serverName === DEFAULT_OCTOCODE_MCP_SERVER_NAME) {
      return result(`"${DEFAULT_OCTOCODE_MCP_SERVER_NAME}" is the built-in default MCP server (npx octocode-mcp) and cannot be removed. You may override its config with action:add, or stop the live process with action:stop.`, undefined, true);
    }
    const scope: McpScope = params['scope'] === 'global' ? 'global' : 'project';
    if (scope === 'project') {
      const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : true;
      if (!trusted) return result('Refusing to write project mcp.json: project is not trusted.', undefined, true);
    }
    const target = scopeTargetPath(scope, ctx);
    let removed: boolean;
    try {
      removed = removeServerFromFile(target, serverName);
    } catch (error) {
      return result(`MCPTool remove failed: ${(error as Error).message}`, undefined, true);
    }
    await stopConnection(serverName);
    invalidateServerCache(serverName);
    invalidateCwdCache(ctx);
    const note = serverName === DEFAULT_OCTOCODE_MCP_SERVER_NAME ? ' (note: the built-in octocode default re-appears unless overridden)' : '';
    return result(removed ? `${serverName}: removed from ${scope} mcp.json (${target}).${note}` : `${serverName}: not present in ${scope} mcp.json (${target}).${note}`, undefined, !removed);
  }

  if (serverName && !loaded.servers.has(serverName)) {
    return result(`Unknown MCP server: ${serverName}\nConfigured: ${[...loaded.servers.keys()].join(', ') || 'none'}`, loaded, true);
  }

  if (action === 'restart') {
    if (!serverName) return result('mcp restart requires server', undefined, true);
    await stopConnection(serverName);
    invalidateServerCache(serverName);
    await ensureConnection(serverName, loaded.servers.get(serverName)!, ctx, signal);
    return result(`${serverName}: restarted`);
  }

  if (action === 'list' || action === 'describe') {
    if (loaded.servers.size === 0) return result(formatConfig(loaded, ctx?.cwd ?? process.cwd()));
    const names = serverName ? [serverName] : [...loaded.servers.keys()];
    const listed: ListedMcpServer[] = [];
    for (const name of names) listed.push(await listServerTools(name, loaded.servers.get(name)!, ctx, signal));
    if (action === 'describe') {
      if (!serverName) return result('MCPTool describe requires server', undefined, true);
      const toolName = typeof params['tool'] === 'string' ? params['tool'] : undefined;
      if (!toolName) return result('MCPTool describe requires tool', undefined, true);
      const server = listed[0]!;
      const tool = server.tools.find((candidate) => isPlainRecord(candidate) && candidate['name'] === toolName);
      if (!tool) return result(`Unknown MCP tool: ${serverName}/${toolName}`, { server, warnings: loaded.warnings }, true);
      // An explicit describe means exact arguments matter for this tool — keep
      // its full schema inlined in the every-turn catalog block from now on.
      markMcpToolUsed(ctx, serverName, toolName);
      cacheListedCatalog(ctx, listed);
      return result(stringify({ server: server.name, instructions: server.instructions, tool }), { server: server.name, instructions: server.instructions, tool, warnings: loaded.warnings });
    }
    cacheListedCatalog(ctx, listed);
    return result(listed.map((entry) => entry.text).join('\n\n'), { servers: listed, warnings: loaded.warnings });
  }

  if (action === 'call') {
    if (!serverName) return result('MCPTool call requires server', undefined, true);
    const tool = params['tool'];
    if (typeof tool !== 'string' || tool.trim().length === 0) return result('MCPTool call requires tool', undefined, true);
    const config = loaded.servers.get(serverName)!;
    const connection = await ensureConnection(serverName, config, ctx, signal);
    const argumentsPayload = isPlainRecord(params['arguments']) ? params['arguments'] : {};
    const payload = await connection.client.callTool({ name: tool, arguments: argumentsPayload }, undefined, requestOptions(config, signal));
    // A successful call makes this tool "hot": inline its exact schema in the
    // every-turn catalog block so follow-up calls need no re-describe.
    markMcpToolUsed(ctx, serverName, tool);
    // Stale-check: when the agent reads files through the octocode MCP server,
    // record the same read-state that the native localGetFileContent tool would.
    // This keeps the edit tool's stale-guard working when research routes through MCPTool.
    if (serverName === DEFAULT_OCTOCODE_MCP_SERVER_NAME && tool === 'localGetFileContent') {
      const cwd = ctx?.cwd ?? process.cwd();
      const queries = Array.isArray(argumentsPayload['queries']) ? argumentsPayload['queries'] : [];
      await Promise.all(queries.map(async (q: unknown) => {
        const p = isPlainRecord(q) ? q['path'] : undefined;
        if (typeof p === 'string' && p.trim().length > 0) {
          await recordFileReadState(p, cwd).catch(() => undefined);
        }
      }));
    }
    return result(resolveMcpCallText(payload), payload);
  }

  return result(`Unknown MCP action: ${action}`, undefined, true);
}

function formatMcpTarget(args: unknown): { action: string; target: string } {
  const p = isPlainRecord(args) ? args : {};
  const action = String(p['action'] ?? 'list');
  const target = [p['server'], p['tool']].filter(Boolean).join('/') || 'configured servers';
  return { action, target };
}

function clip(text: string, width: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(1, width - 1))}…`;
}

function renderCall(args: unknown, theme?: PiTheme): RenderCallReturn {
  const p = isPlainRecord(args) ? args : {};
  const server = typeof p['server'] === 'string' ? p['server'] : DEFAULT_OCTOCODE_MCP_SERVER_NAME;
  if (p['action'] === 'call' && server === DEFAULT_OCTOCODE_MCP_SERVER_NAME && typeof p['tool'] === 'string') {
    return buildOctocodeRenderCall(p['tool'], p['arguments'], theme);
  }

  const { action, target } = formatMcpTarget(args);
  return makeRenderer((width) => {
    const line = `mcp ${action} · ${target}`;
    return [theme?.fg ? theme.fg('dim', clip(line, width)) : clip(line, width)];
  });
}

function renderResult(resultValue: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme, context?: RenderContext): RenderCallReturn {
  const args = isPlainRecord(context?.args) ? context.args : {};
  const server = typeof args['server'] === 'string' ? args['server'] : DEFAULT_OCTOCODE_MCP_SERVER_NAME;
  if (args['action'] === 'call' && server === DEFAULT_OCTOCODE_MCP_SERVER_NAME && typeof args['tool'] === 'string') {
    return buildOctocodeRenderResult(args['tool'], resultValue, opts, theme);
  }

  const { action, target } = formatMcpTarget(context?.args);
  // In-flight (streaming, or the stdio server still spawning): show a running
  // row instead of fabricating a completed "MCP result" line.
  if (opts.isPartial) {
    return makeRenderer((width) => {
      const line = `mcp ${action} · ${target} · running…`;
      return [theme?.fg ? theme.fg('warning', clip(line, width)) : clip(line, width)];
    });
  }
  const lines = (resultValue.content[0] as { text?: string } | undefined)?.text?.split('\n').filter(Boolean) ?? ['MCP result'];
  const head = lines[0] ?? 'MCP result';
  const second = lines.find((line) => /^[-•]\s+|\w+:\s/.test(line));
  const prefix = resultValue.isError ? 'mcp error' : `mcp ${action}`;
  return makeRenderer((width) => {
    const color = resultValue.isError ? 'error' : 'dim';
    const rendered = [`${prefix} · ${target} · ${head}`];
    if (second && second !== head) rendered.push(`  ${second}`);
    return rendered.map((line) => theme?.fg ? theme.fg(color, clip(line, width)) : clip(line, width));
  });
}

export function registerMcpTool(
  pi: PiInstance,
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: (pi: PiInstance, registeredToolNames: Set<string>, toolDefinition: ToolDefinition) => void,
): void {
  const parameters = Type.Object({
    action: Type.Optional(stringEnumSchema(
      Type,
      ['list', 'describe', 'call', 'status', 'restart', 'stop', 'config', 'add', 'remove'],
      'MCP action. list/describe/call to use servers; add/remove/restart/stop to manage them (applied without an agent restart).',
    ) as TSchema),
    server: Type.Optional(Type.String({ description: 'MCP server name. For add/remove this is the key written to mcp.json.' })),
    tool: Type.Optional(Type.String({ description: 'MCP tool name for action:call.' })),
    arguments: Type.Optional(Type.Object({}, { description: 'Arguments object passed to the MCP tool (action:call).', additionalProperties: true })),
    config: Type.Optional(Type.Object({}, { description: 'Server config for action:add: {command, args?, env?, cwd?, timeoutMs?, description?}.', additionalProperties: true })),
    scope: Type.Optional(stringEnumSchema(
      Type,
      ['project', 'global'],
      'add/remove target: "project" (.pi/agent/mcp.json, trusted only; default) or "global" (~/.pi/agent/mcp.json).',
    ) as TSchema),
  }, { additionalProperties: false }) as TSchema;

  const execute = async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, _onUpdate?: unknown, ctx?: PiContext): Promise<ToolCallResult> => {
    try {
      ctx?.ui?.setStatus?.(MCP_STATUS_NAME, 'mcp · running');
      return await handleMcpAction(params, signal, ctx);
    } catch (error) {
      return result(`[MCP_ERROR] ${(error as Error).message}`, undefined, true);
    } finally {
      ctx?.ui?.setStatus?.(MCP_STATUS_NAME, undefined);
    }
  };

  const common = {
    label: 'MCPTool',
    description: 'Dedicated MCP client: list, describe, call, and manage stdio MCP servers (add, remove, restart, stop, status, config). Config is read fresh per call and connections auto-reconnect on config drift, so add/remove/edit of mcp.json apply WITHOUT restarting the agent. Discovery is cached and auto-invalidated on changes.',
    promptSnippet: 'MCPTool is the dedicated MCP gateway. Main agent has built-in octocode MCP plus configured MCPs; spawned agents may use the Octocode CLI instead. Use MCPTool action:list/describe to read server instructions, tool descriptions, and input schemas before action:call. Never guess server/tool/arguments.',
    promptGuidelines: [
      'MCPTool default server: octocode = pinned local octocode-mcp binary (npx -y octocode-mcp@latest fallback), lazy-started only when listed/called.',
      'MCPTool config is JSON at <workspace>/.pi/agent/mcp.json or ~/.pi/agent/mcp.json. Project config loads only in trusted projects.',
      'MCPTool action:list returns server instructions plus every tool name, description, and schema summary; details.servers[].tools contains full MCP inputSchema objects.',
      'Use MCPTool action:describe for one tool when exact schema matters before action:call.',
      'Manage servers at runtime without restarting the agent: action:add ({server, config:{command,...}, scope}) writes mcp.json and applies on the next call; action:remove deletes it; restart/stop reconnect. Live connections auto-reconnect when mcp.json changes.',
      'mcp.json (global + project) is watched: external edits hot-reload automatically \u2014 stale connections/cache are dropped and the user is notified; no agent restart needed. The built-in `octocode` server (npx octocode-mcp) is the default and cannot be removed.',
      'Treat MCP servers as arbitrary code. Do not add or run untrusted MCP config without user approval; project-scope writes require a trusted project.',
    ],
    parameters,
    execute,
    renderCall,
    renderResult,
  } satisfies Omit<ToolDefinition, 'name'>;

  registerFn(pi, registeredToolNames, { name: 'MCPTool', ...common });
}

export async function handleOctocodeMcpCommand(args: string, ctx: PiCommandContext | undefined, notify: NotifyFn): Promise<void> {
  const [actionRaw, server] = args.trim().split(/\s+/).filter(Boolean);
  const action = (actionRaw || 'status') as McpAction;
  const res = await handleMcpAction({ action, server }, undefined, ctx);
  notify(ctx, (res.content[0] as { text?: string } | undefined)?.text ?? 'MCP command completed', res.isError ? 'error' : 'info');
}
