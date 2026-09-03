import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(packageRoot, 'out', 'octocode-agent.mjs');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function descendantProcessIds(rootPid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ps exited ${result.status}: ${result.stderr}`);
  const byParent = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const children = byParent.get(Number(match[2])) ?? [];
    children.push(Number(match[1]));
    byParent.set(Number(match[2]), children);
  }
  const descendants = [];
  const visit = (pid) => {
    for (const childPid of byParent.get(pid) ?? []) {
      descendants.push(childPid);
      visit(childPid);
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

async function waitForProcessExit(processIds) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !processExists(pid))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const survivors = processIds.filter(processExists);
  throw new Error(`managed descendants survived shutdown: ${survivors.join(',')}`);
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
  const sentinel = join(sandbox, 'owned-temp-resource');
  await writeFile(sentinel, signal);
  const pidFile = join(sandbox, 'launcher.pid');
  const command = [
    'stty rows 24 cols 80',
    `echo $$ > ${shellQuote(pidFile)}`,
    `exec env -u NODE_OPTIONS OPENAI_API_KEY=test-key OCTOCODE_HOME=${shellQuote(join(sandbox, 'octocode-home'))} ${shellQuote(process.execPath)} ${shellQuote(executable)}`,
  ].join(' && ');
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', '/dev/null', '/bin/sh', '-c', command]
    : ['--quiet', '--return', '--command', ['/bin/sh', '-c', command].map(shellQuote).join(' '), '/dev/null'];
  const child = spawn('script', scriptArgs, { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const close = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, exitSignal) => resolveClose({ code, signal: exitSignal }));
  });

  let scenario;
  try {
    const pid = await waitForPid(pidFile, () => output);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const ownedProcessIds = [pid, ...descendantProcessIds(pid)];
    process.kill(pid, signal);
    let timeoutId;
    const timeout = new Promise((_, rejectTimeout) => {
      timeoutId = setTimeout(() => rejectTimeout(new Error(`${signal} launcher shutdown timed out`)), 5_000);
    });
    const exit = await Promise.race([close, timeout]).finally(() => clearTimeout(timeoutId));
    for (const sequence of ['\u001b[?1049l', '\u001b[?2004l', '\u001b[?25h']) {
      if (!output.includes(sequence)) throw new Error(`${signal} omitted terminal restoration sequence ${JSON.stringify(sequence)}`);
    }
    await waitForProcessExit(ownedProcessIds);
    scenario = {
      signal,
      exit,
      restored: true,
      childProcessesRestored: true,
      ownedProcessCount: ownedProcessIds.length,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(sandbox, { recursive: true, force: true });
  }
  try {
    await access(sandbox);
    throw new Error(`${signal} retained managed temp resources at ${sandbox}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { ...scenario, tempResourcesRestored: true };
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
  pass: scenarios.every(({ restored, childProcessesRestored, tempResourcesRestored }) => (
    restored && childProcessesRestored && tempResourcesRestored
  )),
})}\n`);
