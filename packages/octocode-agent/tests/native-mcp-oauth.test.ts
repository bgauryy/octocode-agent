import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';

import {
  createNativeMcpOAuthFlow,
  createNativeOsCredentialStore,
  openNativeApprovedOAuthUrl,
  nativeMcpOAuthAccount,
  nativeMcpOAuthCredentialStatus,
  revokeNativeMcpOAuthCredential,
  type NativeCredentialStorePort,
  type NativeMcpOAuthStoredCredential,
} from '../src/native-mcp-oauth.js';
import { loadNativeMcpServers, registerNativeMcpTool } from '../src/native-mcp.js';

class MemoryCredentialStore implements NativeCredentialStorePort {
  readonly values = new Map<string, string>();
  async read(account: string): Promise<string | undefined> { return this.values.get(account); }
  async write(account: string, value: string): Promise<void> { this.values.set(account, value); }
  async delete(account: string): Promise<void> { this.values.delete(account); }
}

const flows: Array<{ close(): Promise<void> }> = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(flows.splice(0).map((flow) => flow.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function get(url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { host: url.host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once('error', reject);
  });
}

describe('native MCP OAuth flow', () => {
  it('uses argv-safe OS credential commands and fails closed on unsupported hosts', async () => {
    const calls: Array<{ command: string; args: readonly string[]; stdin?: string }> = [];
    const runner = { run: vi.fn(async (command: string, args: readonly string[], stdin?: string) => {
      calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
      return { exitCode: 0, stdout: command === 'security' && args[0] === 'find-generic-password' ? 'stored-value\n' : '', stderr: '' };
    }) };
    const store = createNativeOsCredentialStore({ platform: 'darwin', runner, service: 'test-service' });
    expect(await store.read('account')).toBe('stored-value');
    await store.write('account', 'secret-value');
    await store.delete('account');
    expect(calls).toEqual([
      { command: 'security', args: ['find-generic-password', '-s', 'test-service', '-a', 'account', '-w'] },
      { command: 'security', args: ['add-generic-password', '-U', '-s', 'test-service', '-a', 'account', '-w', 'secret-value'] },
      { command: 'security', args: ['delete-generic-password', '-s', 'test-service', '-a', 'account'] },
    ]);
    await expect(createNativeOsCredentialStore({ platform: 'win32', runner }).read('account')).rejects.toThrow(/unavailable/i);
  });

  it('opens only HTTPS or loopback HTTP authorization URLs without a shell', async () => {
    const launch = vi.fn(async () => true);
    expect(await openNativeApprovedOAuthUrl('https://login.example.com/auth?state=x', { platform: 'linux', launch }))
      .toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith('xdg-open', ['https://login.example.com/auth?state=x']);
    expect(await openNativeApprovedOAuthUrl('http://login.example.com/auth', { platform: 'linux', launch }))
      .toEqual({ ok: false });
    expect(await openNativeApprovedOAuthUrl('file:///tmp/secret', { platform: 'linux', launch }))
      .toEqual({ ok: false });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('loads OAuth only for HTTP servers without competing authorization credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-mcp-oauth-config-'));
    roots.push(root);
    const octocodeHome = path.join(root, 'octocode-home');
    const file = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
      oauth: { url: 'https://example.com/mcp', oauth: true },
      conflict: { url: 'https://example.com/mcp', oauth: true, bearerTokenEnvVar: 'TOKEN' },
      stdio: { command: 'server', oauth: true },
    } }));
    const loaded = loadNativeMcpServers({ cwd: root, octocodeHome, homeDir: root, env: {} });
    expect(loaded.oauth).toMatchObject({ transport: 'http', oauth: true });
    expect(loaded).not.toHaveProperty('conflict');
    expect(loaded).not.toHaveProperty('stdio');
  });

  it('exposes redacted status and approval-gated revoke actions through MCPTool', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-mcp-oauth-actions-'));
    roots.push(root);
    const octocodeHome = path.join(root, 'octocode-home');
    const file = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp', oauth: true } } }));
    const store = new MemoryCredentialStore();
    const flow = await createNativeMcpOAuthFlow({
      serverName: 'docs', serverUrl: 'https://example.com/mcp', credentialStore: store,
      approve: async () => false, openApprovedUrl: async () => ({ ok: false }),
    });
    flows.push(flow);
    await flow.provider.saveTokens({ access_token: 'private-token', token_type: 'bearer' });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, {
      cwd: root, octocodeHome, homeDir: root, env: {},
      oauth: {
        createFlow: vi.fn(),
        status: ({ serverName, serverUrl }) => nativeMcpOAuthCredentialStatus({ serverName, serverUrl, credentialStore: store }),
        revoke: ({ serverName, serverUrl }) => revokeNativeMcpOAuthCredential({ serverName, serverUrl, credentialStore: store }),
      },
    });
    const tool = registry.get('MCPTool')!;
    const run = (input: unknown) => tool.execute({ input, signal: new AbortController().signal, update: async () => undefined } as never);
    const status = await run({ action: 'auth-status', server: 'docs' });
    expect(status.content).toEqual({ server: 'docs', state: 'connected', credentialConfigured: true });
    expect(JSON.stringify(status)).not.toContain('private-token');
    expect(tool.policy.resolve?.({ action: 'auth-revoke', server: 'docs' })).toMatchObject({ approval: 'always' });
    expect((await run({ action: 'auth-revoke', server: 'docs' })).content).toEqual({
      server: 'docs', state: 'authorization-required', credentialConfigured: false,
    });
  });

  it('binds credential identity to the canonical server origin', () => {
    expect(nativeMcpOAuthAccount('docs', 'https://EXAMPLE.com:443/mcp?secret=x#fragment'))
      .toBe(nativeMcpOAuthAccount('docs', 'https://example.com/other'));
    expect(nativeMcpOAuthAccount('other', 'https://example.com/mcp'))
      .not.toBe(nativeMcpOAuthAccount('docs', 'https://example.com/mcp'));
  });

  it('validates callback state, finishes PKCE auth, and never exposes stored secrets', async () => {
    const store = new MemoryCredentialStore();
    const opened: string[] = [];
    const finishAuth = vi.fn(async () => undefined);
    const flow = await createNativeMcpOAuthFlow({
      serverName: 'docs',
      serverUrl: 'https://example.com/mcp',
      credentialStore: store,
      approve: async () => true,
      openApprovedUrl: async (url) => { opened.push(url); return { ok: true }; },
    });
    flows.push(flow);
    flow.attachTransport({ finishAuth });

    const authorization = new URL('https://login.example.com/authorize?state=sdk-state');
    await flow.provider.saveCodeVerifier('verifier-secret');
    await flow.provider.saveTokens({ access_token: 'access-secret', token_type: 'bearer' });
    const redirect = flow.provider.redirectToAuthorization(authorization);
    await vi.waitFor(() => expect(opened).toEqual([authorization.href]));

    const wrong = new URL(flow.redirectUrl);
    wrong.searchParams.set('code', 'code-secret');
    wrong.searchParams.set('state', 'wrong-state');
    expect((await get(wrong)).status).toBe(400);
    expect(finishAuth).not.toHaveBeenCalled();

    const callback = new URL(flow.redirectUrl);
    callback.searchParams.set('code', 'code-secret');
    callback.searchParams.set('state', 'sdk-state');
    expect((await get(callback)).status).toBe(200);
    await redirect;
    expect(finishAuth).toHaveBeenCalledTimes(1);

    const status = await flow.status();
    expect(status).toEqual({ state: 'connected', credentialConfigured: true });
    expect(JSON.stringify(status)).not.toMatch(/access-secret|verifier-secret|code-secret/);
  });

  it('persists discovery state and revokes all credential material', async () => {
    const store = new MemoryCredentialStore();
    const flow = await createNativeMcpOAuthFlow({
      serverName: 'docs', serverUrl: 'https://example.com/mcp', credentialStore: store,
      approve: async () => false, openApprovedUrl: async () => ({ ok: false }),
    });
    flows.push(flow);
    const discovery = { authorizationServerUrl: 'https://login.example.com', resourceUrl: 'https://example.com/mcp' } as never;
    await flow.provider.saveDiscoveryState?.(discovery);
    expect(await flow.provider.discoveryState?.()).toEqual(discovery);
    await flow.provider.saveTokens({ access_token: 'secret', token_type: 'bearer' });
    await flow.revoke();
    expect(await flow.provider.tokens()).toBeUndefined();
    expect(await flow.provider.discoveryState?.()).toBeUndefined();
    expect(await flow.status()).toEqual({ state: 'authorization-required', credentialConfigured: false });
  });

  it('rejects authorization when no interactive approval is available', async () => {
    const flow = await createNativeMcpOAuthFlow({
      serverName: 'docs', serverUrl: 'https://example.com/mcp', credentialStore: new MemoryCredentialStore(),
      approve: async () => false, openApprovedUrl: async () => ({ ok: true }),
    });
    flows.push(flow);
    await expect(flow.provider.redirectToAuthorization(new URL('https://login.example.com/auth?state=x')))
      .rejects.toThrow(/denied/i);
  });

  it('fails closed on malformed credential-store records', async () => {
    const store = new MemoryCredentialStore();
    store.values.set(nativeMcpOAuthAccount('docs', 'https://example.com/mcp'), '{"tokens":{"access_token":42}}');
    const flow = await createNativeMcpOAuthFlow({
      serverName: 'docs', serverUrl: 'https://example.com/mcp', credentialStore: store,
      approve: async () => false, openApprovedUrl: async () => ({ ok: false }),
    });
    flows.push(flow);
    expect(await flow.provider.tokens()).toBeUndefined();
    expect(await flow.status()).toEqual({ state: 'authorization-required', credentialConfigured: false });
  });
});

// Compile-time ownership receipt: persisted records remain an adapter concern.
void (undefined as unknown as NativeMcpOAuthStoredCredential);
