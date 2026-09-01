import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');
const readinessMarker = 'Active mode, connection, context usage, and canonical keyboard help.';
const footerMarkers = Object.freeze([
  'Terminal footer',
  'Connection state changed to connected.',
  'Context: unavailable',
  'Mode: chat',
]);
const commandCases = Object.freeze([
  { input: '/help', marker: 'commands' },
  { input: '/status', marker: 'KEY VALUE' },
  { input: '/plan show', marker: 'plan.' },
  { input: '/skills', marker: 'Skills' },
  { input: '/tools', marker: 'Tools' },
  { input: '/clear', marker: 'SUCCESS: Context cleared. New session started.' },
  { input: '/compact', marker: 'SUCCESS: Context compacted.' },
  { input: '/thinking low', marker: 'ERROR: /thinking: the configured model adapter does not support thinking controls' },
  { input: 'first loopback prompt', marker: 'FIRST_LOOPBACK_REPLY' },
  { input: 'second loopback followup', marker: 'SECOND_LOOPBACK_REPLY' },
  { input: 'probe.png', marker: 'IMAGE_LOOPBACK_REPLY', paste: true, image: true },
  {
    input: Array.from({ length: 12 }, (_, index) => `paste-line-${String(index + 1).padStart(2, '0')}`).join('\n'),
    marker: 'PASTE_LOOPBACK_REPLY',
    paste: true,
    markerParts: ['[paste #', '+12', 'lines]'],
  },
]);

function tclValue(value) {
  return `{${value.replaceAll('}', '\\}')}}`;
}

function semanticTerminalText(value) {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[ -/]*[0-~]/gu, '');
}

function expectProgram(home) {
  const lines = [
    'set timeout 8',
    'log_user 1',
    'proc wait_exact {marker} {',
    '  expect {',
    '    -exact $marker { return }',
    '    timeout { puts stderr "MARKER_TIMEOUT:$marker"; exit 90 }',
    '    eof { puts stderr "EARLY_EOF:$marker"; exit 91 }',
    '  }',
    '}',
    `spawn env NODE_OPTIONS=--experimental-ffi OCTOCODE_MODEL_API_KEY=test-key ${tclValue(`HOME=${home}`)} ${tclValue(`USERPROFILE=${home}`)} ${tclValue(`OCTOCODE_HOME=${join(home, '.octocode')}`)} ${tclValue(process.execPath)} ${tclValue(executable)} --accessible --model fixture/deterministic-v1`,
    `wait_exact ${tclValue(readinessMarker)}`,
    'wait_exact "\\033\\[?25h"',
  ];
  for (const testCase of commandCases) {
    // A semantic marker can arrive before OpenTUI has restored composer focus.
    // Give the renderer one short event-loop window before the next key chord.
    lines.push('after 150');
    const pasteInput = testCase.input
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n');
    lines.push(testCase.paste
      ? `send -- "\\033\\[200~${pasteInput}\\033\\[201~"`
      : `send -- ${tclValue(testCase.input)}`);
    if (testCase.paste) lines.push(testCase.image ? 'after 300' : 'after 150');
    // Kitty keyboard protocol: Unicode code point 13 with the Ctrl modifier.
    lines.push('send -- "\\033\\[13;5u"');
    lines.push(`wait_exact ${tclValue(testCase.marker)}`);
  }
  lines.push(`send -- ${tclValue('/exit')}`);
  lines.push('send -- "\\033\\[13;5u"');
  lines.push('expect eof');
  lines.push('catch wait result');
  lines.push('set exitCode [lindex $result 3]');
  lines.push('if {$exitCode eq ""} { set exitCode 1 }');
  lines.push('exit $exitCode');
  return lines.join('\n');
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`OpenTUI command PTY smoke is unsupported on ${process.platform}`);
  }
  const sandbox = await mkdtemp(join(tmpdir(), 'octocode-agent-command-'));
  const home = join(sandbox, 'home');
  const fixture = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const text = body.includes('paste-line-12') ? 'PASTE_LOOPBACK_REPLY'
          : body.includes('data:image/png;base64,iVBORw0KGgo=') ? 'IMAGE_LOOPBACK_REPLY'
          : body.includes('second loopback followup') ? 'SECOND_LOOPBACK_REPLY'
          : body.includes('first loopback prompt') ? 'FIRST_LOOPBACK_REPLY'
          : 'COMPACT_LOOPBACK_REPLY';
        const item = { id: 'msg-loopback', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }] };
        const added = { type: 'response.output_item.added', sequence_number: 0, output_index: 0,
          item: { ...item, status: 'in_progress', content: [] } };
        const completed = { type: 'response.completed', sequence_number: 3, response: {
          id: 'resp-loopback', object: 'response', created_at: 1, status: 'completed', error: null,
          incomplete_details: null, instructions: null, metadata: {}, model: 'deterministic-v1',
          output: [item],
          parallel_tool_calls: true, temperature: null, tool_choice: 'auto', tools: [], top_p: null,
          usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 },
        } };
        const delta = { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg-loopback',
          output_index: 0, content_index: 0, delta: text, logprobs: [] };
        const done = { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify(added)
          + '\\n\\ndata: ' + JSON.stringify(delta)
          + '\\n\\ndata: ' + JSON.stringify(done)
          + '\\n\\ndata: ' + JSON.stringify(completed)
          + '\\n\\ndata: [DONE]\\n\\n');
      });
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let fixtureStderr = '';
  fixture.stderr.setEncoding('utf8');
  fixture.stderr.on('data', (chunk) => { fixtureStderr += chunk; });
  const port = await new Promise((resolvePort, rejectPort) => {
    let value = '';
    const timeout = setTimeout(() => rejectPort(new Error(`loopback fixture readiness timed out: ${fixtureStderr}`)), 5_000);
    const resolve = (candidate) => {
      clearTimeout(timeout);
      resolvePort(candidate);
    };
    const reject = (error) => {
      clearTimeout(timeout);
      rejectPort(error);
    };
    fixture.once('error', reject);
    fixture.once('exit', (code, signal) => reject(new Error(`loopback fixture exited before readiness (${code ?? signal ?? 'unknown'}): ${fixtureStderr}`)));
    fixture.stdout.setEncoding('utf8');
    fixture.stdout.on('data', (chunk) => {
      value += chunk;
      const line = value.split(/\r?\n/u)[0];
      if (/^\d+$/u.test(line)) resolve(Number(line));
    });
  });
  const agentHome = join(home, '.octocode', 'agent');
  await mkdir(agentHome, { recursive: true });
  await writeFile(join(sandbox, 'probe.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
  await writeFile(join(agentHome, 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-responses',
        apiKey: '$OCTOCODE_MODEL_API_KEY',
        models: [{ id: 'deterministic-v1' }],
      },
    },
  }));
  const startedAt = performance.now();
  try {
    const result = spawnSync('expect', ['-c', expectProgram(home)], {
      cwd: sandbox,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const semanticOutput = semanticTerminalText(output);
    if (result.error) {
      throw new Error(
        `${result.error.message}: ${output.slice(-4_000)}`,
        { cause: result.error },
      );
    }
    if (result.status !== 0) throw new Error(`expect exited ${result.status}: ${output.slice(-4_000)}`);
    for (const marker of [readinessMarker, ...footerMarkers, ...commandCases.map(({ marker }) => marker)]) {
      if (!semanticOutput.includes(marker)) throw new Error(`captured output omitted ${JSON.stringify(marker)}: ${semanticOutput.slice(-4_000)}`);
    }
    for (const testCase of commandCases) {
      for (const marker of testCase.markerParts ?? []) {
        if (!semanticOutput.includes(marker)) throw new Error(`captured paste marker omitted ${JSON.stringify(marker)}: ${semanticOutput.slice(-4_000)}`);
      }
    }
    for (const sequence of ['\u001b[?1049l', '\u001b[?2004l', '\u001b[?25h']) {
      if (!output.includes(sequence)) throw new Error(`terminal restoration sequence missing: ${JSON.stringify(sequence)}`);
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      sensor: 'octocode-agent-opentui-cli-commands',
      platform: process.platform,
      arch: process.arch,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      footer: footerMarkers.map((marker) => ({ marker, observed: true })),
      commands: commandCases.map((testCase) => ({ ...testCase, observed: true })),
      exit: { code: result.status, signal: result.signal },
      restored: true,
      pass: true,
    })}\n`);
  } finally {
    fixture.kill('SIGTERM');
    await once(fixture, 'close').catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-cli-commands',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
