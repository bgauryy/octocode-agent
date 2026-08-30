import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeNativeToolRegistry, createDefaultOctocodeToolRegistry } from '../src/native-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const execution = (input: unknown, cwd: string) => ({
  input,
  callId: 'call:1' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal,
  update: async () => undefined,
});

describe('native tool registry lifecycle', () => {
  it('retains and idempotently closes the MCP manager owned by a default registry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-lifecycle-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
    const registry = await createDefaultOctocodeToolRegistry({
      cwd: root,
      env: { ...process.env, OCTOCODE_HOME: path.join(root, 'home') },
      run: async () => JSON.stringify({ tools: [] }),
    });

    await closeNativeToolRegistry(registry);
    await expect(closeNativeToolRegistry(registry)).resolves.toBeUndefined();
    await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root)))
      .rejects.toThrow('MCP session manager is closed');
  });
});
