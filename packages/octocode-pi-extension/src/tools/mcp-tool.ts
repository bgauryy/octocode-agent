import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { PiCommandContext, PiContext, PiInstance, PiTheme, RenderCallReturn, RenderContext, ToolCallResult, ToolDefinition, TSchema } from '../types.js';
import { assertPathAllowed } from './path-guard.js';
import { recordFileReadState } from './file-state.js';
import { makeRenderer } from './render-helpers.js';

interface TypeBoxBuilder {
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): TSchema;
  String(options?: Record<string, unknown>): TSchema;
  Optional(schema: TSchema): TSchema;
  Literal(value: string): TSchema;
  Union(items: TSchema[], options?: Record<string, unknown>): TSchema;
}

type NotifyFn = (ctx: PiContext | undefined, message: string, level?: string) => void;
type McpAction = 'list' | 'describe' | 'call' | 'status' | 'restart' | 'stop' | 'config';

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
 * - npm_config_*: ensure npx resolves the local cache with the native addon.
 * User-supplied env values always take precedence over these defaults.
 */
export const OCTOCODE_MCP_ENV_DEFAULTS: Record<string, string> = {
  OCTOCODE_MCP_FULL_TEXT: 'true',
  npm_config_include: 'optional',
  npm_config_cache: DEFAULT_OCTOCODE_MCP_NPX_CACHE,
};
const DEFAULT_OCTOCODE_MCP_SERVER: McpServerConfig = {
  command: 'npx',
  // No --prefer-online: use the local npm cache (~/.cache/octocode/mcp-npx) for
  // sub-100ms cold start. Users can add --prefer-online to their mcp.json overrides
  // when they need the latest registry version.
  args: ['-y', 'octocode-mcp@latest'],
  env: { ...OCTOCODE_MCP_ENV_DEFAULTS },
  description: 'Built-in Octocode MCP server (lazy stdio bridge, cache-first).',
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
const connections = new Map<string, McpConnection>();
const cachedCatalogs = new Map<string, ListedMcpServer[]>();

function cacheKey(ctx?: PiContext): string {
  return path.resolve(ctx?.cwd ?? process.cwd());
}

function projectMcpPath(cwd: string): string {
  return path.join(cwd, '.pi', 'agent', 'mcp.json');
}

function legacyTypoProjectMcpPath(cwd: string): string {
  // Compatibility for the common "agnet" typo; canonical docs/writes stay .pi/agent/mcp.json.
  return path.join(cwd, '.pi', 'agnet', 'mcp.json');
}

function globalMcpPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
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

async function loadMcpConfig(ctx?: PiContext): Promise<McpLoadedConfig> {
  const cwd = ctx?.cwd ?? process.cwd();
  const trusted = ctx?.isProjectTrusted ? Boolean(await ctx.isProjectTrusted()) : true;
  const servers = new Map<string, McpServerConfig>([[DEFAULT_OCTOCODE_MCP_SERVER_NAME, DEFAULT_OCTOCODE_MCP_SERVER]]);
  const sources: McpConfigSource[] = [{ scope: 'built-in', path: 'npx -y octocode-mcp@latest', trusted: true }];
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

  for (const candidate of [projectMcpPath(cwd), legacyTypoProjectMcpPath(cwd)]) {
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

async function ensureConnection(name: string, config: McpServerConfig, ctx?: PiContext, signal?: AbortSignal): Promise<McpConnection> {
  const existing = connections.get(name);
  if (existing) return existing;

  config = normalizeServerConfig(name, config);
  const cwd = resolveServerCwd(config, ctx);
  assertPathAllowed(cwd, ctx?.cwd ?? process.cwd(), `mcp:${name}`);

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd,
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'octocode-pi-extension', version: '1.0.0' }, { capabilities: {} });
  const connection: McpConnection = { name, config, client, transport, stderr: [], startedAt: Date.now() };
  const stderr = transport.stderr;
  stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    connection.stderr.push(text);
    while (connection.stderr.length > 20) connection.stderr.shift();
  });
  transport.onclose = () => {
    connections.delete(name);
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
  return names.length;
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
  const existing = new Map((cachedCatalogs.get(key) ?? []).map((entry) => [entry.name, entry]));
  for (const entry of listed) existing.set(entry.name, entry);
  cachedCatalogs.set(key, [...existing.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

function formatCachedCatalogEntry(entry: ListedMcpServer): string {
  const lines = [`server: ${entry.name}`];
  if (entry.instructions) lines.push(`instructions: ${entry.instructions}`);
  for (const rawTool of entry.tools) {
    if (!isPlainRecord(rawTool)) continue;
    lines.push(`tool: ${String(rawTool['name'] ?? '')}`);
    if (typeof rawTool['description'] === 'string') lines.push(`description: ${rawTool['description']}`);
    if (rawTool['inputSchema'] !== undefined) lines.push(stringify({ inputSchema: rawTool['inputSchema'] }));
  }
  return lines.join('\n');
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
export function patchGlobalMcpOctocodeEnv(configPath = globalMcpPath()): void {
  try {
    if (!fs.existsSync(configPath)) return; // No global mcp.json — nothing to patch.

    // Re-parse as raw JSON so we can write it back with minimal diff.
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { return; }

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
  } catch {
    // Silently swallow — a missing or unwritable config must not block session start.
  }
}

/**
 * Pre-warm the octocode MCP server catalog at session start so that the
 * <mcp_cached_catalog> block is already populated when before_agent_start fires
 * for turn 1. Non-blocking — errors are swallowed so a slow/missing MCP server
 * never prevents the session from starting.
 */
export async function warmMcpCatalog(ctx?: PiContext, signal?: AbortSignal): Promise<void> {
  try {
    const loaded = await loadMcpConfig(ctx);
    const config = loaded.servers.get(DEFAULT_OCTOCODE_MCP_SERVER_NAME);
    if (!config) return;
    const listed = await listServerTools(DEFAULT_OCTOCODE_MCP_SERVER_NAME, config, ctx, signal);
    cacheListedCatalog(ctx, [listed]);
  } catch {
    // Best-effort: a slow or missing MCP server must not block session start.
  }
}

export function getCachedMcpCatalogAddendum(ctx?: PiContext): string {
  const cached = cachedCatalogs.get(cacheKey(ctx));
  if (!cached?.length) return '';
  return [
    '<mcp_cached_catalog>',
    'Cached MCP catalog from prior MCPTool list/describe calls in this Pi process. Treat as a hint; re-run MCPTool list/describe when exact current schema matters.',
    ...cached.map(formatCachedCatalogEntry),
    '</mcp_cached_catalog>',
  ].join('\n');
}

function formatConfig(config: McpLoadedConfig, cwd = process.cwd()): string {
  const lines = ['Octocode MCP config'];
  lines.push(`servers: ${config.servers.size === 0 ? 'none' : [...config.servers.keys()].join(', ')}`);
  lines.push(`sources: ${config.sources.length === 0 ? 'none' : config.sources.map((s) => `${s.scope}:${s.path}${s.trusted ? '' : ' (untrusted)'}`).join('; ')}`);
  if (config.warnings.length > 0) lines.push(`warnings:\n- ${config.warnings.join('\n- ')}`);
  lines.push(`canonical project path: ${projectMcpPath(cwd)}`);
  return lines.join('\n');
}

function formatStatus(config: McpLoadedConfig): string {
  const running = [...connections.keys()];
  return [
    'Octocode MCP status',
    `configured: ${config.servers.size === 0 ? 'none' : [...config.servers.keys()].join(', ')}`,
    `running: ${running.length === 0 ? 'none' : running.join(', ')}`,
    config.warnings.length ? `warnings:\n- ${config.warnings.join('\n- ')}` : undefined,
  ].filter(Boolean).join('\n');
}

interface ListedMcpServer {
  name: string;
  instructions?: string;
  tools: unknown[];
  text: string;
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

async function handleMcpAction(params: Record<string, unknown>, signal?: AbortSignal, ctx?: PiContext): Promise<ToolCallResult> {
  const action = (params['action'] ?? 'list') as McpAction;
  const loaded = await loadMcpConfig(ctx);
  const serverName = typeof params['server'] === 'string' ? params['server'] : undefined;

  if (action === 'config') return result(formatConfig(loaded, ctx?.cwd ?? process.cwd()), { sources: loaded.sources, warnings: loaded.warnings });
  if (action === 'status') return result(formatStatus(loaded), { running: [...connections.keys()], warnings: loaded.warnings });
  if (action === 'stop') {
    const stopped = serverName ? await stopConnection(serverName) : stopAllMcpServers() > 0;
    return result(serverName ? `${serverName}: ${stopped ? 'stopped' : 'not running'}` : `stopped ${stopped ? 'MCP servers' : 'no MCP servers'}`);
  }

  if (serverName && !loaded.servers.has(serverName)) {
    return result(`Unknown MCP server: ${serverName}\nConfigured: ${[...loaded.servers.keys()].join(', ') || 'none'}`, loaded, true);
  }

  if (action === 'restart') {
    if (!serverName) return result('mcp restart requires server', undefined, true);
    await stopConnection(serverName);
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
  if (clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(1, width - 1))}…`;
}

function renderCall(args: unknown, theme?: PiTheme): RenderCallReturn {
  const { action, target } = formatMcpTarget(args);
  return makeRenderer((width) => {
    const line = `mcp ${action} · ${target}`;
    return [theme?.fg ? theme.fg('dim', clip(line, width)) : clip(line, width)];
  });
}

function renderResult(resultValue: ToolCallResult, _opts: unknown, theme?: PiTheme, context?: RenderContext): RenderCallReturn {
  const { action, target } = formatMcpTarget(context?.args);
  const lines = resultValue.content[0]?.text?.split('\n').filter(Boolean) ?? ['MCP result'];
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
    action: Type.Optional(Type.Union([
      Type.Literal('list'),
      Type.Literal('describe'),
      Type.Literal('call'),
      Type.Literal('status'),
      Type.Literal('restart'),
      Type.Literal('stop'),
      Type.Literal('config'),
    ], { description: 'MCP action. Use list or describe before call.' })),
    server: Type.Optional(Type.String({ description: 'Configured MCP server name from .pi/agent/mcp.json or ~/.pi/agent/mcp.json.' })),
    tool: Type.Optional(Type.String({ description: 'MCP tool name for action:call.' })),
    arguments: Type.Optional(Type.Object({}, { description: 'Arguments object passed to the MCP tool.', additionalProperties: true })),
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
    description: 'Dedicated MCP client: list, describe, call, restart, stop, and inspect stdio MCP servers configured in .pi/agent/mcp.json or ~/.pi/agent/mcp.json.',
    promptSnippet: 'MCPTool is the dedicated MCP gateway. Main agent has built-in octocode MCP plus configured MCPs; spawned agents may use the Octocode CLI instead. Use MCPTool action:list/describe to read server instructions, tool descriptions, and input schemas before action:call. Never guess server/tool/arguments.',
    promptGuidelines: [
      'MCPTool default server: octocode = npx -y octocode-mcp@latest, lazy-started only when listed/called.',
      'MCPTool config is JSON at <workspace>/.pi/agent/mcp.json or ~/.pi/agent/mcp.json. Project config loads only in trusted projects.',
      'MCPTool action:list returns server instructions plus every tool name, description, and schema summary; details.servers[].tools contains full MCP inputSchema objects.',
      'Use MCPTool action:describe for one tool when exact schema matters before action:call.',
      'Treat MCP servers as arbitrary code. Do not add or run untrusted MCP config without user approval.',
    ],
    parameters,
    execute,
    renderCall,
    renderResult,
  } satisfies Omit<ToolDefinition, 'name'>;

  registerFn(pi, registeredToolNames, { name: 'MCPTool', ...common });
  registerFn(pi, registeredToolNames, {
    name: 'mcp',
    ...common,
    label: 'mcp (alias for MCPTool)',
    description: 'Compatibility alias for MCPTool. Prefer MCPTool in new prompts and tool calls.',
    promptSnippet: 'Compatibility alias for MCPTool; prefer MCPTool. Same schema and behavior.',
  });
}

export async function handleOctocodeMcpCommand(args: string, ctx: PiCommandContext | undefined, notify: NotifyFn): Promise<void> {
  const [actionRaw, server] = args.trim().split(/\s+/).filter(Boolean);
  const action = (actionRaw || 'status') as McpAction;
  const res = await handleMcpAction({ action, server }, undefined, ctx);
  notify(ctx, res.content[0]?.text ?? 'MCP command completed', res.isError ? 'error' : 'info');
}
