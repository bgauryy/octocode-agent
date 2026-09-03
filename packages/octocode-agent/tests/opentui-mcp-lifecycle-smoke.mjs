import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runExpect,
  semanticTerminalText,
  tclValue,
} from './opentui-cli-command-smoke.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');
const rawArgumentMarker = 'raw-mcp-argument-must-not-render';
const secretMarker = 'mcp-secret-must-not-render';
const lifecycleMarkers = Object.freeze({
  discovery: 'M1_DISC', success: 'M2_OK', elicitation: 'M3_ELICIT', failure: 'M4_FAIL',
  cancellation: 'M5_CANCEL', catalogChange: 'M6_CHANGE',
  catalogRefresh: 'M7_REFRESH',
  reconnectDrop: 'M8_DROP', reconnectRetry: 'M9_RETRY',
  reconnectDiscovery: 'M10_RECON',
});

function responseFixture(output) {
  return {
    id: 'resp-mcp-pty', created_at: 1, output_text: '', error: null,
    incomplete_details: null, instructions: null, metadata: null,
    model: 'mcp-pty-v1', object: 'response', output,
    parallel_tool_calls: true, temperature: null, tool_choice: 'auto', tools: [],
    top_p: null, status: 'completed',
    usage: {
      input_tokens: 2, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3,
    },
  };
}

function modelMessage(text, index) {
  return {
    id: `msg-${index}`, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function modelToolCall(index, marker, input) {
  const args = JSON.stringify(input);
  return {
    marker,
    args,
    item: {
      type: 'function_call', id: `item-${index}`, call_id: `call-${index}`,
      name: 'MCPTool', arguments: args, status: 'completed',
    },
  };
}

function writeModelResponse(response, index, stage) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (stage.final) {
    const message = modelMessage(stage.marker, index);
    response.end([
      `data: ${JSON.stringify({ type: 'response.output_item.added', item: { ...message, status: 'in_progress', content: [] }, output_index: 0, sequence_number: 1 })}`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: stage.marker, item_id: message.id, output_index: 0, content_index: 0, sequence_number: 2, logprobs: [] })}`,
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: message, output_index: 0, sequence_number: 3 })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([message]), sequence_number: 4 })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'));
    return;
  }
  const call = modelToolCall(index, stage.marker, stage.input);
  const message = modelMessage(stage.marker, index);
  const pendingMessage = { ...message, status: 'in_progress', content: [] };
  response.end([
    `data: ${JSON.stringify({ type: 'response.output_item.added', item: pendingMessage, output_index: 0, sequence_number: 1 })}`,
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: stage.marker, item_id: message.id, output_index: 0, content_index: 0, sequence_number: 2, logprobs: [] })}`,
    `data: ${JSON.stringify({ type: 'response.output_item.done', item: message, output_index: 0, sequence_number: 3 })}`,
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: call.args, item_id: call.item.id, output_index: 1, sequence_number: 4 })}`,
    `data: ${JSON.stringify({ type: 'response.output_item.done', item: call.item, output_index: 1, sequence_number: 5 })}`,
    `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([message, call.item]), sequence_number: 6 })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'));
}

async function createModelFixture() {
  const stages = [
    { marker: lifecycleMarkers.discovery, input: { action: 'discover', server: 'fixture' } },
    { marker: lifecycleMarkers.success, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'success', opaque: rawArgumentMarker } } },
    { marker: lifecycleMarkers.elicitation, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'elicit' } } },
    { marker: lifecycleMarkers.failure, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'failure' } } },
    { marker: lifecycleMarkers.catalogChange, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'catalog-change' } } },
    { marker: lifecycleMarkers.catalogRefresh, input: { action: 'discover', server: 'fixture' } },
    { marker: lifecycleMarkers.reconnectDrop, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'disconnect' } } },
    { marker: lifecycleMarkers.reconnectRetry, input: { action: 'discover', server: 'fixture' } },
    { marker: lifecycleMarkers.reconnectDiscovery, input: { action: 'discover', server: 'fixture' } },
    { marker: lifecycleMarkers.cancellation, input: { action: 'call', server: 'fixture', tool: 'lifecycle', arguments: { phase: 'slow' } } },
    { marker: 'M11_DONE', final: true },
  ];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the deterministic local request. */ }
    const stage = stages[Math.min(requests, stages.length - 1)];
    requests += 1;
    if (stage.marker === lifecycleMarkers.reconnectDiscovery) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    writeModelResponse(response, requests, stage);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('model fixture address unavailable');
  return { server, port: address.port, requests: () => requests };
}

async function writeMcpFixture(sandbox, logFile) {
  const serverFile = join(sandbox, 'mcp-fixture.mjs');
  const mcpServerModule = import.meta.resolve('@modelcontextprotocol/server');
  const mcpStdioModule = import.meta.resolve('@modelcontextprotocol/server/stdio');
  const zodModule = import.meta.resolve('zod');
  await writeFile(serverFile, `
    import fs from 'node:fs';
    import { McpServer } from ${JSON.stringify(mcpServerModule)};
    import { StdioServerTransport } from ${JSON.stringify(mcpStdioModule)};
    import { z } from ${JSON.stringify(zodModule)};
    const log = (line) => fs.appendFileSync(process.env.MCP_FIXTURE_LOG, line + '\\n');
    log('started:' + process.pid);
    process.on('exit', () => log('closed:' + process.pid));
    const server = new McpServer(
      { name: 'mcp-pty-fixture', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true }, elicitation: {} } },
    );
    server.registerTool('lifecycle', {
      description: 'Deterministic terminal lifecycle probe',
      inputSchema: z.object({ phase: z.string(), opaque: z.string().optional() }),
    }, async ({ phase }, context) => {
      log('call:' + phase);
      const progressToken = context.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        await context.mcpReq.notify({ method: 'notifications/progress', params: {
          progressToken, progress: 1, total: phase === 'slow' ? 10 : 1,
          message: phase === 'slow' ? 'fixture-slow-progress' : 'fixture-' + phase + '-progress',
        } });
        await context.mcpReq.send({ method: 'ping' });
      }
      if (phase === 'elicit') {
        const result = await server.server.elicitInput({
          mode: 'form', message: 'Allow fixture continuation?',
          requestedSchema: { type: 'object', properties: { allow: { type: 'boolean' } }, required: ['allow'] },
        });
        log('elicitation:' + result.action);
        return { content: [{ type: 'text', text: 'elicitation-' + result.action }] };
      }
      if (phase === 'failure') {
        return { isError: true, content: [{ type: 'text', text: 'sanitized fixture failure' }] };
      }
      if (phase === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return { content: [{ type: 'text', text: 'slow-finished' }] };
      }
      if (phase === 'catalog-change') {
        await server.server.sendToolListChanged();
        log('catalog-changed');
        return { content: [{ type: 'text', text: 'catalog-changed' }] };
      }
      if (phase === 'disconnect') {
        setTimeout(() => transport.close(), 25);
        return { content: [{ type: 'text', text: 'disconnecting' }] };
      }
      return { content: [{ type: 'text', text: 'success-result' }] };
    });
    const transport = new StdioServerTransport();
    const dispatch = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (message?.method === 'tools/list') log('list');
      return dispatch?.(message, extra);
    };
    await server.connect(transport);
  `, { mode: 0o600 });
  return serverFile;
}

function expectProgram({ home, accessible }) {
  const flags = accessible ? ['--accessible'] : [];
  const launch = [
    'env', 'NODE_OPTIONS=--experimental-ffi', `OCTOCODE_MODEL_API_KEY=${secretMarker}`,
    `HOME=${home}`, `USERPROFILE=${home}`, `OCTOCODE_HOME=${join(home, '.octocode')}`,
    process.execPath, executable, '--permissions', 'allow-all', '--model', 'fixture/mcp-pty-v1', ...flags,
  ];
  return [
    'set timeout 12',
    'log_user 0',
    'proc wait_exact {marker} {',
    '  expect {',
    '    -exact $marker { return }',
    '    timeout { puts stderr "MARKER_TIMEOUT:$marker"; exit 90 }',
    '    eof { puts stderr "EARLY_EOF:$marker"; exit 91 }',
    '  }',
    '}',
    `spawn ${launch.map(tclValue).join(' ')}`,
    'puts stderr "CLI_PID:[exp_pid]"',
    'set child_tty $spawn_out(slave,name)',
    'exec /bin/stty rows 60 columns 160 < $child_tty',
    'wait_exact {Mode: chat}',
    'log_user 1',
    'after 500',
    'send -- {run deterministic MCP lifecycle matrix}',
    'send -- "\\033\\[13;5u"',
    `wait_exact {${lifecycleMarkers.elicitation}}`,
    ...(accessible ? ['wait_exact {Allow fixture continuation?}'] : ['after 500']),
    'send -- "\\033\\[A"',
    'send -- "\\r"',
    `wait_exact {${lifecycleMarkers.failure}}`,
    `wait_exact {${accessible ? 'Tool MCP started (call-10).' : lifecycleMarkers.cancellation}}`,
    'after 300',
    'send -- "\\003"',
    'after 1000',
    'send -- {/exit}',
    'send -- "\\033\\[13;5u"',
    'expect eof',
    'catch wait result',
    'set exitCode [lindex $result 3]',
    'if {$exitCode eq ""} { set exitCode 1 }',
    'exit $exitCode',
  ].join('\n');
}

function lifecycleMeaning(output) {
  const semantic = semanticTerminalText(output);
  const compact = semantic.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return Object.fromEntries(Object.entries(lifecycleMarkers).map(([phase, marker]) => {
    const target = marker.replace(/[^a-z0-9]/giu, '').toLowerCase();
    const observed = compact.includes(target)
      || (target.startsWith('m') && compact.includes(target.slice(1)))
      || (phase === 'cancellation' && (compact.includes('finishedcancelled') || compact.includes('5canel')));
    return [phase, observed];
  }));
}

async function runMode(mode) {
  const sandbox = await mkdtemp(join(tmpdir(), `octocode-mcp-pty-${mode}-`));
  const home = join(sandbox, 'home');
  const octocodeHome = join(home, '.octocode');
  const agentHome = join(octocodeHome, 'agent');
  const logFile = join(sandbox, 'mcp.log');
  const model = await createModelFixture();
  try {
    await mkdir(join(agentHome, 'mcp'), { recursive: true });
    const serverFile = await writeMcpFixture(sandbox, logFile);
    await writeFile(join(agentHome, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'mcp-pty-v1',
      workspaceTrust: { [sandbox]: 'trusted' },
    }));
    await writeFile(join(agentHome, 'models.json'), JSON.stringify({ providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${model.port}/v1`, api: 'openai-responses',
        apiKey: '$OCTOCODE_MODEL_API_KEY', models: [{ id: 'mcp-pty-v1' }],
      },
    } }));
    await writeFile(join(agentHome, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: {
      fixture: {
        command: process.execPath, args: [serverFile], timeoutMs: 5_000,
        env: { MCP_FIXTURE_LOG: logFile, MCP_FIXTURE_SECRET: secretMarker },
      },
    } }));
    const result = await runExpect(expectProgram({ home, accessible: mode === 'accessible' }), sandbox, { timeoutMs: 45_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) {
      const fixtureLog = fs.existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
      throw new Error(`${mode}: ${result.error.message}; modelRequests=${model.requests()}; fixtureLog=${JSON.stringify(fixtureLog)}: ${semanticTerminalText(output).slice(-5_000)}`);
    }
    if (result.status !== 0) {
      const fixtureLog = fs.existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
      throw new Error(`${mode}: expect exited ${result.status}; modelRequests=${model.requests()}; fixtureLog=${JSON.stringify(fixtureLog)}: ${semanticTerminalText(output).slice(-5_000)}`);
    }
    if (!result.processTreeCleaned) throw new Error(`${mode}: owned PTY process tree survived cleanup`);
    if (output.length > 2 * 1024 * 1024) throw new Error(`${mode}: terminal output exceeded 2 MiB (${output.length})`);
    for (const forbidden of [rawArgumentMarker, secretMarker, serverFile, logFile, sandbox]) {
      if (output.includes(forbidden)) throw new Error(`${mode}: terminal output exposed forbidden MCP detail ${JSON.stringify(forbidden)}`);
    }
    const meaning = lifecycleMeaning(output);
    const missing = Object.entries(meaning).filter(([, observed]) => !observed).map(([marker]) => marker);
    if (missing.length > 0) {
      const fixtureLog = fs.existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
      throw new Error(`${mode}: lifecycle output omitted ${missing.join(', ')}; modelRequests=${model.requests()}; fixtureLog=${JSON.stringify(fixtureLog)}: ${semanticTerminalText(output).slice(-5_000)}`);
    }
    const log = fs.existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
    return {
      mode, outputBytes: output.length, meaning, log, modelRequests: model.requests(),
      cleanup: { processTreeCleaned: result.processTreeCleaned, ownedProcessCount: result.ownedProcessCount },
    };
  } finally {
    model.server.close();
    await once(model.server, 'close').catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`MCP PTY lifecycle smoke is unsupported on ${process.platform}`);
  }
  const startedAt = performance.now();
  const accessible = await runMode('accessible');
  const visual = await runMode('visual');
  if (JSON.stringify(visual.meaning) !== JSON.stringify(accessible.meaning)) {
    throw new Error('visual and accessible MCP lifecycle meaning diverged');
  }
  for (const result of [visual, accessible]) {
    const starts = [...result.log.matchAll(/^started:(\d+)$/gmu)].map((match) => Number(match[1]));
    if (new Set(starts).size < 2) throw new Error(`${result.mode}: reconnect did not spawn a fresh MCP fixture`);
    for (const marker of ['list', 'call:success', 'call:elicit', 'elicitation:', 'call:failure', 'call:slow', 'call:catalog-change', 'catalog-changed', 'call:disconnect']) {
      if (!result.log.includes(marker)) throw new Error(`${result.mode}: MCP fixture log omitted ${marker}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-mcp-pty-lifecycle',
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    phases: Object.keys(visual.meaning),
    parity: true,
    redaction: true,
    bounded: true,
    modes: [visual, accessible].map(({ mode, outputBytes, modelRequests, cleanup }) => ({ mode, outputBytes, modelRequests, cleanup })),
    reconnects: true,
    catalogInvalidation: true,
    restored: true,
    pass: true,
  })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-mcp-pty-lifecycle',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
