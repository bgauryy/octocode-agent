import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSnapshot } from '@octocodeai/agent-core';

import { FileSettingsStorage } from '../src/native-settings.js';
import { createNativeSettingsService } from '../src/native-settings-service.js';
import { createNativeSettingsPageController } from '../src/native-settings-page.js';

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function harness(capabilityControl?: Parameters<typeof createNativeSettingsPageController>[0]['capabilityControl']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-settings-page-'));
  const storage = new FileSettingsStorage(path.join(dir, 'settings.json'));
  const saved = storage.commit('0', {
    theme: 'octocode-dark', defaultModel: 'gpt-5.6', defaultProvider: 'openai',
    apiKey: 'must-never-render', arbitrary: { nested: 'must-never-render-either' },
  });
  const openUrl = vi.fn(async () => ({ ok: true as const }));
  const settings = await createNativeSettingsService(storage);
  const controller = createNativeSettingsPageController({
    settings, cwd: dir, env: {
      OCTOCODE_MODEL: '<img src=x onerror=alert(1)>', OCTOCODE_MODEL_ENDPOINT: 'https://user:pass@example.test/v1?token=bad#frag',
      OCTOCODE_MODEL_API_KEY: 'must-never-render-env', ENABLE_LOCAL: 'true',
    },
    getRuntimeSnapshot: () => ({
      schemaVersion: 1, state: 'ready', sessionId: 's-settings', activeTurn: false,
      model: { providerId: 'openai', modelId: 'active-model' }, thinkingLevel: 'high',
      usage: { inputTokens: 12, outputTokens: 3 }, revision: 1,
    } as RuntimeSnapshot),
    workspaceTrust: 'trusted', openUrl, capabilityControl,
  });
  return { controller, storage, saved, openUrl };
}

describe('native settings page controller', () => {
  it('starts lazily, reuses one loopback server, opens routed sections, and closes', async () => {
    const { controller, openUrl } = await harness();
    const first = await controller.open('models');
    const second = await controller.open('appearance');
    expect(first.ok).toBe(true);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#models$/);
    expect(second.url?.replace('#appearance', '')).toBe(first.url?.replace('#models', ''));
    expect(openUrl).toHaveBeenCalledTimes(2);
    await controller.close();
    await expect(request(first.url!)).rejects.toThrow();
  });

  it('serves a comprehensive no-store page and an allowlisted secret-safe snapshot', async () => {
    const { controller } = await harness();
    const opened = await controller.open();
    const page = await request(opened.url!);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    for (const section of ['overview', 'runtime', 'appearance', 'models', 'hooks', 'plugins', 'commands', 'connections', 'skills', 'overrides', 'diagnostics']) {
      expect(page.body).toContain(`id=\"${section}\"`);
    }
    expect(page.body).not.toContain('must-never-render');
    expect(page.body).not.toContain('<img src=x');
    expect(page.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const snapshot = await request(new URL('/api/settings', opened.url!).href);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).not.toContain('must-never-render');
    expect(snapshot.body).not.toContain('user:pass');
    expect(snapshot.body).not.toContain('token=bad');
    expect(JSON.parse(snapshot.body)).toMatchObject({
      schemaVersion: 1,
      runtime: { state: 'ready', trust: 'trusted', model: 'openai/active-model' },
      credentials: { modelApiKeyConfigured: true },
    });
    await controller.close();
  });

  it('renders a keyboard and screen-reader navigable control center', async () => {
    const { controller } = await harness();
    const opened = await controller.open('models');
    const page = await request(opened.url!);

    expect(page.body).toContain('class="skip-link" href="#settings-content"');
    expect(page.body).toContain('<nav aria-label="Settings sections">');
    expect(page.body).toContain('<main id="settings-content" tabindex="-1">');
    expect(page.body).toContain('<section id="models" tabindex="-1" aria-labelledby="models-heading">');
    expect(page.body).toContain('<h2 id="models-heading">Models</h2>');
    expect(page.body).toContain('aria-describedby="model-help"');
    expect(page.body).toContain('id="status" role="status" aria-live="polite" aria-atomic="true"');
    expect(page.body).toContain(':focus-visible');
    expect(page.body).toContain('@media(prefers-reduced-motion:reduce)');
    expect(page.body).toContain("setAttribute('aria-current','location')");
    expect(page.body).toContain('target.focus({preventScroll:true})');

    await controller.close();
  });

  it('requires exact host, origin, token, JSON type, and revision for typed mutations', async () => {
    const { controller, storage } = await harness();
    const opened = await controller.open();
    const origin = new URL(opened.url!).origin;
    const info = controller.diagnostics();
    const mutationUrl = `${origin}/api/settings/mutate`;
    const initial = JSON.parse((await request(new URL('/api/settings', opened.url!).href)).body) as { revision: string };
    const body = JSON.stringify({
      schemaVersion: 1, requestId: 'req-1', expectedRevision: initial.revision, scope: 'global',
      actions: [{ op: 'set', key: 'theme', value: 'octocode-light' }],
    });
    expect((await request(mutationUrl, { method: 'POST', headers: { host: 'evil.example', origin, 'content-type': 'application/json', 'x-octocode-action-token': info.actionToken }, body })).status).toBe(403);
    expect((await request(mutationUrl, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json', 'x-octocode-action-token': info.actionToken }, body })).status).toBe(403);
    expect((await request(mutationUrl, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-octocode-action-token': 'bad' }, body })).status).toBe(403);
    expect((await request(mutationUrl, { method: 'POST', headers: { origin, 'content-type': 'text/plain', 'x-octocode-action-token': info.actionToken }, body })).status).toBe(415);

    const accepted = await request(mutationUrl, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-octocode-action-token': info.actionToken }, body });
    expect(accepted.status).toBe(200);
    expect(storage.read().values).toMatchObject({ theme: 'octocode-light', arbitrary: { nested: 'must-never-render-either' } });
    expect(accepted.body).not.toContain('must-never-render');

    const stale = await request(mutationUrl, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-octocode-action-token': info.actionToken }, body });
    expect(stale.status).toBe(409);
    await controller.close();
  });

  it('rejects unknown keys and invalid values without modifying storage', async () => {
    const { controller, storage, saved } = await harness();
    const opened = await controller.open();
    const origin = new URL(opened.url!).origin;
    const headers = { origin, 'content-type': 'application/json', 'x-octocode-action-token': controller.diagnostics().actionToken };
    for (const actions of [
      [{ op: 'set', key: 'apiKey', value: 'new-secret' }],
      [{ op: 'set', key: 'theme', value: 'plain-dark' }],
      [{ op: 'set', key: 'defaultModel', value: '' }],
    ]) {
      const response = await request(`${origin}/api/settings/mutate`, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, requestId: 'invalid', expectedRevision: saved.revision, scope: 'global', actions }) });
      expect(response.status).toBe(400);
    }
    expect(storage.read().revision).toBe(saved.revision);
    await controller.close();
  });

  it('exposes truthful hook status and typed review/grant browser actions', async () => {
    const { controller, storage } = await harness();
    const opened = await controller.open('hooks');
    const origin = new URL(opened.url!).origin;
    const page = await request(opened.url!);
    expect(page.body).not.toContain('executable hook dispatch is not composed');
    expect(page.body).toContain('value="review-extension"');
    expect(page.body).toContain('value="unreview-extension"');
    expect(page.body).toContain('value="grant-plugin-capability"');
    expect(page.body).toContain('value="revoke-plugin-capability"');
    const snapshot = JSON.parse((await request(`${origin}/api/settings`)).body) as { revision: string };
    const headers = { origin, 'content-type': 'application/json', 'x-octocode-action-token': controller.diagnostics().actionToken };
    const response = await request(`${origin}/api/settings/mutate`, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, requestId: 'review-ui', expectedRevision: snapshot.revision, scope: 'global', actions: [{ op: 'review-extension', id: 'plugin:demo', hash: 'b'.repeat(64) }] }) });
    expect(response.status).toBe(200);
    expect(storage.read().values).toMatchObject({ nativeExtensions: { reviewedHashes: { 'plugin:demo': 'b'.repeat(64) } } });
    await controller.close();
  });

  it('renders MCP and Skill controls and dispatches them through the typed capability authority', async () => {
    const mutate = vi.fn(async () => ({ ok: true as const, revision: 'cap-2' }));
    const capabilityControl = {
      snapshot: () => ({ revision: 'cap-1', mcpServers: [{ name: 'docs', enabled: true, tools: [{ name: 'search', enabled: false }] }], skills: [{ name: 'research', enabled: true }] }),
      mutate,
    };
    const { controller } = await harness(capabilityControl);
    const opened = await controller.open('connections');
    const origin = new URL(opened.url!).origin;
    const page = await request(opened.url!);
    expect(page.body).toContain('docs');
    expect(page.body).toContain('research');
    const headers = { origin, 'content-type': 'application/json', 'x-octocode-action-token': controller.diagnostics().actionToken };
    const response = await request(`${origin}/api/settings/mutate`, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, requestId: 'mcp-off', expectedRevision: 'cap-1', scope: 'capabilities', actions: [{ op: 'set-mcp-server-enabled', server: 'docs', enabled: false }] }) });
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith({ requestId: 'mcp-off', expectedRevision: 'cap-1', action: { op: 'set-mcp-server-enabled', server: 'docs', enabled: false } });
    await controller.close();
  });

  it('fails closed for unavailable or stale capability controls', async () => {
    const { controller } = await harness();
    const opened = await controller.open();
    const origin = new URL(opened.url!).origin;
    const headers = { origin, 'content-type': 'application/json', 'x-octocode-action-token': controller.diagnostics().actionToken };
    const body = JSON.stringify({ schemaVersion: 1, requestId: 'skill-off', expectedRevision: 'cap-1', scope: 'capabilities', actions: [{ op: 'set-skill-enabled', name: 'research', enabled: false }] });
    expect((await request(`${origin}/api/settings/mutate`, { method: 'POST', headers, body })).status).toBe(404);
    await controller.close();
  });
});
