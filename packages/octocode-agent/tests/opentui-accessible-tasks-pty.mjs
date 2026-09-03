import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const readinessMarker = 'Active mode, connection, context usage, and canonical keyboard help.';
const privateValues = Object.freeze([
  'sk-proj-accessibletoolsecretabcdefghijklmnop',
  'sk-proj-accessibleapprovalsecretabcdefghijk',
  'private-worker-route',
]);

function completedResponse(id, output) {
  return {
    type: 'response.completed',
    sequence_number: 3,
    response: {
      id,
      object: 'response',
      created_at: 1,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model: 'deterministic-v1',
      output,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      usage: {
        input_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 3,
      },
    },
  };
}

function respondWithText(response, id, text) {
  const item = {
    id: `${id}-message`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const added = {
    type: 'response.output_item.added',
    sequence_number: 0,
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  };
  const delta = {
    type: 'response.output_text.delta',
    sequence_number: 1,
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: [],
  };
  const done = {
    type: 'response.output_item.done',
    sequence_number: 2,
    output_index: 0,
    item,
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `data: ${JSON.stringify(added)}`,
    `data: ${JSON.stringify(delta)}`,
    `data: ${JSON.stringify(done)}`,
    `data: ${JSON.stringify(completedResponse(id, [item]))}`,
    'data: [DONE]',
    '',
  ].join('\n\n'));
}

function respondWithBashCall(response, id, callId, command) {
  const args = JSON.stringify({ command });
  const item = {
    id: `${id}-function`,
    type: 'function_call',
    call_id: callId,
    name: 'bash',
    arguments: args,
    status: 'completed',
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `data: ${JSON.stringify({
      type: 'response.function_call_arguments.delta',
      delta: args,
      item_id: item.id,
      output_index: 0,
      sequence_number: 0,
    })}`,
    `data: ${JSON.stringify({
      type: 'response.output_item.done',
      item,
      output_index: 0,
      sequence_number: 1,
    })}`,
    `data: ${JSON.stringify(completedResponse(id, [item]))}`,
    'data: [DONE]',
    '',
  ].join('\n\n'));
}

async function startProvider() {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (body.includes('ACCESSIBLE_APPROVAL_TASK')) {
        if (body.includes('function_call_output')) {
          respondWithText(response, 'approval-result', 'APPROVAL_CANCELLED_RESULT');
        } else {
          respondWithBashCall(response, 'approval-request', 'call-accessible-approval', 'printf sk-proj-accessibleapprovalsecretabcdefghijk');
        }
        return;
      }
      if (body.includes('ACCESSIBLE_TOOL_TASK')) {
        if (body.includes('function_call_output')) {
          respondWithText(response, 'tool-result', 'ACCESSIBLE_TOOL_ASSISTANT_RESULT');
        } else {
          respondWithBashCall(response, 'tool-request', 'call-accessible-tool', 'printf sk-proj-accessibletoolsecretabcdefghijklmnop');
        }
        return;
      }
      respondWithText(response, 'message-result', 'ACCESSIBLE_ASSISTANT_RESULT');
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture provider did not bind TCP');
  return {
    port: address.port,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

function waitProcedure() {
  return [
    'proc wait_exact {marker} {',
    '  expect {',
    '    -exact $marker { return }',
    '    timeout { puts stderr "MARKER_TIMEOUT:$marker"; exit 90 }',
    '    eof { puts stderr "EARLY_EOF:$marker"; exit 91 }',
    '  }',
    '}',
  ];
}

function submitText(text) {
  return [
    `send -- ${tclValue(text)}`,
    `wait_exact ${tclValue(text)}`,
    'send -- "\\033\\[13;5u"',
  ];
}

function submitSlash(command) {
  const draft = /\s/u.test(command) ? command : `${command} `;
  return [
    `send -- ${tclValue(draft)}`,
    `wait_exact ${tclValue(command)}`,
    // A trailing space disables one-token slash completion. Multiword commands
    // already contain whitespace, so the Kitty submit chord always reaches the
    // composer instead of accepting a suggestion.
    'send -- "\\033\\[13;5u"',
  ];
}

function exitSteps() {
  return [
    'after 150',
    ...submitSlash('/exit'),
    'expect eof',
    'catch wait result',
    'set exitCode [lindex $result 3]',
    'if {$exitCode eq ""} { set exitCode 1 }',
    'puts "ACCESSIBLE_EXIT:$exitCode"',
    'exit $exitCode',
  ];
}

function expectProgram({ home, extraArgs = [], steps }) {
  const args = [
    'env',
    'NODE_OPTIONS=--experimental-ffi',
    'OCTOCODE_MODEL_API_KEY=fixture-key',
    tclValue(`HOME=${home}`),
    tclValue(`USERPROFILE=${home}`),
    tclValue(`OCTOCODE_HOME=${join(home, '.octocode')}`),
    tclValue(process.execPath),
    tclValue(executable),
    '--accessible',
    '--no-session',
    '--model',
    'fixture/deterministic-v1',
    ...extraArgs,
  ];
  return [
    'set timeout 10',
    'log_user 1',
    ...waitProcedure(),
    `spawn ${args.join(' ')}`,
    'puts stderr "CLI_PID:[exp_pid]"',
    'set child_tty $spawn_out(slave,name)',
    'exec /bin/stty rows 24 columns 80 < $child_tty',
    `wait_exact ${tclValue(readinessMarker)}`,
    'wait_exact "\\033\\[?25h"',
    'after 500',
    ...steps,
  ].join('\n');
}

function consumeOrderedLines(output, markers) {
  const semantic = semanticTerminalText(output);
  const lines = [];
  let offset = 0;
  for (const marker of markers) {
    const index = semantic.indexOf(marker, offset);
    if (index < 0) throw new Error(`append-only consumer omitted ${JSON.stringify(marker)}: ${semantic.slice(-4_000)}`);
    const start = Math.max(0, semantic.lastIndexOf('\n', index) + 1);
    const end = semantic.indexOf('\n', index);
    const line = semantic.slice(start, end < 0 ? undefined : end).trim();
    if (line.includes('\u001b')) throw new Error(`accessible line contained ANSI: ${line}`);
    for (const privateValue of privateValues) {
      if (line.includes(privateValue)) throw new Error(`accessible line exposed private content: ${line}`);
    }
    lines.push(line);
    offset = index + marker.length;
  }
  return Object.freeze(lines);
}

async function scenario(providerPort, label, extraArgs, steps, markers) {
  const sandbox = await mkdtemp(join(tmpdir(), `octocode-accessible-${label}-`));
  const home = join(sandbox, 'home');
  const workspace = join(sandbox, 'workspace');
  try {
    await mkdir(join(home, '.octocode', 'agent'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(home, '.octocode', 'agent', 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-responses',
          apiKey: '$OCTOCODE_MODEL_API_KEY',
          models: [{ id: 'deterministic-v1' }],
        },
      },
    }));
    await writeFile(join(home, '.octocode', 'agent', 'settings.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 'fixture',
      values: {
        defaultProvider: 'fixture',
        defaultModel: 'deterministic-v1',
        workspaceTrust: { [workspace]: 'trusted' },
      },
    }));
    const result = await runExpect(
      expectProgram({ home, extraArgs, steps }),
      workspace,
      { timeoutMs: 15_000 },
    );
    const output = `${result.stdout}${result.stderr}`;
    const semantic = semanticTerminalText(output)
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith('spawn '))
      .join('\n');
    if (result.error) throw new Error(`${label}: ${result.error.message}: ${semantic.slice(-5_000)}`, { cause: result.error });
    if (result.status !== 0) throw new Error(`${label}: expect exited ${result.status}: ${semantic.slice(-5_000)}`);
    if (!result.processTreeCleaned) throw new Error(`${label}: PTY process tree survived cleanup`);
    for (const sequence of ['\u001b[?1049l', '\u001b[?2004l', '\u001b[?25h']) {
      if (!output.includes(sequence)) throw new Error(`${label}: terminal restoration sequence missing ${JSON.stringify(sequence)}`);
    }
    for (const privateValue of privateValues) {
      if (semantic.includes(privateValue)) throw new Error(`${label}: semantic output exposed ${privateValue}`);
    }
    return Object.freeze({
      label,
      lines: consumeOrderedLines(output, markers),
      processTreeCleaned: true,
      terminalRestored: true,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`accessible task PTY sensor is unsupported on ${process.platform}`);
  }
  const provider = await startProvider();
  try {
    const common = await scenario(provider.port, 'common', [], [
      ...submitText('ACCESSIBLE_MESSAGE_TASK'),
      `wait_exact ${tclValue('ACCESSIBLE_ASSISTANT_RESULT')}`,
      'after 150',
      ...submitSlash('/plan show'),
      `wait_exact ${tclValue('No active plan.')}`,
      'exec /bin/stty rows 18 columns 40 < $child_tty',
      'set narrow_size [exec /bin/stty size < $child_tty]',
      'if {$narrow_size ne "18 40"} { puts stderr "RESIZE_MISMATCH:$narrow_size"; exit 92 }',
      'puts "ACCESSIBLE_RESIZE:18x40"',
      'after 150',
      ...submitSlash('/thinking low'),
      `wait_exact ${tclValue('ERROR: /thinking:')}`,
      'exec /bin/stty rows 24 columns 80 < $child_tty',
      ...exitSteps(),
    ], [
      'Assistant message completed.',
      'No active plan.',
      'ACCESSIBLE_RESIZE:18x40',
      'ERROR: /thinking:',
      'ACCESSIBLE_EXIT:0',
    ]);

    const tool = await scenario(provider.port, 'tool', ['--permissions', 'allow-all'], [
      ...submitText('ACCESSIBLE_TOOL_TASK'),
      `wait_exact ${tclValue('Tool Terminal')}`,
      `wait_exact ${tclValue('ACCESSIBLE_TOOL_ASSISTANT_RESULT')}`,
      ...exitSteps(),
    ], ['Tool Terminal', 'ACCESSIBLE_EXIT:0']);

    const approval = await scenario(provider.port, 'approval', ['--permissions', 'strict'], [
      ...submitText('ACCESSIBLE_APPROVAL_TASK'),
      `wait_exact ${tclValue('Approval required')}`,
      'send -- "\\033"',
      `wait_exact ${tclValue('APPROVAL_CANCELLED_RESULT')}`,
      ...exitSteps(),
    ], ['Approval required', 'ACCESSIBLE_EXIT:0']);

    const workers = await scenario(
      provider.port,
      'workers',
      ['--allow-workers', '--permissions', 'allow-all'],
      [
        ...submitSlash('/workers list'),
        `wait_exact ${tclValue('generation 1')}`,
        ...exitSteps(),
      ],
      ['Worker inbox — generation 1 — 0 workers', 'ACCESSIBLE_EXIT:0'],
    );

    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      sensor: 'octocode-agent-opentui-accessible-tasks',
      tasks: {
        messages: common.lines[0],
        tools: tool.lines[0],
        plans: common.lines[1],
        approvals: approval.lines[0],
        workers: workers.lines[0],
        errors: common.lines[3],
        resizing: common.lines[2],
        exit: common.lines[4],
      },
      scenarios: { common, tool, approval, workers },
      appendOnly: true,
      ansiAbsent: true,
      privateContentAbsent: true,
      pass: true,
    })}\n`);
  } finally {
    await provider.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-accessible-tasks',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
