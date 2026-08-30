import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createEffectSet } from '@octocodeai/agent-core';
import { discoverNativeFilesystemExtensions } from '../src/native-extension-adapters.js';
import { FileSettingsStorage } from '../src/native-settings.js';
import { nativeEffectAllowed } from '../src/native-launcher.js';

const roots: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, '..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function responseFixture(output: unknown[], usage = { input_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 }) {
  return { id: 'resp-fixture', created_at: 1, output_text: '', error: null, incomplete_details: null, instructions: null, metadata: null, model: 'fixture-model', object: 'response', output, parallel_tool_calls: true, temperature: null, tool_choice: 'auto', tools: [], top_p: null, status: 'completed', usage };
}

async function runFixture(disabled: boolean, approved = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-mcp-real-host-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const log = path.join(root, 'mcp.log');
  fs.mkdirSync(workspace, { recursive: true });
  let reviewedHashes: Record<string, string> = {};
  if (approved) {
    const approvalFile = path.join(workspace, 'approve-mcp.mjs');
    fs.writeFileSync(approvalFile, `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));`);
    const hooksFile = path.join(workspace, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {
      PermissionRequest: [{ matcher: '^MCPTool$', hooks: [{ type: 'command', command: `${process.execPath} ${approvalFile}`, timeout: 2 }] }],
    } }));
    const discovered = await discoverNativeFilesystemExtensions({ home, workspace, workspaceTrusted: true });
    reviewedHashes = Object.fromEntries(discovered.hooks.map(({ source }) => [source.id, source.normalizedHash]));
  }
  new FileSettingsStorage(path.join(home, 'agent', 'settings.json')).commit('0', {
    defaultProvider: 'fixture',
    defaultModel: 'fixture-model',
    workspaceTrust: { [workspace]: 'trusted' },
    nativeExtensions: {
      reviewedHashes,
      pluginGrants: {},
    },
  });
  const serverFile = path.join(workspace, 'fixture-server.mjs');
  const mcpServerModule = import.meta.resolve('@modelcontextprotocol/server');
  const mcpStdioModule = import.meta.resolve('@modelcontextprotocol/server/stdio');
  const zodModule = import.meta.resolve('zod');
  fs.writeFileSync(serverFile, `
    import fs from 'node:fs';
    import { McpServer } from ${JSON.stringify(mcpServerModule)};
    import { StdioServerTransport } from ${JSON.stringify(mcpStdioModule)};
    import { z } from ${JSON.stringify(zodModule)};
    const log = (line) => fs.appendFileSync(process.env.MCP_FIXTURE_LOG, line + '\\n');
    log('started:' + process.pid);
    process.on('exit', () => log('closed'));
    const server = new McpServer({ name: 'real-host-fixture', version: '1.0.0' });
    server.registerTool('probe', {
      description: 'Deterministic probe',
      inputSchema: z.object({ message: z.string() }),
    }, async ({ message }, ctx) => {
      log('call:' + message);
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        log('progress');
        await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 1, message: 'fixture-progress' } });
        await ctx.mcpReq.send({ method: 'ping' });
        log('progress-flushed');
      }
      return { content: [{ type: 'text', text: 'mcp-result:' + message }] };
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const dispatch = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (message?.method === 'tools/list') log('list');
      return dispatch?.(message, extra);
    };
  `);
  const config = path.join(home, 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const fixtureServer = {
    command: process.execPath,
    args: [serverFile],
    env: { MCP_FIXTURE_LOG: log },
    timeoutMs: 5_000,
    ...(disabled ? { disabled: true } : {}),
  };
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: fixtureServer } }));

  let modelRequests = 0;
  let observedToolResult = false;
  const modelInputs: unknown[][] = [];
  const model = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as { input?: unknown[] };
    modelInputs.push(parsed.input ?? []);
    modelRequests += 1;
    observedToolResult ||= JSON.stringify(parsed.input ?? []).includes(
      disabled ? 'Unknown or disabled MCP server' : approved ? 'mcp-result:hello' : 'Tool approval was denied',
    );
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (modelRequests === 1) {
      const args = JSON.stringify({ action: 'call', server: 'fixture', tool: 'probe', arguments: { message: 'hello' } });
      const item = { type: 'function_call', id: 'item-mcp', call_id: 'call-mcp', name: 'MCPTool', arguments: args, status: 'completed' };
      response.end(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: args, item_id: 'item-mcp', output_index: 0, sequence_number: 1 })}\n\ndata: ${JSON.stringify({ type: 'response.output_item.done', item, output_index: 0, sequence_number: 2 })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 3 })}\n\ndata: [DONE]\n\n`);
    } else {
      const message = { id: 'msg-final', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: disabled ? 'disabled-final' : 'enabled-final', annotations: [] }] };
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([message]), sequence_number: 1 })}\n\ndata: [DONE]\n\n`);
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  if (address === null || typeof address === 'string') throw new Error('model fixture address unavailable');
  fs.writeFileSync(path.join(home, 'agent', 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-responses',
        apiKey: '$OCTOCODE_MODEL_API_KEY',
        models: [{ id: 'fixture-model' }],
      },
    },
  }));
  const child = spawn(process.execPath, [builtCli, '--mode', 'json', '--no-session', 'call the MCP probe'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH, HOME: home, OCTOCODE_HOME: home,
      OCTOCODE_MODEL_API_KEY: 'model-secret-must-stay-private',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  model.close();
  await once(model, 'close');
  const configured = JSON.parse(fs.readFileSync(config, 'utf8')) as {
    mcpServers?: { fixture?: { env?: { MCP_FIXTURE_LOG?: string } } };
  };
  return {
    code, stdout, stderr, modelRequests, observedToolResult, modelInputs,
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    spawnMarkerConfigured: configured.mcpServers?.fixture?.env?.MCP_FIXTURE_LOG === log,
  };
}

describe('built native MCP execution', () => {
  it('discovers, calls, observes, and closes a real stdio MCP server', async () => {
    const result = await runFixture(false);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.modelRequests).toBe(2);
    expect(result.log).toMatch(/started:\d+\nlist\ncall:hello\nprogress\nprogress-flushed\nclosed\n/);
    expect(result.observedToolResult, JSON.stringify(result.modelInputs)).toBe(true);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: 'tool.requested', payload: expect.objectContaining({ callId: 'call-mcp', name: 'MCPTool' }) }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'permission.requested', payload: expect.objectContaining({ callId: 'call-mcp', name: 'MCPTool' }) }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'tool.updated', payload: expect.objectContaining({ callId: 'call-mcp', name: 'MCPTool' }) }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'tool.ended', payload: expect.objectContaining({ callId: 'call-mcp', name: 'MCPTool' }) }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'provider.request-started', payload: expect.objectContaining({ iteration: 1 }) }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'agent.ended', payload: expect.objectContaining({ stop: 'complete' }) }) }),
    ]));
    const correlated = lines
      .map((line) => line.event)
      .filter((event) => ['tool.requested', 'permission.requested', 'tool.updated', 'tool.ended'].includes(event.type));
    expect(correlated.map((event) => event.type)).toEqual([
      'tool.requested', 'permission.requested', 'tool.updated', 'tool.ended',
    ]);
    expect(new Set(correlated.map((event) => event.sessionId)).size).toBe(1);
    expect(new Set(correlated.map((event) => event.turnId)).size).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/model-secret-must-stay-private|\u0000/);
  }, 20_000);

  it('fails closed when the configured MCP server is disabled without spawning it', async () => {
    const result = await runFixture(true);
    expect(result.code).toBe(0);
    expect(result.spawnMarkerConfigured).toBe(true);
    expect(result.log).toBe('');
    expect(result.modelRequests).toBe(2);
    expect(result.observedToolResult, JSON.stringify(result.modelInputs)).toBe(true);
    expect(result.stdout).toMatch(/tool\.ended|tool-execution|Unknown MCP server/);
    expect(`${result.stdout}${result.stderr}`).not.toContain('model-secret-must-stay-private');
  }, 20_000);

  it('fails closed without explicit MCP approval and does not spawn the server', async () => {
    const result = await runFixture(false, false);
    expect(result.code).toBe(0);
    expect(result.log).toBe('');
    expect(result.modelRequests).toBe(2);
    expect(result.observedToolResult, JSON.stringify(result.modelInputs)).toBe(true);
  }, 20_000);

  it('does not broaden the native write boundary to arbitrary operations', () => {
    expect(nativeEffectAllowed({ effects: createEffectSet('network', 'process', 'write'), operation: 'tool:MCPTool' })).toBe(true);
    expect(nativeEffectAllowed({ effects: createEffectSet('write'), operation: 'tool:destructive' })).toBe(false);
    expect(nativeEffectAllowed({ effects: createEffectSet('process', 'write'), operation: 'tool:worker' })).toBe(false);
  });
});
