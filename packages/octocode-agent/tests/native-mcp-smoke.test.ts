import { describe, expect, it, vi } from 'vitest';

import { runNativeMcpSmokeMatrix } from '../src/native-mcp-smoke.js';
import type { NativeMcpClient } from '../src/native-mcp.js';

function client(result: unknown = { tools: [{ name: 'search' }] }): NativeMcpClient {
  return {
    listTools: vi.fn(async () => result as never), callTool: vi.fn(), listResources: vi.fn(), readResource: vi.fn(),
    listPrompts: vi.fn(), getPrompt: vi.fn(), complete: vi.fn(), request: vi.fn(), close: vi.fn(async () => undefined),
  };
}

describe('native MCP transport smoke matrix', () => {
  it('proves HTTP static and OAuth transports through the negotiated catalog', async () => {
    const staticClient = client();
    const oauthClient = client({ tools: [{ name: 'fetch' }, { name: 'search' }] });
    const result = await runNativeMcpSmokeMatrix([
      {
        name: 'static', auth: 'static', credentialConfigured: true,
        config: { transport: 'http', url: 'https://static.example/mcp', bearerTokenEnvVar: 'TOKEN' },
        options: { cwd: '/workspace', env: { TOKEN: 'secret' } }, connect: vi.fn(async () => staticClient),
      },
      {
        name: 'oauth', auth: 'oauth', credentialConfigured: true,
        config: { transport: 'http', url: 'https://oauth.example/mcp', oauth: true },
        options: { cwd: '/workspace' }, connect: vi.fn(async () => oauthClient),
      },
    ]);
    expect(result.status).toBe('PASS');
    expect(result.results).toEqual([
      { status: 'PASS', name: 'static', transport: 'http', auth: 'static', toolCount: 1 },
      { status: 'PASS', name: 'oauth', transport: 'http', auth: 'oauth', toolCount: 2 },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(staticClient.close).toHaveBeenCalledOnce();
    expect(oauthClient.close).toHaveBeenCalledOnce();
  });

  it('reports credential-dependent gates as SKIP instead of fabricated success', async () => {
    const result = await runNativeMcpSmokeMatrix([{
      name: 'oauth', auth: 'oauth', credentialConfigured: false,
      config: { transport: 'http', url: 'https://oauth.example/mcp', oauth: true }, options: { cwd: '/workspace' },
      connect: vi.fn(async () => client()),
    }]);
    expect(result).toEqual({
      status: 'SKIP',
      results: [{ status: 'SKIP', name: 'oauth', transport: 'http', auth: 'oauth', capability: 'credentials-absent' }],
      credentialDependent: ['oauth'],
    });
  });

  it('normalizes connection failures without returning remote secret-bearing errors', async () => {
    const result = await runNativeMcpSmokeMatrix([{
      name: 'static', auth: 'static', credentialConfigured: true,
      config: { transport: 'http', url: 'https://static.example/mcp' }, options: { cwd: '/workspace' },
      connect: vi.fn(async () => { throw new Error('Bearer secret-value unauthorized'); }),
    }]);
    expect(result.results).toEqual([{ status: 'FAIL', name: 'static', transport: 'http', auth: 'static', reason: 'connection-failed' }]);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});
