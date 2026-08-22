import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { NotifyFn, PiCommandContext, PiContext, PiInstance, PiTheme, RenderCallReturn, RenderContext, ToolCallResult, ToolDefinition, TSchema } from '../types.js';
import { capMapSize } from '../utils.js';
import {
  DEFAULT_OCTOCODE_MCP_SERVER_NAME,
  buildServerEnv,
  configSignature,
  globalMcpPath,
  isPlainRecord,
  loadMcpConfig,
  projectMcpPath,
  normalizeServerConfig,
  removeServerFromFile,
  requestOptions,
  resolveServerCwd,
  scopeTargetPath,
  upsertServerInFile,
  type McpConfigSource,
  type McpLoadedConfig,
  type McpScope,
  type McpServerConfig,
} from './mcp-config.js';
export {
  OCTOCODE_MCP_ENV_DEFAULTS,
  configSignature,
  patchGlobalMcpOctocodeEnv,
  removeServerFromFile,
  upsertServerInFile,
} from './mcp-config.js';
import { assertPathAllowed } from './path-guard.js';
import { stringEnumSchema } from './schema-helpers.js';
import { runSelectOverlay } from './ui-overlays.js';
import { recordFileReadState } from './file-state.js';
import { buildOctocodeRenderCall, buildOctocodeRenderResult, makeRenderer, truncateToWidth } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];

type McpAction = 'list' | 'describe' | 'call' | 'status' | 'restart' | 'stop' | 'config' | 'add' | 'remove';

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
const MAX_TEXT_CHARS = 24_000;
const connections = new Map<string, McpConnection>();
const pendingConnections = new Map<string, Promise<McpConnection>>();
const cachedCatalogs = new Map<string, ListedMcpServer[]>();
/** Bound the cwd-keyed caches so a long-lived process visiting many cwds cannot grow them without limit. */
const MAX_CACHED_CWDS = 32;

function cacheKey(ctx?: PiContext): string {
  return path.resolve(ctx?.cwd ?? process.cwd());
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
  // Drop the injected-catalog cache so a following session in the same process
  // (/new, /resume) cannot serve tools from now-stopped servers in the system
  // prompt. The next warmMcpCatalog repopulates.
  cachedCatalogs.clear();
  return names.length;
}

// ─── mcp.json file watcher: hot-reload on external edits ──────────────────────
// The config is already re-read per MCPTool call and connections auto-reconnect on
// drift; the watcher makes that PROACTIVE — it detects external mcp.json edits, drops
// stale connections + cache immediately, and tells the user, so a long-idle connection
// never lingers on old config and the model's <mcp_catalog> block stays honest.

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
      const watcher = fs.watch(dir, { persistent: false }, (_event: string, filename: string | Buffer | null) => {
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

function cacheListedCatalog(ctx: PiContext | undefined, listed: ListedMcpServer[]): void {
  if (listed.length === 0) return;
  const key = cacheKey(ctx);
  const now = Date.now();
  const existing = new Map((cachedCatalogs.get(key) ?? []).map((entry) => [entry.name, entry]));
  for (const entry of listed) existing.set(entry.name, { ...entry, cachedAt: now });
  // delete-then-set makes the cwd the most-recently-used key, so capMapSize evicts the coldest cwd.
  cachedCatalogs.delete(key);
  // Deterministic order (octocode default first, then alphabetical): the rendered
  // <mcp_catalog> block must be byte-identical for identical content.
  cachedCatalogs.set(key, [...existing.values()].sort((a, b) => {
    if (a.name === DEFAULT_OCTOCODE_MCP_SERVER_NAME) return -1;
    if (b.name === DEFAULT_OCTOCODE_MCP_SERVER_NAME) return 1;
    return a.name.localeCompare(b.name);
  }));
  capMapSize(cachedCatalogs, MAX_CACHED_CWDS);
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

// ─── Full <mcp_catalog> block: complete, byte-stable, cache-friendly ──────────
//
// The catalog is injected into the system prompt every turn, so its BYTES must
// stay identical across turns — any churn (timestamps, fresh/stale flips,
// usage-dependent schema inlining) invalidates the provider prompt cache from
// that point on. Full discovery at init (instructions, tools, exact input
// schemas) is paid once per cache window; the block only changes when the MCP
// config genuinely changes (mcp.json edit, add/remove/restart, list_changed).
// Caps are a safety net against a rogue server, not a compaction strategy —
// the built-in octocode server (~60k chars total) must fit untruncated.
const CATALOG_INSTRUCTIONS_CAP = 4_000;
const CATALOG_DESCRIPTION_CAP = 2_000;
const CATALOG_SCHEMA_CAP = 8_000;
const CATALOG_SERVER_ENTRY_CAP = 80_000;

function capCatalogText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

function formatCachedCatalogEntry(entry: ListedMcpServer): string {
  const lines = [`server: ${entry.name}`];
  if (entry.instructions) lines.push(`instructions: ${capCatalogText(entry.instructions, CATALOG_INSTRUCTIONS_CAP)}`);
  for (const rawTool of entry.tools) {
    if (!isPlainRecord(rawTool)) continue;
    const toolName = String(rawTool['name'] ?? '');
    lines.push(`tool: ${toolName}`);
    if (typeof rawTool['description'] === 'string') lines.push(`description: ${capCatalogText(rawTool['description'], CATALOG_DESCRIPTION_CAP)}`);
    if (rawTool['inputSchema'] !== undefined) {
      // Compact JSON, not pretty-printed: ~30% fewer prompt bytes, same schema.
      const schema = JSON.stringify(rawTool['inputSchema']);
      lines.push(schema.length <= CATALOG_SCHEMA_CAP
        ? `inputSchema: ${schema}`
        : `inputSchema: ${schema.slice(0, CATALOG_SCHEMA_CAP)}…[schema truncated — run MCPTool describe server:${entry.name} tool:${toolName} for the full schema]`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= CATALOG_SERVER_ENTRY_CAP) return text;
  return `${text.slice(0, CATALOG_SERVER_ENTRY_CAP)}\n…[truncated ${text.length - CATALOG_SERVER_ENTRY_CAP} chars — run MCPTool list server:${entry.name} for the full catalog]`;
}


/** In-flight init discoveries keyed by cwd, so turn 1 can await the warm started at session_start. */
const warmsInFlight = new Map<string, Promise<void>>();

function warnMcpWarmFailure(message: string): void {
  try { process.stderr.write(`[octocode-mcp] ${message}\n`); } catch { /* stderr unavailable */ }
}

/**
 * Full MCP discovery at session init: connect every configured server and cache
 * its instructions, tools, and exact input schemas so the <mcp_catalog> block is
 * populated for turn 1. Deduped per cwd (concurrent calls share one discovery);
 * errors are swallowed so a slow/missing MCP server never prevents the session
 * from starting.
 */
export function warmMcpCatalog(ctx?: PiContext, signal?: AbortSignal): Promise<void> {
  const key = cacheKey(ctx);
  const existing = warmsInFlight.get(key);
  if (existing) return existing;
  const warm = (async (): Promise<void> => {
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
      warnMcpWarmFailure(`catalog warm failed: ${(err as Error)?.message ?? String(err)}`);
    }
  })().finally(() => {
    if (warmsInFlight.get(key) === warm) warmsInFlight.delete(key);
  });
  warmsInFlight.set(key, warm);
  return warm;
}

/**
 * Bounded wait for the init-time MCP discovery so turn 1's system prompt
 * already carries <mcp_catalog> — a catalog that first appears on a later turn
 * changes the prompt prefix and busts the provider prompt cache for the whole
 * session. Only awaits an ALREADY-RUNNING warm (session_start starts one); it
 * never spawns servers itself, so a failed warm degrades to an empty block
 * instead of a per-turn reconnect storm. No-op once the catalog is cached.
 */
export async function mcpCatalogReady(ctx?: PiContext, timeoutMs = 10_000): Promise<boolean> {
  const key = cacheKey(ctx);
  if (cachedCatalogs.get(key)?.length) return true;
  const pending = warmsInFlight.get(key);
  if (!pending) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return Boolean(cachedCatalogs.get(key)?.length);
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
  return [
    '<mcp_catalog>',
    'Full MCP catalog discovered at session init: every configured server with its instructions, tools, and exact inputSchema JSON. Re-injected every turn so it survives compaction, and kept byte-stable for prompt caching — it changes only when the MCP config actually changes (mcp.json edit, add/remove/restart, tools/list_changed). Call tools directly with MCPTool({action:"call", server, tool, arguments}) using these schemas — no list/describe round-trip needed; use list/describe only when an entry below is marked truncated or a call fails schema validation. The `octocode` server is the built-in default: prefer its tools for ALL code/file/structure/history/package research.',
    ...cached.map((entry) => formatCachedCatalogEntry(entry)),
    '</mcp_catalog>',
  ].join('\n');
}

export interface McpDiscoveryServer {
  name: string;
  command: string;
  args: string[];
  description?: string;
  /** Present only for servers whose catalog was discovered (warmed/listed). */
  toolCount?: number;
  tools?: Array<{ name: string; description: string }>;
}

export interface McpDiscoverySnapshot {
  sources: McpConfigSource[];
  servers: McpDiscoveryServer[];
  warnings: string[];
}

/**
 * Machine-readable snapshot of the full MCP configuration + discovered catalogs,
 * for the .octocode/discovery.json inventory. Reads config fresh (cheap file
 * reads) but never spawns servers — tool lists come from the discovery cache.
 */
export async function getMcpDiscoverySnapshot(ctx?: PiContext): Promise<McpDiscoverySnapshot> {
  const loaded = await loadMcpConfig(ctx);
  const cached = new Map((cachedCatalogs.get(cacheKey(ctx)) ?? []).map((entry) => [entry.name, entry]));
  const servers: McpDiscoveryServer[] = [...loaded.servers.entries()].map(([name, config]) => {
    const entry = cached.get(name);
    const tools = entry?.tools
      ?.filter(isPlainRecord)
      .map((tool) => ({
        name: String(tool['name'] ?? ''),
        description: typeof tool['description'] === 'string' ? capCatalogText(tool['description'], 300) : '',
      }));
    return {
      name,
      command: config.command,
      args: config.args ?? [],
      ...(config.description ? { description: config.description } : {}),
      ...(tools ? { toolCount: tools.length, tools } : {}),
    };
  });
  return { sources: loaded.sources, servers, warnings: loaded.warnings };
}

export const __test__ = {
  setCachedMcpCatalog(ctx: PiContext | undefined, entries: ListedMcpServer[]): void {
    cachedCatalogs.set(cacheKey(ctx), entries);
  },
  clearCachedMcpCatalog(): void {
    cachedCatalogs.clear();
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
  /** When this catalog entry was fetched. Diagnostic only — it must never leak into the rendered <mcp_catalog> bytes. */
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
  if (instructions) lines.push(`instructions: ${capCatalogText(instructions, 300)}`);
  for (const rawTool of payload.tools) {
    const tool = rawTool as Record<string, unknown>;
    const description = typeof tool['description'] === 'string' ? tool['description'] : '';
    lines.push(`- ${String(tool['name'])}: ${capCatalogText(description, 180)}${summarizeSchema(tool)}`);
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
      const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : false;
      if (!trusted) return result('Refusing to write project mcp.json: project trust could not be verified. Use scope:"global" or trust the project.', undefined, true);
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
      const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : false;
      if (!trusted) return result('Refusing to write project mcp.json: project trust could not be verified.', undefined, true);
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
  // Cell-width aware: a code-unit slice miscounts CJK/emoji and can hand pi a
  // line wider than the terminal.
  return truncateToWidth(clean, width);
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
    return buildOctocodeRenderResult(args['tool'], resultValue, opts, theme, context);
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
  // Pi ignores the returned isError; context.isError is the reliable flag.
  const isError = Boolean(resultValue.isError) || Boolean(context?.isError);
  const prefix = isError ? 'mcp error' : `mcp ${action}`;
  return makeRenderer((width) => {
    const color = isError ? 'error' : 'dim';
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
    promptSnippet: 'MCPTool is the dedicated MCP gateway. Main agent has built-in octocode MCP plus configured MCPs; spawned agents may use the Octocode CLI instead. All servers are discovered at init and their instructions, tools, and exact input schemas are injected in <mcp_catalog> — call directly from it; use action:list/describe only when the catalog marks an entry truncated or a call fails schema validation. Never guess server/tool/arguments.',
    promptGuidelines: [
      'MCPTool default server: octocode = pinned local octocode-mcp binary (npx -y octocode-mcp@latest fallback) — the default research surface for code/file/structure/history/package lookups.',
      'MCPTool config is JSON at <workspace>/.pi/agent/mcp.json or ~/.pi/agent/mcp.json. Project config loads only in trusted projects.',
      'The full catalog (server instructions + tools + exact inputSchema JSON) lives in <mcp_catalog>, discovered at init and refreshed on config change; action:list re-fetches live when needed.',
      'Use MCPTool action:describe for one tool only when its <mcp_catalog> entry is truncated or a call failed schema validation.',
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
