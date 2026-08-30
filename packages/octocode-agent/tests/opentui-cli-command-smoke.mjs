import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');
const readinessMarker = 'Active mode, connection, context usage, and canonical keyboard help.';
const footerMarkers = Object.freeze([
  'Terminal footer',
  'Connection: CONNECTED',
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
]);

function tclValue(value) {
  return `{${value.replaceAll('}', '\\}')}}`;
}

function expectProgram(home, endpoint) {
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
    `spawn env NODE_OPTIONS=--experimental-ffi OCTOCODE_MODEL_API_KEY=test-key OCTOCODE_MODEL_PROTOCOL=openai-responses ${tclValue(`OCTOCODE_MODEL_ENDPOINT=${endpoint}`)} ${tclValue(`HOME=${home}`)} ${tclValue(`USERPROFILE=${home}`)} ${tclValue(`OCTOCODE_HOME=${join(home, '.octocode')}`)} ${tclValue(process.execPath)} ${tclValue(executable)} --accessible`,
    `wait_exact ${tclValue(readinessMarker)}`,
    'wait_exact "\\033\\[?25h"',
  ];
  for (const testCase of commandCases) {
    // A semantic marker can arrive before OpenTUI has restored composer focus.
    // Give the renderer one short event-loop window before the next key chord.
    lines.push('after 150');
    lines.push(`send -- ${tclValue(testCase.input)}`);
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
        const text = body.includes('second loopback followup') ? 'SECOND_LOOPBACK_REPLY'
          : body.includes('first loopback prompt') ? 'FIRST_LOOPBACK_REPLY'
          : 'COMPACT_LOOPBACK_REPLY';
        const completed = { type: 'response.completed', sequence_number: 2, response: {
          id: 'resp-loopback', object: 'response', created_at: 1, status: 'completed', error: null,
          incomplete_details: null, instructions: null, metadata: {}, model: 'gpt-5',
          output: [{ id: 'msg-loopback', type: 'message', status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }] }],
          parallel_tool_calls: true, temperature: null, tool_choice: 'auto', tools: [], top_p: null,
          usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 },
        } };
        const delta = { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg-loopback',
          output_index: 0, content_index: 0, delta: text, logprobs: [] };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('event: response.output_text.delta\\ndata: ' + JSON.stringify(delta)
          + '\\n\\nevent: response.completed\\ndata: ' + JSON.stringify(completed) + '\\n\\n');
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
  const startedAt = performance.now();
  try {
    const result = spawnSync('expect', ['-c', expectProgram(home, `http://127.0.0.1:${port}/v1`)], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`expect exited ${result.status}: ${output.slice(-4_000)}`);
    for (const marker of [readinessMarker, ...footerMarkers, ...commandCases.map(({ marker }) => marker)]) {
      if (!output.includes(marker)) throw new Error(`captured output omitted ${JSON.stringify(marker)}: ${output.slice(-4_000)}`);
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
