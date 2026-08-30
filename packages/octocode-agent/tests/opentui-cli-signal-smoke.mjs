import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForPid(pidFile, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && output().includes('Octocode Agent')) return pid;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const captured = output().slice(-2_000).replaceAll('test-key', '[redacted]');
  throw new Error(`timed out waiting for the interactive launcher to enter the PTY\n${captured}`);
}

async function runScenario(signal) {
  const sandbox = await mkdtemp(join(tmpdir(), 'octocode-agent-signal-'));
  const pidFile = join(sandbox, 'launcher.pid');
  const command = [
    'stty rows 24 cols 80',
    `echo $$ > ${shellQuote(pidFile)}`,
    `exec env NODE_OPTIONS=--experimental-ffi OPENAI_API_KEY=test-key OCTOCODE_HOME=${shellQuote(join(sandbox, 'octocode-home'))} ${shellQuote(process.execPath)} ${shellQuote(executable)}`,
  ].join(' && ');
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', '/dev/null', '/bin/sh', '-c', command]
    : ['--quiet', '--return', '--command', ['/bin/sh', '-c', command].map(shellQuote).join(' '), '/dev/null'];
  const child = spawn('script', scriptArgs, { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const close = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, exitSignal) => resolveClose({ code, signal: exitSignal }));
  });

  try {
    const pid = await waitForPid(pidFile, () => output);
    process.kill(pid, signal);
    let timeoutId;
    const timeout = new Promise((_, rejectTimeout) => {
      timeoutId = setTimeout(() => rejectTimeout(new Error(`${signal} launcher shutdown timed out`)), 5_000);
    });
    const exit = await Promise.race([close, timeout]).finally(() => clearTimeout(timeoutId));
    for (const sequence of ['\u001b[?1049l', '\u001b[?2004l', '\u001b[?25h']) {
      if (!output.includes(sequence)) throw new Error(`${signal} omitted terminal restoration sequence ${JSON.stringify(sequence)}`);
    }
    return { signal, exit, restored: true };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  throw new Error(`OpenTUI signal PTY smoke is unsupported on ${process.platform}`);
}

const scenarios = [];
for (const signal of ['SIGINT', 'SIGTERM']) scenarios.push(await runScenario(signal));
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  sensor: 'octocode-agent-opentui-cli-signals',
  platform: process.platform,
  arch: process.arch,
  scenarios,
  pass: scenarios.every(({ restored }) => restored),
})}\n`);
