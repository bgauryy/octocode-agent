import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getMcpEnablement, listMcpOverrides, openOctocodeDb } from '@octocodeai/octocode-awareness/mcp-state';
import type { PiContext } from '../types.js';
import { getOctocodeHome } from '../env.js';
import { escapeHtml, renderOctocodePage } from '../tui/html-page.js';
import { loadMcpConfig, type McpServerConfig } from './mcp-config.js';
import { getMcpDiscoverySnapshot, handleMcpAction } from './mcp-tool.js';
import { serveDirectory } from './local-server.js';
import { openLocalUrl } from './local-url-opener.js';

function managerDir(cwd: string): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 32);
  return path.join(getOctocodeHome(), 'tmp', 'mcp', key);
}

function safeConfig(config: McpServerConfig): Record<string, unknown> {
  return config.transport === 'http' || config.url
    ? {
        transport: 'streamable-http',
        url: config.url,
        headerKeys: Object.keys(config.headers ?? {}).sort(),
        timeoutMs: config.timeoutMs,
      }
    : {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        envKeys: Object.keys(config.env ?? {}).sort(),
        timeoutMs: config.timeoutMs,
      };
}

export async function renderMcpManagerPage(ctx?: PiContext): Promise<string> {
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
  const rows = [...loaded.configuredServers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => {
    const enabled = loaded.servers.has(name);
    const tools = catalog.get(name)?.tools ?? [];
    const toolRows = tools.map((tool) => {
      const toolEnabled = !db || getMcpEnablement(db, cwd, name, tool.name, true);
      const action = toolEnabled ? 'disable' : 'enable';
      return `<div class="row"><span><code>${escapeHtml(tool.name)}</code> <span class="badge ${toolEnabled ? 'on' : ''}">${toolEnabled ? 'enabled' : 'disabled'}</span> <span class="muted">${escapeHtml(tool.description)}</span></span><button class="${toolEnabled ? '' : 'primary'}" data-action="${action}" data-server="${escapeHtml(name)}" data-tool="${escapeHtml(tool.name)}">${toolEnabled ? 'Disable' : 'Enable'}</button></div>`;
    }).join('');
    return `<section>
      <div class="row"><h2>${escapeHtml(name)}</h2><span><span class="badge ${enabled ? 'on' : ''}">${enabled ? 'enabled' : 'disabled'}</span> <button class="${enabled ? '' : 'primary'}" data-action="${enabled ? 'disable' : 'enable'}" data-server="${escapeHtml(name)}">${enabled ? 'Disable' : 'Enable'}</button></span></div>
      <details><summary>Configuration (secret values redacted)</summary><pre>${escapeHtml(JSON.stringify(safeConfig(config), null, 2))}</pre></details>
      ${tools.length ? `<div class="stack">${toolRows}</div>` : '<p class="muted">No cached tools. Enable/connect the server to discover its catalog.</p>'}
    </section>`;
  }).join('');
  const sources = loaded.sources.map((source) => `<li><span class="badge">${escapeHtml(source.scope)}</span> <code>${escapeHtml(source.path)}</code>${source.trusted ? '' : ' (untrusted)'}</li>`).join('');
  const bodyHtml = `<section><h2>Configuration files</h2><ul>${sources}</ul><p class="muted">Enablement is stored in the shared Octocode SQLite database. Server definitions stay in canonical JSON; secrets are never copied into this page or mcp.md.</p></section>
    ${rows || '<section><p>No MCP servers configured.</p></section>'}
    <section><h2>Workspace overrides</h2><pre>${escapeHtml(JSON.stringify(overrides, null, 2))}</pre></section>
    <script type="module">
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        button.disabled = true;
        const response = await fetch('./__octocode/action', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ action:button.dataset.action, server:button.dataset.server, tool:button.dataset.tool || undefined, scope:'project' }) });
        const value = await response.json().catch(() => ({}));
        if (!response.ok || !value.ok) { alert(value.error || 'MCP update failed'); button.disabled = false; return; }
        location.reload();
      });
    </script>`;
  return renderOctocodePage({ title: 'MCP connections', bodyHtml });
}

export async function openMcpManager(ctx?: PiContext): Promise<{ ok: boolean; url?: string; message?: string }> {
  const cwd = ctx?.cwd ?? process.cwd();
  const dir = managerDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const write = async (): Promise<void> => fs.writeFileSync(path.join(dir, 'index.html'), await renderMcpManagerPage(ctx), 'utf8');
  await write();
  const served = await serveDirectory('mcp', dir, {
    onAction: async (raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid MCP action');
      const action = raw as Record<string, unknown>;
      if (action['action'] !== 'enable' && action['action'] !== 'disable') throw new Error('Unsupported MCP action');
      if (typeof action['server'] !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(action['server'])) throw new Error('Invalid MCP server');
      const response = await handleMcpAction(action, undefined, ctx);
      if (response.isError) throw new Error((response.content[0] as { text?: string } | undefined)?.text ?? 'MCP update failed');
      await write();
      return { updated: true };
    },
  });
  if (!served) return { ok: false, message: 'Could not start the local MCP page server.' };
  const opened = await openLocalUrl(served.url);
  return opened.ok ? { ok: true, url: served.url } : { ok: false, url: served.url, message: opened.message };
}
