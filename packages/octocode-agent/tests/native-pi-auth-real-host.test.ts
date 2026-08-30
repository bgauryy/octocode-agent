import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const builtCli = path.resolve(import.meta.dirname, '../out/octocode-agent.mjs');

describe('built native Pi credential bridge', () => {
  it('uses the stored Pi api_key through a resolved provider alias without external key variables', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-auth-live-'));
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const workspace = path.join(root, 'workspace');
    const piAgent = path.join(home, '.pi', 'agent');
    const secret = 'pi-auth-secret-must-stay-redacted';
    fs.mkdirSync(piAgent, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    let authorization = '';
    let requestedModel = '';
    const server = http.createServer(async (request, response) => {
      authorization = String(request.headers.authorization ?? '');
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requestedModel = (JSON.parse(body) as { model?: string }).model ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"PI_AUTH_BRIDGE_OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('loopback address unavailable');

    fs.writeFileSync(path.join(piAgent, 'models.json'), JSON.stringify({
      providers: {
        'loopback-x': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: 'models-key-must-not-win',
          models: [{ id: 'loopback-model' }],
        },
      },
    }));
    fs.writeFileSync(path.join(piAgent, 'settings.json'), JSON.stringify({
      defaultProvider: 'loopback', defaultModel: 'loopback-model',
    }));
    fs.writeFileSync(path.join(piAgent, 'auth.json'), JSON.stringify({
      loopback: { type: 'api_key', key: secret },
    }));

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OCTOCODE_HOME: octocodeHome };
    for (const name of ['OCTOCODE_MODEL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[name];
    const child = spawn(process.execPath, [builtCli, 'run', '--no-session', 'answer once'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    server.close();
    await once(server, 'close');

    expect(code, stderr).toBe(0);
    expect(stdout).toContain('PI_AUTH_BRIDGE_OK');
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(requestedModel).toBe('loopback-model');
    expect(`${stdout}${stderr}`).not.toMatch(/pi-auth-secret-must-stay-redacted|models-key-must-not-win/);
  }, 20_000);
});
