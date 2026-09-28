import { StreamableHTTPClientTransport, type Client, type Tool } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expandEnv, loadMcpServers, mcpToolName, type McpServerConfig } from './mcp-config.js';
import { annotationPrefix, createMcpClient } from './mcp-host.js';
import { capOutput, errorMessage, isRecord, textResult, withTimeout } from './util.js';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIVATED_PER_SEARCH = 8;

export interface McpToolEntry {
  server: string;
  remoteName: string;
  name: string;
  description: string;
}

export interface McpServerState {
  name: string;
  status: 'connecting' | 'ready' | 'failed';
  error?: string;
  instructions?: string;
  tools: McpToolEntry[];
  client?: Client;
}

type ContentItem = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Connects configured MCP servers and exposes each remote tool as a Pi tool.
 * Tools start inactive (deferred) unless their server is `eager`; the `mcp`
 * loader tool activates matches on demand so the prompt stays small.
 */
export class McpHub {
  readonly servers = new Map<string, McpServerState>();
  readonly #pi: ExtensionAPI;
  #ready: Promise<void> = Promise.resolve();
  #ctx: ExtensionContext | undefined;
  /** Eager tools waiting to be activated; Pi only activates tools already in its registry. */
  readonly #pendingActivation = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  /**
   * Connect every configured server for this session; `ctx` answers server requests (roots, elicitation, sampling).
   * `onStatusChange` runs whenever a server settles (ready or failed) or later disconnects.
   */
  start(ctx: ExtensionContext, handlers: { onConfigError: (file: string, error: unknown) => void; onStatusChange: () => void }): void {
    this.#ctx = ctx;
    const configs = loadMcpServers(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), onError: handlers.onConfigError });
    this.#ready = Promise.all(
      Object.entries(configs).map(([name, config]) => this.#connect(name, config, ctx.cwd, handlers.onStatusChange).finally(handlers.onStatusChange)),
    ).then(() => undefined);
  }

  /** Resolves once every server connected or failed (bounded by `timeoutMs`). */
  async ready(timeoutMs: number): Promise<void> {
    await withTimeout(this.#ready, timeoutMs, 'MCP startup').catch(() => undefined);
  }

  /** Eager tools registered since the last call, for the caller to activate in one active-set update. */
  takePendingActivation(): string[] {
    const names = [...this.#pendingActivation];
    this.#pendingActivation.clear();
    return names;
  }

  tools(): McpToolEntry[] {
    return [...this.servers.values()].flatMap((server) => server.tools);
  }

  /** Activate tools of one server, or the best keyword matches; returns what was activated. */
  activate(query: { server?: string; query?: string }): McpToolEntry[] {
    let matches: McpToolEntry[] = [];
    if (query.server) matches = this.servers.get(query.server)?.tools ?? [];
    else if (query.query) matches = rank(this.tools(), query.query).slice(0, MAX_ACTIVATED_PER_SEARCH);
    if (matches.length === 0) return [];
    const active = this.#pi.getActiveTools();
    const added = matches.map((tool) => tool.name).filter((name) => !active.includes(name));
    if (added.length > 0) this.#pi.setActiveTools([...active, ...added]);
    return matches;
  }

  async close(): Promise<void> {
    const clients = [...this.servers.values()].flatMap((server) => (server.client ? [server.client] : []));
    this.servers.clear();
    this.#pendingActivation.clear();
    this.#ctx = undefined;
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  async #connect(name: string, config: McpServerConfig, cwd: string, onStatusChange: () => void): Promise<void> {
    const state: McpServerState = { name, status: 'connecting', tools: [] };
    this.servers.set(name, state);
    const eager = config.eager === true;
    try {
      const client = createMcpClient(name, () => this.#ctx, (tools) => {
        if (this.servers.get(name) === state) state.tools = this.#register(name, client, tools, eager, state.tools);
      });
      await withTimeout(client.connect(createTransport(config, cwd)), CONNECT_TIMEOUT_MS, `MCP ${name} connect`);
      state.client = client;
      const instructions = client.getInstructions();
      if (instructions) state.instructions = instructions;
      state.tools = this.#register(name, client, (await client.listTools()).tools, eager, []);
      state.status = 'ready';
      // A server that exits later (crash, killed process) must stop advertising tools that can no longer run.
      client.onclose = () => {
        if (this.servers.get(name) !== state || state.status !== 'ready') return;
        state.status = 'failed';
        state.error = 'disconnected';
        const gone = new Set(state.tools.map((tool) => tool.name));
        for (const tool of gone) this.#pendingActivation.delete(tool);
        const active = this.#pi.getActiveTools();
        if (active.some((tool) => gone.has(tool))) this.#pi.setActiveTools(active.filter((tool) => !gone.has(tool)));
        onStatusChange();
      };
    } catch (error) {
      state.status = 'failed';
      state.error = errorMessage(error);
    }
  }

  /** Register (or refresh) a server's tools. New tools start deferred; tools the server dropped are deactivated. */
  #register(server: string, client: Client, tools: Tool[], eager: boolean, previous: McpToolEntry[]): McpToolEntry[] {
    const entries = tools.map((tool) => {
      const entry: McpToolEntry = { server, remoteName: tool.name, name: mcpToolName(server, tool.name), description: (tool.description ?? '').trim() };
      this.#pi.registerTool({
        name: entry.name,
        label: `${server} · ${tool.title ?? tool.name}`,
        description: clip(`[${server} MCP] ${annotationPrefix(tool)}${entry.description}`, 1024),
        parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: {}, ...(tool.inputSchema as object) }),
        execute: async (_id, params, signal, onUpdate) => textOrMedia(await callRemote(client, tool, params, signal, onUpdate)),
      });
      return entry;
    });
    // Tools registered after startup are inactive: eager servers queue new tools for activation at the
    // next turn, deferred servers leave them for the `mcp` loader; tools the server dropped are deactivated.
    const known = new Set(previous.map((entry) => entry.name));
    const current = new Set(entries.map((entry) => entry.name));
    const added = entries.filter((entry) => !known.has(entry.name)).map((entry) => entry.name);
    const dropped = new Set(previous.filter((entry) => !current.has(entry.name)).map((entry) => entry.name));
    if (eager) for (const name of added) this.#pendingActivation.add(name);
    const active = this.#pi.getActiveTools();
    const next = active.filter((name) => !dropped.has(name) && (eager || !added.includes(name)));
    if (next.length !== active.length) this.#pi.setActiveTools(next);
    return entries;
  }
}

function createTransport(config: McpServerConfig, cwd: string) {
  if (config.url) {
    const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, expandEnv(value)]));
    return new StreamableHTTPClientTransport(new URL(expandEnv(config.url)), { requestInit: { headers } });
  }
  const env = { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandEnv(value)])) };
  return new StdioClientTransport({
    command: config.command!,
    args: (config.args ?? []).map((arg) => expandEnv(arg)),
    env,
    cwd: config.cwd ? expandEnv(config.cwd) : cwd,
    stderr: 'ignore',
  });
}

async function callRemote(
  client: Client,
  tool: Tool,
  args: unknown,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<undefined> | undefined,
): Promise<ContentItem[]> {
  const result = await client.callTool(
    { name: tool.name, arguments: isRecord(args) ? args : {} },
    {
      ...(signal ? { signal } : {}),
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      toolDefinition: tool,
      onprogress: (progress) => {
        const amount = progress.total ? `${progress.progress}/${progress.total}` : String(progress.progress);
        onUpdate?.({ content: [{ type: 'text', text: `${progress.message ?? 'working'} (${amount})` }], details: undefined });
      },
    },
  );
  const items = toContent(result);
  if (result.isError === true) throw new Error(items.map((item) => (item.type === 'text' ? item.text : '[image]')).join('\n') || 'MCP tool failed');
  return items;
}

export function toContent(result: { content?: unknown; structuredContent?: unknown }): ContentItem[] {
  const items: ContentItem[] = [];
  for (const part of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(part)) continue;
    if (part['type'] === 'text' && typeof part['text'] === 'string') items.push({ type: 'text', text: part['text'] });
    else if (part['type'] === 'image' && typeof part['data'] === 'string')
      items.push({ type: 'image', data: part['data'], mimeType: String(part['mimeType'] ?? 'image/png') });
    else if (part['type'] === 'resource' && isRecord(part['resource']))
      items.push({ type: 'text', text: String(part['resource']['text'] ?? `[resource ${String(part['resource']['uri'] ?? '')}]`) });
    else if (part['type'] === 'resource_link') items.push({ type: 'text', text: `[resource ${String(part['uri'] ?? '')}]` });
  }
  if (items.length === 0 && result.structuredContent !== undefined) items.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
  return items;
}

function textOrMedia(items: ContentItem[]) {
  const content = items.map((item) => (item.type === 'text' ? { type: 'text' as const, text: capOutput(item.text) } : item));
  return { content: content.length > 0 ? content : [{ type: 'text' as const, text: '(no output)' }], details: undefined };
}

export function rank(tools: McpToolEntry[], query: string): McpToolEntry[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
  const scored = tools.map((tool) => {
    const name = tool.remoteName.toLowerCase();
    const text = `${name} ${tool.description.toLowerCase()} ${tool.server.toLowerCase()}`;
    const covered = terms.filter((term) => text.includes(term)).length;
    const nameHits = terms.filter((term) => name.includes(term)).length;
    return { tool, covered, score: covered * 10 + nameHits };
  });
  // Only tools that match as many query terms as the best match: a broad query must not load the whole catalog.
  const best = Math.max(0, ...scored.map((entry) => entry.covered));
  return scored.filter((entry) => best > 0 && entry.covered === best).sort((a, b) => b.score - a.score).map((entry) => entry.tool);
}

export function registerMcpLoader(pi: ExtensionAPI, hub: McpHub): void {
  pi.registerTool({
    name: 'mcp',
    label: 'MCP',
    description:
      'Load tools from connected MCP servers. Call with no arguments to list servers and their tools; with `server` to load all tools of one server; with `query` to load the best-matching tools. Loaded tools become directly callable.',
    promptSnippet: 'List MCP servers and load tools of on-demand servers',
    promptGuidelines: [
      'Tools already in your tool list are callable directly; load other MCP tools with mcp first (they then stay available for the session).',
    ],
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: 'Load every tool of this server' })),
      query: Type.Optional(Type.String({ description: 'Keywords describing the capability you need' })),
    }),
    async execute(_id, params) {
      await hub.ready(15_000);
      if (!params.server && !params.query) return textResult(describeServers(hub));
      const loaded = hub.activate(params);
      if (loaded.length === 0) return textResult(`No MCP tools matched.\n\n${describeServers(hub)}`);
      return textResult(`Loaded ${loaded.length} tool(s):\n${loaded.map((tool) => `- ${tool.name}: ${firstLine(tool.description)}`).join('\n')}`);
    },
  });
}

export function describeServers(hub: McpHub): string {
  if (hub.servers.size === 0) return 'No MCP servers configured.';
  return [...hub.servers.values()]
    .map((server) => {
      const head = `## ${server.name} (${server.status}${server.error ? `: ${server.error}` : ''})`;
      const tools = server.tools.map((tool) => `- ${tool.name}: ${firstLine(tool.description)}`).join('\n');
      return [head, server.instructions ? firstLine(server.instructions, 300) : '', tools].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** Cut at the last sentence or line break before `max`, so a long description never ends mid-sentence. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  return `${cut > max / 2 ? head.slice(0, cut + 1).trimEnd() : head.trimEnd()}…`;
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((part) => part.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
