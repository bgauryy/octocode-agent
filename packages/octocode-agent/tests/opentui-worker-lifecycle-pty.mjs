import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNativeWorkerLifecycleProvider } from './fixtures/native-worker-lifecycle-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');
const terminalStates = Object.freeze(['RUNNING', 'SUCCEEDED', 'ABORTED', 'FAILED']);

function tclValue(value) {
  return `{${value.replaceAll('}', '\\}')}}`;
}

function semanticTerminalText(value) {
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
  for (const row of processTable()) {
    const children = byParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    byParent.set(row.parentPid, children);
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

function runExpect(program, cwd, timeoutMs = 60_000) {
  return new Promise((resolveRun) => {
    const child = spawn('expect', ['-c', program], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const owned = new Set([child.pid]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const capture = () => {
      const cli = /CLI_PID:(\d+)/u.exec(`${stdout}\n${stderr}`)?.[1];
      const roots = [child.pid, ...(cli === undefined ? [] : [Number(cli)])];
      for (const root of roots) {
        owned.add(root);
        for (const pid of descendantProcessIds(root)) owned.add(pid);
      }
    };
    const sampler = setInterval(capture, 20);
    const terminate = () => {
      capture();
      for (const pid of [...owned].reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (error?.code !== 'ESRCH') throw error;
        }
      }
    };
    const settle = async (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sampler);
      capture();
      const survivorsBeforeHarnessCleanup = [...owned].filter(processExists);
      terminate();
      const deadline = performance.now() + 2_000;
      while ([...owned].some(processExists) && performance.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const processTreeCleaned = [...owned].every((pid) => !processExists(pid));
      resolveRun({
        stdout,
        stderr,
        status,
        signal,
        ownedProcessIds: [...owned],
        survivorsBeforeHarnessCleanup,
        processTreeCleaned,
        error: error ?? (processTreeCleaned ? undefined : new Error('PTY process tree survived cleanup')),
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once('error', (error) => { void settle(null, null, error); });
    child.once('close', (status, signal) => {
      void settle(status, signal, timedOut ? new Error(`expect timed out after ${timeoutMs}ms`) : undefined);
    });
  });
}

function expectProgram({ home, label, accessible }) {
  const args = [
    'env',
    'NODE_OPTIONS=--experimental-ffi',
    'OCTOCODE_MODEL_API_KEY=fixture-key',
    tclValue(`HOME=${home}`),
    tclValue(`USERPROFILE=${home}`),
    tclValue(`OCTOCODE_HOME=${join(home, '.octocode')}`),
    tclValue(process.execPath),
    tclValue(executable),
    '--no-session',
    '--allow-workers',
    '--permissions',
    'allow-all',
    '--model',
    'fixture/deterministic-v1',
    ...(accessible ? ['--accessible'] : []),
    tclValue(`ROOT_WORKER_PTY_MATRIX_${label}`),
  ];
  return [
    'set timeout 55',
    'log_user 1',
    `spawn ${args.join(' ')}`,
    'puts stderr "CLI_PID:[exp_pid]"',
    'set child_tty $spawn_out(slave,name)',
    `exec /bin/stty rows ${accessible ? 24 : 120} columns 160 < $child_tty`,
    'expect {',
    '  -exact "PTY_WORKER_MATRIX_COMPLETE" { }',
    '  timeout { puts stderr "WORKER_MATRIX_TIMEOUT"; exit 90 }',
    '  eof { puts stderr "WORKER_MATRIX_EARLY_EOF"; exit 91 }',
    '}',
    'after 250',
    `send -- ${tclValue('/exit')}`,
    'send -- "\\033\\[13;5u"',
    'expect eof',
    'catch wait result',
    'set exitCode [lindex $result 3]',
    'if {$exitCode eq ""} { set exitCode 1 }',
    'exit $exitCode',
  ].join('\n');
}

function sanitizedMeaning(output) {
  const semantic = semanticTerminalText(output);
  return terminalStates.filter((state) =>
    semantic.toLowerCase().includes(`"state":"${state.toLowerCase()}"`)
    || new RegExp(
      `(?:(?:worker|subagent)[^\\r\\n]{0,80}${state}|${state}[^\\r\\n]{0,80}(?:worker|subagent))`,
      'iu',
    ).test(semantic));
}

async function runScenario(accessible) {
  const label = accessible ? 'ACCESSIBLE' : 'VISUAL';
  const sandbox = await mkdtemp(join(tmpdir(), `octocode-worker-pty-${label.toLowerCase()}-`));
  const home = join(sandbox, 'home');
  const workspace = join(sandbox, 'workspace');
  const provider = await createNativeWorkerLifecycleProvider();
  try {
    await mkdir(join(home, '.octocode', 'agent'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(home, '.octocode', 'agent', 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
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
    const result = await runExpect(expectProgram({ home, label, accessible }), workspace);
    const output = `${result.stdout}${result.stderr}`;
    const semantic = semanticTerminalText(output);
    if (result.error) throw new Error(`${result.error.message}; fixture=${JSON.stringify(provider.snapshot())}: ${semantic.slice(-6_000)}`, { cause: result.error });
    if (result.status !== 0) throw new Error(`expect exited ${result.status}: ${semantic.slice(-6_000)}`);
    if (!result.processTreeCleaned) throw new Error('worker lifecycle PTY leaked an owned process');
    if (result.survivorsBeforeHarnessCleanup.length !== 0) {
      throw new Error(`built host left live descendants before harness cleanup: ${result.survivorsBeforeHarnessCleanup.join(',')}`);
    }
    for (const sequence of ['\u001b[?1049l', '\u001b[?2004l', '\u001b[?25h']) {
      if (!output.includes(sequence)) throw new Error(`terminal restoration sequence missing: ${JSON.stringify(sequence)}`);
    }
    const receipt = provider.snapshot();
    const expectedActions = ['spawn', 'steer', 'send', 'follow-up', 'wait', 'spawn', 'abort', 'wait', 'spawn', 'wait'];
    if (JSON.stringify(receipt.rootActions) !== JSON.stringify(expectedActions)) {
      throw new Error(`root lifecycle action receipt mismatch: ${JSON.stringify(receipt.rootActions)}`);
    }
    for (const phase of ['success-started', 'steer', 'message', 'follow-up', 'failure-started']) {
      if (!receipt.childInputs.includes(phase)) throw new Error(`child fixture omitted ${phase}: ${JSON.stringify(receipt)}`);
    }
    if (receipt.failureRequests < 1) throw new Error('failure branch did not reach the deterministic provider fault');
    for (const sensitive of [...provider.privateValues, ...receipt.workerIds]) {
      if (semantic.includes(sensitive)) throw new Error(`terminal output exposed private worker data: ${sensitive}`);
    }
    const meaning = sanitizedMeaning(output);
    for (const state of terminalStates) {
      if (!meaning.includes(state)) throw new Error(`${label} output omitted worker state ${state}: ${semantic.slice(-6_000)}`);
    }
    return {
      label,
      accessible,
      meaning,
      actions: receipt.rootActions,
      childInputs: receipt.childInputs,
      workerCount: receipt.workerIds.length,
      failureRequests: receipt.failureRequests,
      cleanup: {
        ownedProcessCount: result.ownedProcessIds.length,
        survivorsBeforeHarnessCleanup: result.survivorsBeforeHarnessCleanup,
        processTreeCleaned: result.processTreeCleaned,
        terminalRestored: true,
      },
    };
  } finally {
    await provider.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`worker lifecycle PTY sensor is unsupported on ${process.platform}`);
  }
  const visual = await runScenario(false);
  const accessible = await runScenario(true);
  if (JSON.stringify(visual.meaning) !== JSON.stringify(accessible.meaning)) {
    throw new Error(`visual/accessible worker meaning diverged: ${visual.meaning} vs ${accessible.meaning}`);
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-worker-lifecycle',
    branches: { visual, accessible },
    parity: { sanitizedMeaning: visual.meaning, identical: true },
    redaction: { privatePrompts: true, internalWorkerIds: true, rawCommands: true },
    cleanup: { processTrees: true, temporaryResources: true, terminalRestoration: true },
    pass: true,
  })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-worker-lifecycle',
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
