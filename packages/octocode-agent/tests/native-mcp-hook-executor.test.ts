import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOctocodeDb, openOctocodeDb } from '@octocodeai/agent-contracts/db';
import { setMcpServerEnabled, setMcpToolEnabled } from '@octocodeai/agent-contracts/mcp-state';
import { agentDbPath } from '@octocodeai/agent-contracts/paths';
import { createDefaultOctocodeToolRegistry, createNativeHookMcpExecutor } from '../src/native-tools.js';
import type { NativeMcpClient } from '../src/native-mcp.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-hook-'));
  roots.push(root);
  const env = { ...process.env, OCTOCODE_HOME: path.join(root, 'home') };
  const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
  return { root, env };
}

const catalog = async () =>
  JSON.stringify({
    kind: 'octocode.toolCatalog.full',
    version: 1,
    toolCount: 0,
    tools: [],
  });
const mcpOnly = new Set(['MCPTool']);
const handler = { type: 'mcp_tool' as const, server: 'fixture', tool: 'hook', input: { configured: 'value', hook: 'cannot-override' }, timeoutSeconds: 5, async: false };

describe('registry-owned native MCP hook executor', () => {
  it('shares the MCP registry session and deterministically maps/normalizes/redacts hook calls', async () => {
    const { root, env } = fixture();
    const callTool = vi.fn(async () => ({ structuredContent: { systemMessage: 'context', apiToken: 'secret' } }));
    const client: NativeMcpClient = {
      listTools: async () => ({ tools: [{ name: 'hook', inputSchema: { type: 'object', required: ['configured', 'hook'] } }] }),
      callTool, listResources: async () => ({}), readResource: async () => ({}), listPrompts: async () => ({}),
      getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const connect = vi.fn(async () => client);
    const registry = await createDefaultOctocodeToolRegistry({ cwd: root, env, run: catalog, allowedTools: mcpOnly, mcp: { connect } });
    const executor = createNativeHookMcpExecutor(registry)!;
    const input = { hook_event_name: 'PostToolUse', tool_name: 'edit' };

    const result = await executor.execute(handler, input, new AbortController().signal);
    expect(callTool).toHaveBeenCalledWith({ name: 'hook', arguments: { configured: 'value', hook: input } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toEqual({ decision: { kind: 'context', text: 'context' }, output: { systemMessage: 'context', apiToken: '[REDACTED]' }, stderr: '' });
    await executor.execute(handler, input, new AbortController().signal);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('fails closed for missing and disabled servers/tools', async () => {
    const { root, env } = fixture();
    const client: NativeMcpClient = {
      listTools: async () => ({ tools: [{ name: 'hook', inputSchema: { type: 'object' } }] }), callTool: async () => ({}),
      listResources: async () => ({}), readResource: async () => ({}), listPrompts: async () => ({}), getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const registry = await createDefaultOctocodeToolRegistry({ cwd: root, env, run: catalog, allowedTools: mcpOnly, mcp: { connect: async () => client } });
    const executor = createNativeHookMcpExecutor(registry)!;
    await expect(executor.execute({ ...handler, server: 'missing' }, {}, new AbortController().signal)).rejects.toThrow(/unknown or disabled.*server/i);
    const dbFile = agentDbPath(env);
    const db = openOctocodeDb(dbFile);
    setMcpToolEnabled(db, root, 'fixture', 'hook', false);
    closeOctocodeDb(dbFile);
    await expect(executor.execute(handler, {}, new AbortController().signal)).rejects.toThrow(/unknown or disabled.*tool/i);
    const db2 = openOctocodeDb(dbFile);
    setMcpServerEnabled(db2, root, 'fixture', false);
    closeOctocodeDb(dbFile);
    await expect(executor.execute(handler, {}, new AbortController().signal)).rejects.toThrow(/unknown or disabled.*server/i);
  });

  it('propagates cancellation and normalizes text protocol results', async () => {
    const { root, env } = fixture();
    const client: NativeMcpClient = {
      listTools: async () => ({ tools: [{ name: 'hook', inputSchema: { type: 'object' } }] }),
      callTool: async (_params, options) => {
        if (options?.signal?.aborted) throw new Error('cancelled by signal');
        return { content: [{ type: 'text', text: '{"continue":false,"stopReason":"done"}' }] };
      },
      listResources: async () => ({}), readResource: async () => ({}), listPrompts: async () => ({}), getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const registry = await createDefaultOctocodeToolRegistry({ cwd: root, env, run: catalog, allowedTools: mcpOnly, mcp: { connect: async () => client } });
    const executor = createNativeHookMcpExecutor(registry)!;
    await expect(executor.execute(handler, {}, new AbortController().signal)).resolves.toMatchObject({ decision: { kind: 'stop', reason: 'done' } });
    const cancelled = new AbortController();
    cancelled.abort('test cancellation');
    await expect(executor.execute(handler, {}, cancelled.signal)).rejects.toThrow(/cancel/i);
  });

  it('requires a registry that owns the canonical MCP manager', async () => {
    const { root, env } = fixture();
    const registry = await createDefaultOctocodeToolRegistry({ cwd: root, env, run: catalog, allowedTools: new Set() });
    expect(createNativeHookMcpExecutor(registry)).toBeUndefined();
  });
});
