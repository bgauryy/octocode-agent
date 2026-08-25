import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getMcpEnablement, listMcpOverrides, openOctocodeDb } from '@octocodeai/octocode-awareness/mcp-state';
import type { PiContext } from '../types.js';
import { getOctocodeHome } from '../env.js';
import { escapeHtml, renderOctocodePage } from '../tui/html-page.js';
import { loadMcpConfig, type McpServerConfig } from './mcp-config.js';
import { getMcpDiscoverySnapshot, handleMcpAction, isMcpServerConnected } from './mcp-tool.js';
import { hasStoredMcpOAuthTokens } from './mcp-oauth.js';
import { serveDirectory } from './local-server.js';
import { openLocalUrl } from './local-url-opener.js';

function managerDir(cwd: string): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 32);
  return path.join(getOctocodeHome(), 'tmp', 'mcp', key);
}

export type McpManagerAction =
  | { action: 'enable' | 'disable'; server: string; tool?: string; scope: 'project' | 'global' }
  | { action: 'add'; server: string; scope: 'project' | 'global'; config: Record<string, unknown> }
  | { action: 'remove' | 'restart' | 'connect' | 'retry'; server: string; scope: 'project' | 'global' };

const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function parseMcpManagerAction(raw: unknown): McpManagerAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid MCP action');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!['action', 'server', 'scope', 'tool', 'config'].includes(key)) throw new Error(`Unsupported MCP action field: ${key}`);
  }
  const action = value['action'];
  const server = value['server'];
  if (value['scope'] !== undefined && value['scope'] !== 'project' && value['scope'] !== 'global') throw new Error('Invalid MCP scope');
  const scope = value['scope'] === 'global' ? 'global' : 'project';
  if (!['enable', 'disable', 'add', 'remove', 'restart', 'connect', 'retry'].includes(String(action))) throw new Error('Unsupported MCP action');
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) throw new Error('Invalid MCP server');
  if (action === 'enable' || action === 'disable') {
    const tool = value['tool'];
    if (tool !== undefined && (typeof tool !== 'string' || !SERVER_NAME.test(tool))) throw new Error('Invalid MCP tool');
    return { action, server, scope, ...(typeof tool === 'string' ? { tool } : {}) };
  }
  if (action === 'add') {
    if (!value['config'] || typeof value['config'] !== 'object' || Array.isArray(value['config'])) throw new Error('MCP add requires config');
    const config = value['config'] as Record<string, unknown>;
    const allowed = new Set(['command', 'args', 'cwd', 'url', 'timeoutMs', 'description', 'envRefs', 'headerRefs', 'auth']);
    for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unsupported MCP config field: ${key}`);
    for (const field of ['envRefs', 'headerRefs'] as const) {
      const refs = config[field];
      if (refs === undefined) continue;
      if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error(`${field} must be an object`);
      for (const [destination, source] of Object.entries(refs as Record<string, unknown>)) {
        const validDestination = field === 'envRefs' ? ENV_NAME.test(destination) : HTTP_HEADER_NAME.test(destination);
        if (!validDestination) throw new Error(`Invalid ${field} destination: ${destination}`);
        if (typeof source !== 'string' || !ENV_NAME.test(source)) throw new Error(`${field} values must be environment variable names`);
      }
    }
    return { action, server, scope, config };
  }
  return { action, server, scope } as McpManagerAction;
}

function safeConfig(config: McpServerConfig): Record<string, unknown> {
  return config.transport === 'http' || config.url
    ? {
        transport: 'streamable-http',
        url: config.url,
        headerKeys: [...Object.keys(config.headers ?? {}), ...Object.keys(config.headerRefs ?? {})].sort(),
        headerRefs: config.headerRefs ?? {},
        auth: config.auth ?? 'none',
        timeoutMs: config.timeoutMs,
        description: config.description,
      }
    : {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        envKeys: [...Object.keys(config.env ?? {}), ...Object.keys(config.envRefs ?? {})].sort(),
        envRefs: config.envRefs ?? {},
        timeoutMs: config.timeoutMs,
        description: config.description,
      };
}

export async function renderMcpManagerPage(ctx?: PiContext, actionToken = ''): Promise<string> {
  const cwd = path.resolve(ctx?.cwd ?? process.cwd());
  const loaded = await loadMcpConfig(ctx);
  const discovery = await getMcpDiscoverySnapshot(ctx);
  const catalog = new Map(discovery.servers.map((server) => [server.name, server]));
  let overrides = { servers: [] as unknown[], tools: [] as unknown[] };
  let db: ReturnType<typeof openOctocodeDb> | undefined;
  try {
    db = openOctocodeDb();
    overrides = listMcpOverrides(db, cwd);
  } catch { /* page stays usable without DB diagnostics */ }
  const oauthHealth = new Map<string, boolean>();
  await Promise.all([...loaded.configuredServers.entries()].map(async ([name, config]) => {
    if (config.auth === 'oauth' && config.url) {
      oauthHealth.set(name, await hasStoredMcpOAuthTokens(name, config.url).catch(() => false));
    }
  }));
  const rows = [...loaded.configuredServers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => {
    const enabled = loaded.servers.has(name);
    const source = loaded.serverSources.get(name);
    const editScope = source?.scope === 'global' ? 'global' : 'project';
    const connected = isMcpServerConnected(name);
    const authHealth = config.auth === 'oauth' ? (oauthHealth.get(name) ? 'authorized' : 'authorization required') : 'not required';
    const tools = catalog.get(name)?.tools ?? [];
    const toolRows = tools.map((tool) => {
      const toolEnabled = !db || getMcpEnablement(db, cwd, name, tool.name, true);
      const action = toolEnabled ? 'disable' : 'enable';
      return `<div class="row"><span><code>${escapeHtml(tool.name)}</code> <span class="badge ${toolEnabled ? 'on' : ''}">${toolEnabled ? 'enabled' : 'disabled'}</span> <span class="muted">${escapeHtml(tool.description)}</span></span><button class="${toolEnabled ? '' : 'primary'}" data-action="${action}" data-server="${escapeHtml(name)}" data-tool="${escapeHtml(tool.name)}">${toolEnabled ? 'Disable' : 'Enable'}</button></div>`;
    }).join('');
    const encodedConfig = Buffer.from(JSON.stringify({ name, scope: editScope, ...safeConfig(config) }), 'utf8').toString('base64');
    return `<section>
      <div class="row"><h2>${escapeHtml(name)}</h2><span><span class="badge ${connected ? 'on' : ''}">${connected ? 'connected' : 'disconnected'}</span> <span class="badge ${enabled ? 'on' : ''}">${enabled ? 'enabled' : 'disabled'}</span> <button class="${enabled ? '' : 'primary'}" data-action="${enabled ? 'disable' : 'enable'}" data-server="${escapeHtml(name)}" data-scope="${editScope}">${enabled ? 'Disable' : 'Enable'}</button></span></div>
      <p class="muted">Effective scope: ${escapeHtml(source?.scope ?? 'unknown')} · Source: <code>${escapeHtml(source?.path ?? 'unknown')}</code> · OAuth: ${escapeHtml(authHealth)} · ${tools.length} cached tool${tools.length === 1 ? '' : 's'}</p>
      <details><summary>Configuration (secret values redacted)</summary><pre>${escapeHtml(JSON.stringify(safeConfig(config), null, 2))}</pre></details>
      ${tools.length ? `<div class="stack">${toolRows}</div>` : '<p class="muted">No cached tools. Enable/connect the server to discover its catalog.</p>'}
      <div class="reply-actions"><button data-action="edit" data-config="${encodedConfig}">Edit</button><button data-action="restart" data-server="${escapeHtml(name)}" data-scope="${editScope}">${config.auth === 'oauth' && !oauthHealth.get(name) ? 'Authorize / connect' : 'Connect / retry'}</button>${name === 'octocode' ? '' : `<button data-action="remove" data-server="${escapeHtml(name)}" data-scope="${editScope}">Remove</button>`}</div>
    </section>`;
  }).join('');
  const sources = loaded.sources.map((source) => `<li><span class="badge">${escapeHtml(source.scope)}</span> <code>${escapeHtml(source.path)}</code>${source.trusted ? '' : ' (untrusted)'}</li>`).join('');
  const bodyHtml = `<section><h2>Configuration files</h2><ul>${sources}</ul><p class="muted">Enablement is stored in the shared Octocode SQLite database. Server definitions stay in canonical JSON; secrets are never copied into this page or mcp.md.</p></section>
    <section><h2>Add or edit server</h2><form id="mcp-editor" class="stack">
      <label>Name <input name="server" required pattern="[A-Za-z0-9_.-]{1,64}"></label>
      <label>Scope <select name="scope"><option value="project">Project</option><option value="global">Global</option></select></label>
      <label>Transport <select name="transport"><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></select></label>
      <label>Command <input name="command" placeholder="node"></label><label>URL <input name="url" type="url" placeholder="https://example.test/mcp"></label>
      <label>Arguments, one per line <textarea name="args"></textarea></label><label>Working directory <input name="cwd"></label>
      <label>Timeout ms <input name="timeoutMs" type="number" min="1000" max="120000" value="30000"></label><label>Description <input name="description"></label>
      <label>Environment references (JSON: destination key → environment variable) <textarea name="envRefs" placeholder='{"API_KEY":"MY_MCP_API_KEY"}'></textarea></label>
      <label>Header references (JSON: header → environment variable) <textarea name="headerRefs" placeholder='{"Authorization":"MY_MCP_AUTH_HEADER"}'></textarea></label>
      <label>Authentication <select name="auth"><option value="none">None / references</option><option value="oauth">OAuth (authorize after saving)</option></select></label>
      <div class="reply-actions"><button class="primary" type="submit">Save server</button><button type="reset">Clear</button></div><p id="mcp-status" class="reply-status"></p>
    </form></section>
    ${rows || '<section><p>No MCP servers configured.</p></section>'}
    <section><h2>Workspace overrides</h2><pre>${escapeHtml(JSON.stringify(overrides, null, 2))}</pre></section>
    <script type="module">
      const token = ${JSON.stringify(actionToken)};
      const post = async (action) => {
        const response = await fetch('./__octocode/action', { method:'POST', headers:{'content-type':'application/json','x-octocode-action-token':token}, body:JSON.stringify(action) });
        const value = await response.json().catch(() => ({}));
        if (!response.ok || !value.ok) throw new Error(value.error || 'MCP update failed');
        return value.value;
      };
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        if (button.dataset.action === 'edit') {
          const value = JSON.parse(atob(button.dataset.config));
          const form = document.querySelector('#mcp-editor');
          for (const [key, raw] of Object.entries(value)) {
            const field = form.elements.namedItem(key === 'name' ? 'server' : key);
            if (!field) continue;
            field.value = typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw ?? '');
          }
          form.scrollIntoView({ behavior:'smooth' });
          return;
        }
        button.disabled = true;
        try {
          if (button.dataset.action === 'remove' && !confirm('Remove this MCP server from project configuration?')) return;
          await post({ action:button.dataset.action, server:button.dataset.server, tool:button.dataset.tool || undefined, scope:button.dataset.scope || 'project' });
          location.reload();
        } catch (error) { alert(error.message); button.disabled = false; }
      });
      document.querySelector('#mcp-editor').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const transport = String(data.get('transport'));
        const parseRefs = (name) => { const text = String(data.get(name) || '').trim(); return text ? JSON.parse(text) : undefined; };
        const config = {
          ...(transport === 'http' ? { url:String(data.get('url') || '').trim() } : { command:String(data.get('command') || '').trim(), args:String(data.get('args') || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean) }),
          ...(String(data.get('cwd') || '').trim() ? { cwd:String(data.get('cwd')).trim() } : {}),
          timeoutMs:Number(data.get('timeoutMs') || 30000),
          ...(String(data.get('description') || '').trim() ? { description:String(data.get('description')).trim() } : {}),
          ...(parseRefs('envRefs') ? { envRefs:parseRefs('envRefs') } : {}),
          ...(parseRefs('headerRefs') ? { headerRefs:parseRefs('headerRefs') } : {}),
          auth:String(data.get('auth') || 'none'),
        };
        const status = document.querySelector('#mcp-status');
        try { status.textContent = 'Saving and refreshing catalog…'; await post({ action:'add', server:String(data.get('server')), scope:String(data.get('scope')), config }); location.reload(); }
        catch (error) { status.textContent = error.message; }
      });
    </script>`;
  return renderOctocodePage({ title: 'MCP connections', bodyHtml });
}

export async function openMcpManager(ctx?: PiContext): Promise<{ ok: boolean; url?: string; message?: string }> {
  const cwd = ctx?.cwd ?? process.cwd();
  const dir = managerDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const actionToken = randomBytes(32).toString('hex');
  const write = async (): Promise<void> => fs.writeFileSync(path.join(dir, 'index.html'), await renderMcpManagerPage(ctx, actionToken), 'utf8');
  await write();
  const served = await serveDirectory('mcp', dir, {
    onAction: async (raw) => {
      const action = parseMcpManagerAction(raw);
      const toolAction = action.action === 'connect' || action.action === 'retry' ? { ...action, action: 'restart' } : action;
      const response = await handleMcpAction(toolAction, undefined, ctx, { trustedBrowserAction: true });
      if (response.isError) throw new Error((response.content[0] as { text?: string } | undefined)?.text ?? 'MCP update failed');
      await write();
      return { updated: true };
    },
    actionToken,
  });
  if (!served) return { ok: false, message: 'Could not start the local MCP page server.' };
  const opened = await openLocalUrl(served.url);
  return opened.ok ? { ok: true, url: served.url } : { ok: false, url: served.url, message: opened.message };
}
