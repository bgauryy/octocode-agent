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
  { input: '/clear', marker: 'SUCCESS: Context cleared. New session started.' },
  { input: '/compact', marker: 'SUCCESS: Context compacted.' },
  { input: '/thinking low', marker: 'ERROR: /thinking: the configured model adapter does not support thinking controls' },
  { input: 'first loopback prompt', marker: 'FIRST_LOOPBACK_REPLY' },
  { input: 'second loopback followup', marker: 'SECOND_LOOPBACK_REPLY' },
  {
    input: 'probe.png',
    marker: 'IMAGE_LOOPBACK_REPLY',
    paste: true,
    image: true,
    markerParts: ['probe.png', 'PNG', '8B]'],
  },
  {
    input: Array.from({ length: 12 }, (_, index) => `paste-line-${String(index + 1).padStart(2, '0')}`).join('\n'),
    marker: 'PASTE_LOOPBACK_REPLY',
    paste: true,
    markerParts: ['[paste #', '+12', 'lines]'],
  },
  { input: '/skills', marker: 'Skills', modal: true },
  { input: '/tools', marker: 'Tools', modal: true },
]);

export function tclValue(value) {
  return `{${value.replaceAll('}', '\\}')}}`;
}

export function semanticTerminalText(value) {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[ -/]*[0-~]/gu, '');
}

function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ps exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }] : [];
  });
}

function descendantProcessIds(rootPid) {
  const byParent = new Map();
  for (const processRow of processTable()) {
    const children = byParent.get(processRow.parentPid) ?? [];
    children.push(processRow.pid);
    byParent.set(processRow.parentPid, children);
  }
  const descendants = [];
  const visit = (pid) => {
    for (const childPid of byParent.get(pid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function runExpect(program, cwd, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('expect', ['-c', program], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const ownedProcessIds = new Set([child.pid]);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const captureOwnedProcesses = () => {
      const cliPidMatch = /CLI_PID:(\d+)/u.exec(`${stdout}\n${stderr}`);
      const roots = [child.pid, ...(cliPidMatch ? [Number(cliPidMatch[1])] : [])];
      for (const rootPid of roots) {
        ownedProcessIds.add(rootPid);
        for (const descendantPid of descendantProcessIds(rootPid)) {
          ownedProcessIds.add(descendantPid);
        }
      }
    };
    const terminateOwnedProcesses = () => {
      captureOwnedProcesses();
      for (const pid of [...ownedProcessIds].reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (error?.code !== 'ESRCH') throw error;
        }
      }
    };
    const settle = async (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateOwnedProcesses();
      const cleanupDeadline = performance.now() + 2_000;
      while ([...ownedProcessIds].some(processExists) && performance.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const processTreeCleaned = [...ownedProcessIds].every((pid) => !processExists(pid));
      resolveRun({
        stdout,
        stderr,
        status,
        signal,
        processTreeRootPid: child.pid,
        processTreeCleaned,
        ownedProcessCount: ownedProcessIds.size,
        error: error ?? (processTreeCleaned
          ? undefined
          : new Error(`expect process tree rooted at ${child.pid} survived cleanup`)),
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcesses();
    }, timeoutMs);
    child.once('error', (error) => {
      void settle(null, null, error);
    });
    child.once('close', (status, signal) => {
      void settle(
        status,
        signal,
        timedOut ? new Error(`expect timed out after ${timeoutMs}ms`) : undefined,
      );
    });
  });
}

function cleanupFaultProgram() {
  return [
    'set timeout -1',
    'log_user 0',
    'spawn /bin/sh -c {while :; do sleep 1; done}',
    'puts stderr "CLI_PID:[exp_pid]"',
    'expect eof',
  ].join('\n');
}

export async function terminateChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return { forced: false };
  const closed = once(child, 'close').then(() => true, () => false);
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (graceful) return { forced: false };
  child.kill('SIGKILL');
  const forced = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!forced) throw new Error(`${label} survived SIGKILL cleanup`);
  return { forced: true };
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
    'puts stderr "CLI_PID:[exp_pid]"',
    'set child_tty $spawn_out(slave,name)',
    'exec /bin/stty rows 24 columns 80 < $child_tty',
    `wait_exact ${tclValue(readinessMarker)}`,
    'wait_exact "\\033\\[?25h"',
  ];
  for (const testCase of commandCases) {
    // A semantic marker can arrive before OpenTUI has restored composer focus.
    // Give the renderer one short event-loop window before the next key chord.
    lines.push(`after ${testCase.beforeDelayMs ?? 150}`);
    const pasteInput = testCase.input
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n');
    lines.push(testCase.paste
      ? `send -- "\\033\\[200~${pasteInput}\\033\\[201~"`
      : `send -- ${tclValue(testCase.input)}`);
    if (testCase.paste) lines.push(testCase.image ? 'after 300' : 'after 150');
    if (testCase.markerParts?.[0]) {
      lines.push(`wait_exact ${tclValue(testCase.markerParts[0])}`);
      lines.push('after 100');
    }
    // Kitty keyboard protocol: Unicode code point 13 with the Ctrl modifier.
    lines.push('send -- "\\033\\[13;5u"');
    lines.push(`wait_exact ${tclValue(testCase.marker)}`);
    if (testCase.approval) {
      lines.push('send -- "\\033"');
      lines.push('after 250');
    }
    if (testCase.modal) {
      lines.push('send -- "\\033"');
      lines.push('after 150');
    }
  }
  lines.push('exec /bin/stty rows 18 columns 40 < $child_tty');
  lines.push('set narrow_size [exec /bin/stty size < $child_tty]');
  lines.push('if {$narrow_size ne "18 40"} { puts stderr "RESIZE_MISMATCH:$narrow_size"; exit 92 }');
  lines.push('puts stderr "PTY_RESIZED:18x40"');
  lines.push('after 300');
  lines.push('exec /bin/stty rows 24 columns 80 < $child_tty');
  lines.push('set restored_size [exec /bin/stty size < $child_tty]');
  lines.push('if {$restored_size ne "24 80"} { puts stderr "RESTORE_MISMATCH:$restored_size"; exit 93 }');
  lines.push('puts stderr "PTY_SIZE_RESTORED:24x80"');
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
  const cleanupFault = await runExpect(cleanupFaultProgram(), tmpdir(), { timeoutMs: 250 });
  if (!cleanupFault.error?.message.includes('timed out after 250ms')) {
    throw new Error(`PTY cleanup fault did not time out as injected: ${cleanupFault.error?.message ?? 'no error'}`);
  }
  if (!cleanupFault.processTreeCleaned) {
    throw new Error(`injected PTY cleanup fault leaked process tree ${cleanupFault.processTreeRootPid}`);
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
  try {
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
    const result = await runExpect(expectProgram(home), sandbox);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) {
      throw new Error(`${result.error.message}: ${output.slice(-4_000)}`, { cause: result.error });
    }
    if (result.status !== 0) throw new Error(`expect exited ${result.status}: ${output.slice(-4_000)}`);
    const semanticOutput = semanticTerminalText(output);
    if (!result.processTreeCleaned) {
      throw new Error(`expect process tree rooted at ${result.processTreeRootPid} survived cleanup`);
    }
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
    for (const marker of ['PTY_RESIZED:18x40', 'PTY_SIZE_RESTORED:24x80']) {
      if (!output.includes(marker)) throw new Error(`PTY lifecycle marker missing: ${marker}`);
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      sensor: 'octocode-agent-opentui-cli-commands',
      platform: process.platform,
      arch: process.arch,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      footer: footerMarkers.map((marker) => ({ marker, observed: true })),
      commands: commandCases.map((testCase) => ({ ...testCase, observed: true })),
      accessibility: {
        enabled: true,
        narrowTerminal: { rows: 18, columns: 40, observed: true },
      },
      exit: { code: result.status, signal: result.signal },
      cleanup: {
        processTreeRootPid: result.processTreeRootPid,
        processTreeCleaned: result.processTreeCleaned,
        ownedProcessCount: result.ownedProcessCount,
        terminalSizeRestored: true,
      },
      faultInjection: {
        kind: 'interrupted-pty-child',
        timeoutMs: 250,
        processTreeCleaned: cleanupFault.processTreeCleaned,
        ownedProcessCount: cleanupFault.ownedProcessCount,
      },
      restored: true,
      pass: true,
    })}\n`);
  } finally {
    await terminateChild(fixture, 'loopback fixture');
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      sensor: 'octocode-agent-opentui-cli-commands',
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
