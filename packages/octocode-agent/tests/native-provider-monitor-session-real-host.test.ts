import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSettingsStorage } from '../src/native-settings.js';

const roots: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, '..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-real-host-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function isolatedProcessEnvironment(
  home: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    HOME: home,
    USERPROFILE: home,
    OCTOCODE_HOME: home,
    ...overrides,
  };
}

async function rpc(
  home: string,
  commands: readonly Record<string, unknown>[],
  args: readonly string[] = ['--mode', 'rpc'],
): Promise<{ code: number | null; stdout: string; stderr: string; lines: Record<string, unknown>[] }> {
  const child = spawn(process.execPath, [builtCli, ...args], {
    cwd: packageRoot,
    env: isolatedProcessEnvironment(home, {
      OPENAI_API_KEY: 'fixture-key-must-stay-redacted',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${commands.map((command) => JSON.stringify(command)).join('\n')}\n`);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return {
    code,
    stdout,
    stderr,
    lines: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function request(requestId: string, command: Record<string, unknown>): Record<string, unknown> {
  return { protocolVersion: 1, requestId, command };
}

describe('built native provider, monitoring, and session resilience', () => {
  it('isolates both POSIX and Windows home variables for every real-host child', () => {
    const home = isolatedHome();
    expect(isolatedProcessEnvironment(home)).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      OCTOCODE_HOME: home,
    });
  });

  it.each([
    ['openai-chat-completions', '/chat/completions'],
    ['openai-responses', '/responses'],
    ['anthropic-messages', '/messages'],
  ] as const)('uses the selected %s adapter against a loopback custom vendor', async (protocol, expectedPath) => {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (protocol === 'openai-chat-completions') {
        response.end('data: {"choices":[{"delta":{"content":"fixture-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else if (protocol === 'openai-responses') {
        response.end('data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp-1","created_at":1,"output_text":"fixture-ok","error":null,"incomplete_details":null,"instructions":null,"metadata":null,"model":"fixture-model","object":"response","output":[{"id":"msg-1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"fixture-ok","annotations":[]}]}],"parallel_tool_calls":true,"temperature":null,"tool_choice":"auto","tools":[],"top_p":null,"status":"completed","usage":{"input_tokens":2,"input_tokens_details":{"cached_tokens":1},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":3}}}\n\ndata: [DONE]\n\n');
      } else {
        response.end([
          'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":1}}}', '',
          'event: content_block_start', 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', '',
          'event: content_block_delta', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fixture-ok"}}', '',
          'event: message_delta', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}', '',
          'event: message_stop', 'data: {"type":"message_stop"}', '', '',
        ].join('\n'));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('loopback server address unavailable');
    const home = isolatedHome();
    const agentDir = path.join(home, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: protocol === 'openai-chat-completions' ? 'openai-completions' : protocol,
          apiKey: '$OCTOCODE_MODEL_API_KEY',
          models: [{ id: 'fixture-model' }],
        },
      },
    }));
    new FileSettingsStorage(path.join(agentDir, 'settings.json')).commit('0', {
      defaultProvider: 'fixture', defaultModel: 'fixture-model',
    });
    const child = spawn(process.execPath, [builtCli, '--mode', 'json', '--no-session', 'hello fixture'], {
      cwd: packageRoot,
      env: isolatedProcessEnvironment(home, {
        OCTOCODE_MODEL_API_KEY: 'loopback-key-must-stay-redacted',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    server.close();
    await once(server, 'close');

    expect(code, `stderr=${stderr} stdout=${stdout}`).toBe(0);
    expect(stderr).toBe('');
    expect(requests).toContain(`/v1${expectedPath}`);
    const output = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'provider.response-received',
        payload: expect.objectContaining({
          stop: 'complete',
          usage: expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) }),
        }),
      }),
    }));
    expect(output).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'context.artifacts-projected',
        payload: expect.objectContaining({
          phase: 'initial',
          sourceCount: expect.any(Number),
          projectedCount: expect.any(Number),
          droppedCount: expect.any(Number),
          stablePrefixDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    }));
    expect(`${stdout}${stderr}`).not.toMatch(/loopback-key-must-stay-redacted/);
  });

  it('reports exact bounded cache metrics and enforces provider switching at the session boundary', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const home = isolatedHome();
    const result = await rpc(home, [
      request('same-provider', { type: 'model.select', providerId: 'openai', modelId: 'gpt-5' }),
      request('cross-provider', { type: 'model.select', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }),
      request('monitoring', { type: 'monitoring.snapshot' }),
    ], ['--mode', 'rpc', '--no-session']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'same-provider', ok: true }),
      expect.objectContaining({
        requestId: 'cross-provider', ok: false,
        error: expect.objectContaining({ category: 'unsupported-capability', message: expect.stringMatching(/new session/i) }),
      }),
      expect.objectContaining({
        requestId: 'monitoring', ok: true,
        data: expect.objectContaining({
          schemaVersion: 1,
          native: expect.objectContaining({
            cache: expect.objectContaining({
              hits: expect.any(Number), misses: expect.any(Number), loads: expect.any(Number),
              loadFailures: expect.any(Number), expirations: expect.any(Number), evictions: expect.any(Number),
              entries: expect.any(Number), maxEntries: 32, ttlMs: 60_000,
            }),
          }),
        }),
      }),
    ]));
    expect(`${result.stdout}${result.stderr}`).not.toContain('fixture-key-must-stay-redacted');
  });

  it('uses packaged Rust persistence and resumes the session across processes without legacy file locks', async () => {
    const home = isolatedHome();
    const id = 'real-host-lock-session';
    const created = await rpc(home, [request('create', { type: 'session.create', id })]);
    expect(created.code).toBe(0);
    expect(created.lines).toContainEqual(expect.objectContaining({ requestId: 'create', ok: true }));

    const sessions = path.join(home, 'agent', 'sessions');
    expect(fs.existsSync(sessions)).toBe(false);
    expect(fs.existsSync(path.join(home, 'agent', 'core.sqlite3'))).toBe(true);

    const resumed = await rpc(home, [request('snapshot', { type: 'runtime.snapshot' })], ['--mode', 'rpc', '--session', id]);
    expect(resumed.code).toBe(0);
    expect(resumed.lines).toContainEqual(expect.objectContaining({
      requestId: 'snapshot', ok: true,
      data: expect.objectContaining({ sessionId: id }),
    }));
    expect(`${resumed.stdout}${resumed.stderr}`).not.toContain('fixture-key-must-stay-redacted');
  }, 15_000);
});
