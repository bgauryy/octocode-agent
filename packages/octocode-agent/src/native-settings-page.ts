import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { PluginPermission, RuntimeSnapshot } from '@octocodeai/agent-core';

import { NATIVE_SLASH_COMMANDS } from './native-command-catalog.js';
import type { NativeExtensionsSnapshot } from './native-extensions.js';
import type { NativeDiscoverySnapshot } from './native-discovery.js';
import type { NativeSettingsService } from './native-settings-service.js';
import { resolveNativeModelConfiguration } from './native-provider-registry.js';
import { OCTOCODE_THEME_NAMES } from './settings.js';
import {
  nativeBrowserTypographyCssVariables,
  nativeDesignCssVariables,
} from './presentation/design/tokens.js';

export const NATIVE_SETTINGS_SECTIONS = [
  'overview', 'runtime', 'appearance', 'models', 'hooks', 'plugins', 'commands',
  'connections', 'discovery', 'agent-context', 'skills', 'overrides', 'diagnostics',
] as const;
export type NativeSettingsSection = (typeof NATIVE_SETTINGS_SECTIONS)[number];

export interface NativeSettingsPageOpenResult {
  readonly ok: boolean;
  readonly url?: string;
  readonly message?: string;
}

export interface NativeSettingsPageController {
  open(section?: NativeSettingsSection): Promise<NativeSettingsPageOpenResult>;
  close(): Promise<void>;
  diagnostics(): { readonly url?: string; readonly actionToken: string };
}

export interface NativeSettingsCapabilitySnapshot {
  readonly revision: string;
  readonly mcpServers: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly source?: string;
    readonly path?: string;
    readonly connectionState: 'disconnected' | 'connecting' | 'connected';
    readonly catalogState: 'not-loaded' | 'ready' | 'stale' | 'empty';
    readonly lastRefreshAt?: number;
    readonly knownCatalogNames: readonly string[];
    readonly knownCatalogCount: number;
    readonly knownCatalogNamesTruncated: boolean;
    readonly tools: readonly { readonly name: string; readonly enabled: boolean }[];
  }[];
  readonly skills: readonly { readonly name: string; readonly enabled: boolean; readonly source?: string; readonly vendor?: string; readonly path?: string }[];
}
export type NativeSettingsCapabilityAction =
  | { readonly op: 'set-mcp-server-enabled'; readonly server: string; readonly enabled: boolean }
  | { readonly op: 'set-mcp-tool-enabled'; readonly server: string; readonly tool: string; readonly enabled: boolean }
  | { readonly op: 'set-skill-enabled'; readonly name: string; readonly source: string; readonly enabled: boolean }
  | { readonly op: 'refresh-skills' };
export interface NativeSettingsCapabilityControl {
  snapshot(): NativeSettingsCapabilitySnapshot;
  mutate(input: { readonly requestId: string; readonly expectedRevision: string; readonly action: NativeSettingsCapabilityAction }): Promise<{ readonly ok: boolean; readonly revision: string; readonly error?: string }>;
}

export interface SettingsPageOptions {
  readonly settings: NativeSettingsService;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly getRuntimeSnapshot: () => RuntimeSnapshot;
  readonly workspaceTrust: 'trusted' | 'untrusted' | 'unknown';
  readonly getExtensionsSnapshot?: () => NativeExtensionsSnapshot;
  readonly capabilityControl?: NativeSettingsCapabilityControl;
  readonly getDiscoverySnapshot?: () => NativeDiscoverySnapshot;
  readonly openUrl?: (url: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
}

interface SettingsMutationRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedRevision: string;
  readonly scope: 'global' | 'capabilities';
  readonly actions: readonly (SettingsPageAction | NativeSettingsCapabilityAction)[];
}
type SettingsPageAction =
  | { readonly op: 'set'; readonly key: string; readonly value: unknown }
  | { readonly op: 'unset'; readonly key: string }
  | { readonly op: 'set-default-model'; readonly providerId: string; readonly modelId: string }
  | { readonly op: 'review-extension'; readonly id: string; readonly hash: string }
  | { readonly op: 'unreview-extension'; readonly id: string }
  | { readonly op: 'grant-plugin-capability'; readonly pluginId: string; readonly permission: PluginPermission }
  | { readonly op: 'revoke-plugin-capability'; readonly pluginId: string; readonly permission: PluginPermission }
  | { readonly op: 'import-settings'; readonly document: unknown }
  | { readonly op: 'reset-settings' };

const BODY_LIMIT = 32_768;
const pluginPermissions: readonly PluginPermission[] = ['events.observe', 'events.decide', 'tools.register', 'commands.register', 'resources.register', 'mcp.register', 'settings.register', 'prompts.register', 'ui.register', 'models.register', 'process.execute', 'network.access', 'filesystem.read', 'filesystem.write', 'secrets.read'];

function endpointHost(value: string | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).host || null; }
  catch { return 'configured (invalid URL)'; }
}

function publicDiscoverySnapshot(discovery: NativeDiscoverySnapshot, env: NodeJS.ProcessEnv) {
  const selectedCredential = discovery.models.credential;
  return {
    ...discovery,
    models: {
      ...discovery.models,
      credential: {
        providerId: selectedCredential.providerId,
        configured: selectedCredential.configured,
        source: selectedCredential.source,
        verification: selectedCredential.verification,
      },
      providers: discovery.models.providers.map(({ endpoint, credential, headers: _headers, ...provider }) => {
        const readiness = selectedCredential.providerId === provider.id
          ? {
              configured: selectedCredential.configured,
              source: selectedCredential.source,
              verification: selectedCredential.verification,
            }
          : credential?.type === 'environment'
            ? { configured: Boolean(env[credential.name]?.trim()), source: 'environment' as const, verification: 'discovery' as const }
            : credential?.type === 'reference'
              ? { configured: false, source: 'reference' as const, verification: 'request-time' as const }
              : { configured: false, source: 'none' as const, verification: 'discovery' as const };
        return { ...provider, endpointHost: endpointHost(endpoint), credential: readiness };
      }),
    },
  };
}

function settingsSnapshot(options: SettingsPageOptions) {
  const settings = options.settings.snapshot();
  const diagnostics = options.settings.diagnostics();
  const value = (key: string) => settings.values.find((entry) => entry.key === key)?.value;
  const extensions = options.getExtensionsSnapshot?.();
  const runtime = options.getRuntimeSnapshot();
  const capabilityControl = options.capabilityControl?.snapshot();
  const discovery = options.getDiscoverySnapshot?.();
  const themeValue = value('theme');
  const theme = OCTOCODE_THEME_NAMES.includes(themeValue as never)
    ? themeValue as string
    : 'octocode-dark';
  const reducedMotion = value('reducedMotion') !== false;
  const modelValue = value('defaultModel');
  const defaultModel = typeof modelValue === 'string' ? modelValue : '';
  const providerValue = value('defaultProvider');
  const defaultProvider = typeof providerValue === 'string'
    ? providerValue
    : runtime.model?.providerId ?? '';
  return {
    schemaVersion: 1 as const,
    revision: String(settings.revision),
    runtime: {
      cwd: options.cwd,
      state: runtime.state,
      sessionId: String(runtime.sessionId ?? 'not started'),
      model: runtime.model ? `${runtime.model.providerId}/${runtime.model.modelId}` : null,
      thinkingLevel: runtime.thinkingLevel ?? null,
      trust: options.workspaceTrust,
      activeTurn: runtime.activeTurn,
      usage: runtime.usage,
    },
    settings: {
      theme: { value: theme, editable: true, application: 'next session' },
      reducedMotion: { value: reducedMotion, editable: true, application: 'next session' },
      defaultModel: { value: defaultModel, editable: true, application: 'next session' },
      defaultProvider: { value: defaultProvider, editable: true, application: 'next session' },
    },
    credentials: {
      modelApiKeyConfigured: discovery?.models.credential.configured
        ?? Boolean(options.env.OCTOCODE_MODEL_API_KEY || options.env.OPENAI_API_KEY || options.env.ANTHROPIC_API_KEY),
    },
    sources: {
      legacyModelEnvironmentIgnored: Boolean(
        options.env.OCTOCODE_MODEL
        || options.env.OCTOCODE_MODEL_PROVIDER
        || options.env.OCTOCODE_MODEL_ID
        || options.env.OCTOCODE_MODEL_PROTOCOL
        || options.env.OCTOCODE_MODEL_ENDPOINT,
      ),
      modelEndpoint: null,
      localTools: options.env.ENABLE_LOCAL !== 'false',
      cloneTools: options.env.ENABLE_CLONE === 'true',
      releaseTools: options.env.ENABLE_RELEASES === 'true',
    },
    capabilities: {
      hooks: extensions === undefined
        ? 'extension controller unavailable'
        : `${extensions.hooks.entries.length} discovered source(s); executable hook dispatch is active`,
      plugins: extensions === undefined
        ? 'extension controller unavailable'
        : `${extensions.plugins.length} discovered, ${extensions.plugins.filter(({ active }) => active).length} active`,
      commands: NATIVE_SLASH_COMMANDS.map(({ usage, description }) => ({ usage, description })),
      control: capabilityControl ?? null,
    },
    discovery: discovery === undefined ? null : publicDiscoverySnapshot(discovery, options.env),
    overrides: {
      unknownStoredKeys: diagnostics.unknownStoredKeys,
    },
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function renderPage(snapshot: ReturnType<typeof settingsSnapshot>, actionToken: string, nonce: string): string {
  const navigation = NATIVE_SETTINGS_SECTIONS.map((section) => `<a href="#${section}">${section.replaceAll('-', ' ')}</a>`).join('');
  const commands = snapshot.capabilities.commands.map(({ usage, description }) => `<li><code>${escapeHtml(usage)}</code><span>${escapeHtml(description)}</span></li>`).join('');
  const sourceRows = Object.entries(snapshot.sources).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? 'not configured')}</dd></div>`).join('');
  const permissionOptions = pluginPermissions.map((permission) => `<option>${permission}</option>`).join('');
  const modelSourceRows = snapshot.discovery?.models.sources.map((source) => `<li><span><b>${escapeHtml(source.id)}</b> · ${escapeHtml(source.owner ?? 'unknown')} · <code>${escapeHtml(source.path ?? 'built in')}</code></span><span>${escapeHtml(source.parseState)}</span></li>`).join('') ?? '';
  const modelSources = new Map(snapshot.discovery?.models.sources.map((source) => [source.id, source]) ?? []);
  const providerRows = snapshot.discovery?.models.providers.map((provider) => {
    const source = modelSources.get(provider.sourceId);
    const readiness = provider.credential.configured ? 'ready' : provider.credential.verification === 'request-time' ? 'request-time' : 'missing';
    const reason = provider.warnings?.join('; ') || (provider.enabled ? 'supported' : 'unsupported or disabled');
    return `<li><span><b>${escapeHtml(provider.id)}</b> · protocol ${escapeHtml(provider.apiFamily)} · endpoint host <code>${escapeHtml(provider.endpointHost ?? 'provider default')}</code><br>source ${escapeHtml(provider.sourceId)} · ${escapeHtml(source?.owner ?? 'unknown')} · <code>${escapeHtml(source?.path ?? 'built in')}</code> · credential ${escapeHtml(readiness)} (${escapeHtml(provider.credential.source)})</span><span>${provider.enabled ? 'enabled' : 'disabled'} · ${escapeHtml(reason)}</span></li>`;
  }).join('') ?? '';
  const modelRows = snapshot.discovery?.models.entries.map((model) => {
    const source = modelSources.get(model.sourceId);
    const reason = model.warnings.join('; ') || (model.enabled ? 'supported' : 'unsupported or disabled');
    const adopt = source?.owner === 'pi' && model.enabled
      ? `<form class="adopt-model-form"><button type="submit" data-provider="${escapeHtml(model.providerId)}" data-model="${escapeHtml(model.id)}">Adopt Pi model as native default</button></form>`
      : '';
    return `<li><span><b>${escapeHtml(model.displayName)}</b> · <code>${escapeHtml(model.providerId)}/${escapeHtml(model.id)}</code><br>source ${escapeHtml(model.sourceId)} · ${escapeHtml(source?.owner ?? 'unknown')} · <code>${escapeHtml(source?.path ?? 'built in')}</code><br>${escapeHtml(reason)}</span><span>${model.enabled ? 'enabled' : 'disabled'}${adopt}</span></li>`;
  }).join('') ?? '';
  const mcpRows = snapshot.capabilities.control?.mcpServers.map((server) => {
    const catalogState = server.catalogState ?? 'not-loaded';
    const connectionState = server.connectionState ?? 'disconnected';
    const knownCatalogNames = server.knownCatalogNames ?? [];
    const knownCatalogCount = server.knownCatalogCount ?? knownCatalogNames.length;
    const tools = server.tools.map((tool) => `${escapeHtml(tool.name)} (${tool.enabled ? 'on' : 'off'})`).join(', ')
      || (catalogState === 'empty' ? 'catalog empty' : `catalog ${escapeHtml(catalogState)}`);
    const refresh = server.lastRefreshAt === undefined ? 'never refreshed' : `last refresh ${escapeHtml(new Date(server.lastRefreshAt).toISOString())}`;
    const known = server.knownCatalogNamesTruncated ? ` · showing ${knownCatalogNames.length} of ${knownCatalogCount}` : '';
    return `<li><span><b>${escapeHtml(server.name)}</b> · ${escapeHtml(server.source ?? 'octocode')} · <code>${escapeHtml(server.path ?? 'runtime')}</code><br>${tools}<br><span class="hint">${escapeHtml(connectionState)} · catalog ${escapeHtml(catalogState)} · ${refresh}${known}</span></span><span>${server.enabled ? 'enabled' : 'disabled'}</span></li>`;
  }).join('') ?? '';
  const skillRows = snapshot.capabilities.control?.skills.map((skill) => `<li><span><b>${escapeHtml(skill.name)}</b> · ${escapeHtml(skill.vendor ?? skill.source ?? 'octocode')} · <code>${escapeHtml(skill.path ?? 'runtime')}</code></span><span>${skill.enabled ? 'enabled' : 'disabled'}</span></li>`).join('') ?? '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Octocode settings</title><style nonce="${nonce}">
  :root{color-scheme:dark;${nativeDesignCssVariables('dark')};${nativeBrowserTypographyCssVariables()};--bg:var(--octocode-background);--panel:var(--octocode-surface);--line:var(--octocode-border);--text:var(--octocode-text);--muted:var(--octocode-muted);--accent:var(--octocode-accent);--ok:var(--octocode-success)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,color-mix(in srgb,var(--octocode-accent) 20%,transparent) 0,transparent 34rem),var(--bg);color:var(--text);font:var(--octocode-font-size)/var(--octocode-line-height) var(--octocode-font-sans);display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}.skip-link{position:fixed;z-index:10;left:12px;top:8px;transform:translateY(-160%);background:var(--accent);color:var(--octocode-background);padding:9px 12px;border-radius:8px;font-weight:700}.skip-link:focus{transform:none}nav{position:sticky;top:0;height:100vh;padding:28px 18px;border-right:1px solid var(--line);background:color-mix(in srgb,var(--octocode-background) 87%,transparent);backdrop-filter:blur(12px)}nav strong{display:block;font-size:18px;margin:0 10px 18px}nav a{display:block;color:var(--muted);text-decoration:none;padding:7px 10px;border-radius:8px;text-transform:capitalize}nav a:hover,nav a[aria-current="location"]{color:var(--text);background:var(--octocode-surface-raised)}:focus-visible{outline:3px solid var(--octocode-focus);outline-offset:3px}main{max-width:1000px;padding:42px 48px 100px}header{margin-bottom:30px}h1{font-size:34px;margin:0}h2{margin:0 0 14px;font-size:20px}section{scroll-margin-top:20px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:14px;padding:22px;margin:0 0 18px;box-shadow:0 12px 34px #0003}.eyebrow,.hint{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.metric,dl>div{background:var(--octocode-surface);border:1px solid var(--octocode-border);border-radius:10px;padding:12px}.metric b,dt{display:block;color:var(--muted);font-size:12px}dd{margin:4px 0 0;overflow-wrap:anywhere}label{display:grid;gap:6px;margin:12px 0}input,select,textarea,button{font:inherit;color:var(--text);background:var(--octocode-surface);border:1px solid var(--octocode-border);border-radius:8px;padding:9px 10px}textarea{width:100%;resize:vertical}button{background:var(--accent);color:var(--octocode-background);border:0;font-weight:700;cursor:pointer}button:disabled{cursor:wait;opacity:.65}.status{min-height:22px;color:var(--ok)}ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:9px 0}code{font-family:var(--octocode-font-mono);color:var(--octocode-code)}@media(max-width:720px){body{display:block}nav{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line);columns:2}nav strong{column-span:all}main{padding:28px 16px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
  @media(prefers-color-scheme:light){:root{color-scheme:light;${nativeDesignCssVariables('light')}}}
  </style></head><body><a class="skip-link" href="#settings-content">Skip to settings</a><nav aria-label="Settings sections"><strong>Octocode</strong>${navigation}</nav><main id="settings-content" tabindex="-1"><header><div class="eyebrow">Local control center · changes use revision checks</div><h1>Agent settings</h1><p class="hint">Runtime truth, configuration sources, and safe next-session defaults in one place.</p></header>
  <section id="overview"><h2>Overview</h2><div class="grid"><div class="metric"><b>State</b>${escapeHtml(snapshot.runtime.state)}</div><div class="metric"><b>Session</b>${escapeHtml(snapshot.runtime.sessionId)}</div><div class="metric"><b>Model</b>${escapeHtml(snapshot.runtime.model ?? 'not selected')}</div><div class="metric"><b>Workspace trust</b>${escapeHtml(snapshot.runtime.trust)}</div></div></section>
  <section id="runtime"><h2>Runtime</h2><dl>${sourceRows}<div><dt>Workspace</dt><dd>${escapeHtml(snapshot.runtime.cwd)}</dd></div><div><dt>Thinking</dt><dd>${escapeHtml(snapshot.runtime.thinkingLevel ?? 'default')}</dd></div></dl></section>
  <section id="appearance"><h2>Appearance</h2><form id="theme-form"><label>Theme<select id="theme">${OCTOCODE_THEME_NAMES.map((theme) => `<option${snapshot.settings.theme.value === theme ? ' selected' : ''}>${theme}</option>`).join('')}</select></label><button>Save theme for next session</button></form><form id="motion-form"><label>Motion<select id="reduced-motion"><option value="true"${snapshot.settings.reducedMotion.value ? ' selected' : ''}>Reduced (static)</option><option value="false"${snapshot.settings.reducedMotion.value ? '' : ' selected'}>Standard</option></select></label><button>Save motion preference for next session</button></form></section>
  <section id="models" tabindex="-1" aria-labelledby="models-heading"><h2 id="models-heading">Models</h2>${snapshot.discovery ? `<p>Discovered selection: <code>${escapeHtml(snapshot.discovery.models.selection.providerId)}/${escapeHtml(snapshot.discovery.models.selection.modelId)}</code> · source ${escapeHtml(snapshot.discovery.models.selectionSource)} · credential ${snapshot.discovery.models.credential.configured ? 'ready' : 'missing'} (${escapeHtml(snapshot.discovery.models.credential.source)}; ${escapeHtml(snapshot.discovery.models.credential.verification)})</p>` : ''}<form id="model-form"><label for="default-provider">Default provider</label><input id="default-provider" required maxlength="200" pattern="[A-Za-z0-9_.-]+" value="${escapeHtml(snapshot.settings.defaultProvider.value)}"><label for="default-model">Default model</label><input id="default-model" required maxlength="200" aria-describedby="model-help" value="${escapeHtml(snapshot.settings.defaultModel.value)}"><p class="hint" id="model-help">Provider and model are saved together for the next session. Catalog discovery is file-backed; runtime environment overrides are shown separately under Runtime and are not catalog sources.</p><button>Save for next session</button></form><h3>Sources</h3><ul>${modelSourceRows || '<li>No model sources discovered.</li>'}</ul><h3>Providers</h3><ul>${providerRows || '<li>No model providers discovered.</li>'}</ul><h3>Models</h3><ul>${modelRows || '<li>No models discovered.</li>'}</ul></section>
  <section id="hooks"><h2>Hooks</h2><p>${escapeHtml(snapshot.capabilities.hooks)}</p><form id="hook-policy-form"><label>Extension id<input id="extension-id" required maxlength="180"></label><label>Reviewed SHA-256<input id="extension-hash" pattern="[a-f0-9]{64}" maxlength="64"></label><button name="operation" value="review-extension">Review hash</button> <button name="operation" value="unreview-extension">Remove review</button></form></section><section id="plugins"><h2>Plugins</h2><p>${escapeHtml(snapshot.capabilities.plugins)}</p><form id="plugin-policy-form"><label>Plugin id<input id="plugin-id" required maxlength="128"></label><label>Capability<select id="plugin-permission">${permissionOptions}</select></label><button name="operation" value="grant-plugin-capability">Grant</button> <button name="operation" value="revoke-plugin-capability">Revoke</button></form></section>
  <section id="commands"><h2>Commands</h2><ul>${commands}</ul></section><section id="connections"><h2>Connections</h2><p>Model endpoint: ${escapeHtml(snapshot.sources.modelEndpoint ?? 'provider default')} · Credential configured: ${snapshot.credentials.modelApiKeyConfigured ? 'yes' : 'no'}.</p><h3>MCP servers and tools</h3>${snapshot.capabilities.control ? `<ul>${mcpRows}</ul><form id="mcp-form"><label>Server<input id="mcp-server" required maxlength="128"></label><label>Tool (empty selects server)<input id="mcp-tool" maxlength="128"></label><label>State<select id="mcp-enabled"><option value="true">enabled</option><option value="false">disabled</option></select></label><button>Apply</button></form>` : '<p class="hint">MCP controls are unavailable in this host composition.</p>'}<h3>MCP Tasks</h3><p class="hint">Task operations are available only when a configured server negotiates the versioned MCP Tasks capability.</p></section><section id="discovery"><h2>Discovery</h2><p>Local tools: ${snapshot.sources.localTools ? 'enabled' : 'disabled'} · Clone: ${snapshot.sources.cloneTools ? 'enabled' : 'disabled'} · Releases: ${snapshot.sources.releaseTools ? 'enabled' : 'disabled'}.</p></section>
  <section id="agent-context"><h2>Agent context</h2><p>Active turn: ${snapshot.runtime.activeTurn ? 'yes' : 'no'} · Input tokens: ${snapshot.runtime.usage.inputTokens} · Output tokens: ${snapshot.runtime.usage.outputTokens}.</p></section><section id="skills"><h2>Skills</h2>${snapshot.capabilities.control ? `<ul>${skillRows}</ul><form id="skill-form"><label>Skill<input id="skill-name" maxlength="64"></label><label>Source ID<input id="skill-source" maxlength="512"></label><label>Action<select id="skill-action"><option value="enable">enable</option><option value="disable">disable</option><option value="refresh">refresh catalog</option></select></label><button>Apply</button></form>` : '<p class="hint">Skill controls are unavailable in this host composition.</p>'}</section>
  <section id="overrides"><h2>User configuration</h2><p>${snapshot.overrides.unknownStoredKeys.length} additional stored key(s). Names and types are shown by the API; values are never exposed.</p><p><a href="/api/settings/export" download="octocode-settings.json">Export portable settings</a></p><form id="settings-import-form"><label for="settings-import">Import portable settings JSON</label><textarea id="settings-import" rows="8" required></textarea><button>Import settings</button></form><form><button id="settings-reset" type="button">Reset registered settings</button></form></section><section id="diagnostics"><h2>Diagnostics</h2><p>Revision <code id="revision">${escapeHtml(snapshot.revision)}</code></p><div class="status" id="status" role="status" aria-live="polite" aria-atomic="true"></div></section>
  <script nonce="${nonce}">const capabilityToken=${safeJson(actionToken)};let capabilityRevision=${safeJson(snapshot.capabilities.control?.revision ?? null)};async function mutateCapability(action,form){const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/api/settings/mutate',{method:'POST',headers:{'content-type':'application/json','x-octocode-action-token':capabilityToken},body:JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),expectedRevision:capabilityRevision,scope:'capabilities',actions:[action]})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Capability update failed');capabilityRevision=data.revision;document.querySelector('#status').textContent='Capability updated.'}finally{button.disabled=false}}addEventListener('DOMContentLoaded',()=>{document.querySelector('#motion-form')?.addEventListener('submit',async(event)=>{event.preventDefault();try{await mutate([{op:'set',key:'reducedMotion',value:document.querySelector('#reduced-motion').value==='true'}],event.currentTarget)}catch(error){document.querySelector('#status').textContent=error instanceof Error?error.message:'Motion update failed'}});document.querySelector('#mcp-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const server=document.querySelector('#mcp-server').value;const tool=document.querySelector('#mcp-tool').value;const enabled=document.querySelector('#mcp-enabled').value==='true';try{await mutateCapability(tool?{op:'set-mcp-tool-enabled',server,tool,enabled}:{op:'set-mcp-server-enabled',server,enabled},event.currentTarget)}catch(error){document.querySelector('#status').textContent=error instanceof Error?error.message:'MCP update failed'}});document.querySelector('#skill-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const name=document.querySelector('#skill-name').value;const source=document.querySelector('#skill-source').value;const action=document.querySelector('#skill-action').value;try{await mutateCapability(action==='refresh'?{op:'refresh-skills'}:{op:'set-skill-enabled',name,source,enabled:action==='enable'},event.currentTarget)}catch(error){document.querySelector('#status').textContent=error instanceof Error?error.message:'Skill update failed'}})});</script>
  </main><script nonce="${nonce}">const initial=${safeJson(snapshot)};const token=${safeJson(actionToken)};let revision=initial.revision;const status=document.querySelector('#status');function activateSection(){const id=location.hash.slice(1)||'overview';for(const link of document.querySelectorAll('nav a'))link.removeAttribute('aria-current');const link=document.querySelector('nav a[href="#'+CSS.escape(id)+'"]');link?.setAttribute('aria-current','location');const target=document.getElementById(id);if(location.hash&&target){target.focus({preventScroll:true});target.scrollIntoView({block:'start'});}}addEventListener('hashchange',activateSection);activateSection();async function mutate(actions,form){const button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';try{const response=await fetch('/api/settings/mutate',{method:'POST',headers:{'content-type':'application/json','x-octocode-action-token':token},body:JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),expectedRevision:revision,scope:'global',actions})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Settings update failed');revision=data.revision;document.querySelector('#revision').textContent=revision;status.textContent='Saved. Applies next session.'}finally{button.disabled=false}}document.querySelector('#theme-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await mutate([{op:'set',key:'theme',value:document.querySelector('#theme').value}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Settings update failed'}});document.querySelector('#model-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await mutate([{op:'set-default-model',providerId:document.querySelector('#default-provider').value,modelId:document.querySelector('#default-model').value}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Settings update failed'}});for(const form of document.querySelectorAll('.adopt-model-form'))form.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.currentTarget.querySelector('button');try{await mutate([{op:'set-default-model',providerId:button.dataset.provider,modelId:button.dataset.model}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Model adoption failed'}});document.querySelector('#hook-policy-form').addEventListener('submit',async(event)=>{event.preventDefault();const op=event.submitter.value;const id=document.querySelector('#extension-id').value;const hash=document.querySelector('#extension-hash').value;try{await mutate([op==='review-extension'?{op,id,hash}:{op,id}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Extension review failed'}});document.querySelector('#plugin-policy-form').addEventListener('submit',async(event)=>{event.preventDefault();const op=event.submitter.value;try{await mutate([{op,pluginId:document.querySelector('#plugin-id').value,permission:document.querySelector('#plugin-permission').value}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Plugin capability update failed'}});document.querySelector('#settings-import-form').addEventListener('submit',async(event)=>{event.preventDefault();try{const documentValue=JSON.parse(document.querySelector('#settings-import').value);await mutate([{op:'import-settings',document:documentValue}],event.currentTarget)}catch(error){status.textContent=error instanceof Error?error.message:'Settings import failed'}});document.querySelector('#settings-reset').addEventListener('click',async(event)=>{try{await mutate([{op:'reset-settings'}],event.currentTarget.parentElement)}catch(error){status.textContent=error instanceof Error?error.message:'Settings reset failed'}});</script></body></html>`;
}

function defaultOpenUrl(target: string): Promise<{ ok: boolean; message?: string }> {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return Promise.resolve({ ok: false, message: 'Refusing to open a non-loopback URL.' });
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.once('error', () => resolve({ ok: false, message: `Could not open the browser. Open ${target} manually.` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}

function parseMutation(value: unknown, editableKeys: ReadonlySet<string>): SettingsMutationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings mutation');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.requestId !== 'string' || !item.requestId || typeof item.expectedRevision !== 'string' || (item.scope !== 'global' && item.scope !== 'capabilities') || !Array.isArray(item.actions) || item.actions.length !== 1) throw new Error('Invalid settings mutation');
  for (const action of item.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid settings action');
    const candidate = action as Record<string, unknown>;
    if (item.scope === 'capabilities') {
      const validName = (entry: unknown) => typeof entry === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(entry);
      if (candidate.op === 'refresh-skills') continue;
      if (candidate.op === 'set-skill-enabled' && validName(candidate.name) && typeof candidate.source === 'string' && candidate.source.length > 0 && candidate.source.length <= 512 && !candidate.source.includes('\0') && typeof candidate.enabled === 'boolean') continue;
      if (candidate.op === 'set-mcp-server-enabled' && validName(candidate.server) && typeof candidate.enabled === 'boolean') continue;
      if (candidate.op === 'set-mcp-tool-enabled' && validName(candidate.server) && validName(candidate.tool) && typeof candidate.enabled === 'boolean') continue;
      throw new Error('Invalid capability action');
    }
    if (candidate.op === 'reset-settings') continue;
    if (candidate.op === 'import-settings' && candidate.document !== undefined) continue;
    if (candidate.op === 'set-default-model') {
      if (typeof candidate.providerId !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(candidate.providerId)) throw new Error('Invalid default provider');
      if (typeof candidate.modelId !== 'string' || !candidate.modelId.trim() || candidate.modelId.length > 200) throw new Error('Invalid default model');
      continue;
    }
    if (candidate.op === 'review-extension') {
      if (typeof candidate.id !== 'string' || typeof candidate.hash !== 'string') throw new Error('Invalid extension review');
      continue;
    }
    if (candidate.op === 'unreview-extension') {
      if (typeof candidate.id !== 'string') throw new Error('Invalid extension review');
      continue;
    }
    if (candidate.op === 'grant-plugin-capability' || candidate.op === 'revoke-plugin-capability') {
      if (typeof candidate.pluginId !== 'string' || typeof candidate.permission !== 'string') throw new Error('Invalid plugin capability');
      continue;
    }
    if ((candidate.op !== 'set' && candidate.op !== 'unset') || typeof candidate.key !== 'string' || !editableKeys.has(candidate.key)) throw new Error('Unsupported settings action');
    if (candidate.op === 'set') {
      if (candidate.key === 'reducedMotion') {
        if (typeof candidate.value !== 'boolean') throw new Error('Reduced motion must be boolean');
        continue;
      }
      if (typeof candidate.value !== 'string') throw new Error('Settings values must be strings');
      if (candidate.key === 'theme' && !(OCTOCODE_THEME_NAMES as readonly string[]).includes(candidate.value)) throw new Error('Invalid theme');
      if (candidate.key === 'defaultModel' && (!candidate.value.trim() || candidate.value.length > 200)) throw new Error('Default model must contain 1-200 characters');
    }
  }
  return value as SettingsMutationRequest;
}

export function createNativeSettingsPageController(options: SettingsPageOptions): NativeSettingsPageController {
  const actionToken = randomBytes(32).toString('base64url');
  const nonce = randomBytes(18).toString('base64url');
  const editableKeys = new Set(options.settings.snapshot().definitions
    .filter(({ mutability, scopes, visibility }) => mutability === 'editable' && scopes.includes('global') && visibility === 'public')
    .map(({ key }) => key));
  let server: http.Server | undefined;
  let origin: string | undefined;
  let starting: Promise<string> | undefined;

  const headers = (contentType: string) => ({
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  const send = (res: http.ServerResponse, status: number, value: unknown, json = false): void => {
    res.writeHead(status, headers(json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'));
    res.end(json ? JSON.stringify(value) : String(value));
  };
  const start = (): Promise<string> => {
    if (origin) return Promise.resolve(origin);
    if (starting) return starting;
    const pending = new Promise<string>((resolve, reject) => {
      const candidate = http.createServer((req, res) => {
        const expectedHost = origin ? new URL(origin).host : '';
        if ((req.headers.host ?? '').toLowerCase() !== expectedHost.toLowerCase()) return send(res, 403, 'forbidden');
        const pathname = (() => { try { return new URL(req.url ?? '/', origin).pathname; } catch { return ''; } })();
        if (req.method === 'GET' && pathname === '/') {
          res.writeHead(200, headers('text/html; charset=utf-8'));
          res.end(renderPage(settingsSnapshot(options), actionToken, nonce));
          return;
        }
        if (req.method === 'GET' && pathname === '/api/settings') return send(res, 200, settingsSnapshot(options), true);
        if (req.method === 'GET' && pathname === '/api/settings/export') return send(res, 200, options.settings.exportPortable(), true);
        if (pathname !== '/api/settings/mutate') return send(res, 404, 'not found');
        if (req.method !== 'POST') return send(res, 405, 'method not allowed');
        if (req.headers.origin !== origin || req.headers['x-octocode-action-token'] !== actionToken) return send(res, 403, 'forbidden');
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, 'application/json required');
        let body = '';
        let bytes = 0;
        let ended = false;
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          if (ended) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > BODY_LIMIT) { ended = true; send(res, 413, 'request body too large'); req.destroy(); return; }
          body += chunk;
        });
        req.on('end', async () => {
          if (ended) return;
          try {
            const mutation = parseMutation(JSON.parse(body), editableKeys);
            if (mutation.scope === 'capabilities') {
              if (!options.capabilityControl) return send(res, 404, { ok: false, error: 'Capability controls are unavailable.' }, true);
              const result = await options.capabilityControl.mutate({ requestId: mutation.requestId, expectedRevision: mutation.expectedRevision, action: mutation.actions[0] as NativeSettingsCapabilityAction });
              return send(res, result.ok ? 200 : 409, result, true);
            }
            const current = options.settings.snapshot();
            if (String(current.revision) !== mutation.expectedRevision) return send(res, 409, { ok: false, error: 'Settings changed; refresh and try again.', revision: String(current.revision) }, true);
            const action = mutation.actions[0]! as SettingsPageAction;
            const common = { requestId: mutation.requestId, expectedRevision: current.revision, workspaceTrusted: options.workspaceTrust === 'trusted' };
            if (action.op === 'set-default-model') {
              resolveNativeModelConfiguration({
                env: options.env,
                cwd: options.cwd,
                configuredProvider: action.providerId,
                configuredModel: action.modelId,
                configuredSelectionSource: 'native.settings',
                forceConfiguredSelection: true,
                workspaceTrusted: options.workspaceTrust === 'trusted',
              });
            }
            const result = action.op === 'reset-settings'
              ? await options.settings.reset(common)
              : action.op === 'import-settings'
                ? await options.settings.importPortable({ requestId: common.requestId, expectedRevision: common.expectedRevision, document: action.document })
                : action.op === 'set-default-model'
                  ? await options.settings.setDefaultModel({ requestId: common.requestId, expectedRevision: common.expectedRevision, providerId: action.providerId, modelId: action.modelId })
                : action.op === 'review-extension'
              ? await options.settings.reviewExtension({ ...common, id: action.id, hash: action.hash })
              : action.op === 'unreview-extension'
                ? await options.settings.unreviewExtension({ ...common, id: action.id })
                : action.op === 'grant-plugin-capability'
                  ? await options.settings.grantPluginCapability({ ...common, pluginId: action.pluginId, permission: action.permission })
                  : action.op === 'revoke-plugin-capability'
                    ? await options.settings.revokePluginCapability({ ...common, pluginId: action.pluginId, permission: action.permission })
                    : await options.settings.mutate({
                        protocolVersion: 1,
                        requestId: mutation.requestId,
                        action: action.op,
                        scope: 'global',
                        expectedRevision: current.revision,
                        payload: action.op === 'unset' ? { key: action.key } : { key: action.key, value: action.value },
                      });
            if (!result.ok) {
              const status = result.error.category === 'conflict' ? 409 : result.error.category === 'persistence' ? 500 : 400;
              return send(res, status, { ok: false, error: result.error.message, revision: String(options.settings.snapshot().revision) }, true);
            }
            const snapshot = settingsSnapshot(options);
            send(res, 200, { ok: true, requestId: mutation.requestId, revision: snapshot.revision, snapshot }, true);
          } catch (error) {
            if (error instanceof Error && /revision conflict/i.test(error.message)) return send(res, 409, { ok: false, error: 'Settings changed; refresh and try again.' }, true);
            send(res, 400, { ok: false, error: 'Invalid settings request.' }, true);
          }
        });
      });
      candidate.once('error', reject);
      candidate.listen(0, '127.0.0.1', () => {
        const address = candidate.address();
        if (!address || typeof address === 'string') { candidate.close(); reject(new Error('Could not resolve local settings address')); return; }
        server = candidate;
        const resolvedOrigin = `http://127.0.0.1:${address.port}`;
        origin = resolvedOrigin;
        candidate.unref();
        resolve(resolvedOrigin);
      });
    }).finally(() => { starting = undefined; });
    starting = pending;
    return pending;
  };
  return {
    async open(section) {
      const base = await start();
      const url = `${base}/${section ? `#${section}` : ''}`;
      const opened = await (options.openUrl ?? defaultOpenUrl)(url);
      return { ...opened, url };
    },
    async close() {
      const active = server;
      server = undefined;
      origin = undefined;
      if (!active) return;
      await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
    diagnostics: () => ({ ...(origin ? { url: origin } : {}), actionToken }),
  };
}
