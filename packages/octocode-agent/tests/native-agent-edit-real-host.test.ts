import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSettingsStorage } from '../src/native-settings.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');
const rustFileSystem = path.join(
  repositoryRoot,
  'packages/octocode-agent-core-rust/target/release/octocode-agent-fs',
);

function responseFixture(output: unknown[]) {
  return {
    id: 'resp-edit-fixture',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'fixture-model',
    object: 'response',
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  };
}

describe('built native agent editing', () => {
  it('solves an editing task through the production model, policy, Rust filesystem, and file tool path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-agent-edit-real-host-'));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    try {
      new FileSettingsStorage(path.join(home, 'agent', 'settings.json')).commit('0', {
        defaultProvider: 'fixture',
        defaultModel: 'fixture-model',
        workspaceTrust: { [workspace]: 'trusted' },
      });
      let requests = 0;
      let observedCommittedWrite = false;
      const model = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        requests += 1;
        observedCommittedWrite ||= JSON.stringify(JSON.parse(body)).includes('previousSha256');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests === 1) {
          const args = JSON.stringify({
            operation: 'write',
            path: 'answer.txt',
            content: 'answer=42\n',
            expectedSha256: null,
          });
          const item = {
            type: 'function_call',
            id: 'item-file',
            call_id: 'call-file',
            name: 'file',
            arguments: args,
            status: 'completed',
          };
          response.end(
            `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: args, item_id: 'item-file', output_index: 0, sequence_number: 1 })}\n\n`
            + `data: ${JSON.stringify({ type: 'response.output_item.done', item, output_index: 0, sequence_number: 2 })}\n\n`
            + `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 3 })}\n\n`
            + 'data: [DONE]\n\n',
          );
          return;
        }
        const message = {
          id: 'msg-final',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Created answer.txt with the computed result.', annotations: [] }],
        };
        response.end(
          `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([message]), sequence_number: 1 })}\n\n`
          + 'data: [DONE]\n\n',
        );
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

      const child = spawn(process.execPath, [
        builtCli,
        '--mode', 'json',
        '--no-session',
        '--permissions', 'allow-all',
        'Compute six times seven and write answer.txt as answer=<result>.',
      ], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OCTOCODE_HOME: home,
          OCTOCODE_MODEL_API_KEY: 'fixture-secret',
          OCTOCODE_AGENT_RUST_FS_BIN: rustFileSystem,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
      model.close();
      await once(model, 'close');

      expect(code, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(requests).toBe(2);
      expect(observedCommittedWrite).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'answer.txt'), 'utf8')).toBe('answer=42\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
