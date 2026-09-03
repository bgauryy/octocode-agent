import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetName = process.argv[2] ?? 'opentui-pty-smoke.mjs';
if (!new Set([
  'opentui-pty-smoke.mjs',
  'opentui-pty-stream.mjs',
  'opentui-accessibility-fault-pty.mjs',
  'opentui-init-failure-restoration.mjs',
]).has(targetName)) {
  throw new Error(`Unsupported PTY sensor: ${targetName}`);
}
const smoke = resolve(packageRoot, 'tests', targetName);
const nodeArgs = ['--experimental-ffi', '--import', 'tsx', smoke];
const captureRestoration = new Set([
  'opentui-accessibility-fault-pty.mjs',
  'opentui-init-failure-restoration.mjs',
]).has(targetName);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const childCommand = `stty rows 24 cols 80 && exec ${[process.execPath, ...nodeArgs].map(shellQuote).join(' ')}`;
const spawnOptions = captureRestoration
  ? {
      cwd: resolve(packageRoot, '../..'),
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    }
  : { cwd: resolve(packageRoot, '../..'), stdio: 'inherit' };

const result = process.platform === 'darwin'
  ? spawnSync('script', ['-q', '/dev/null', '/bin/sh', '-c', childCommand], {
      ...spawnOptions,
    })
  : process.platform === 'linux'
    ? spawnSync('script', [
        '--quiet', '--return',
        '--command', ['/bin/sh', '-c', childCommand].map(shellQuote).join(' '),
        '/dev/null',
      ], spawnOptions)
    : undefined;

if (result === undefined) {
  throw new Error(`OpenTUI PTY smoke is unsupported on ${process.platform}`);
}
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (captureRestoration) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const requiredSequences = Object.freeze({
    alternateScreenEntered: '\u001b[?1049h',
    alternateScreenLeft: '\u001b[?1049l',
    bracketedPasteEnabled: '\u001b[?2004h',
    bracketedPasteDisabled: '\u001b[?2004l',
    cursorHidden: '\u001b[?25l',
    cursorShown: '\u001b[?25h',
    keyboardModeEnabled: '\u001b[>4;1m',
    keyboardModeDisabled: '\u001b[>4;0m',
  });
  const restoration = Object.fromEntries(
    Object.entries(requiredSequences).map(([name, sequence]) => [name, output.includes(sequence)]),
  );
  if (Object.values(restoration).some((observed) => !observed)) {
    throw new Error(`PTY control restoration sequence missing: ${JSON.stringify(restoration)}`);
  }
  const expectedSensor = targetName === 'opentui-init-failure-restoration.mjs'
    ? 'octocode-agent-opentui-init-failure-restoration'
    : 'octocode-agent-opentui-accessibility-fault-matrix';
  const report = output
    .split(/\r?\n/u)
    .find((line) => line.includes(`"sensor":"${expectedSensor}"`));
  if (report === undefined) throw new Error(`PTY ${expectedSensor} sensor omitted its report`);
  process.stdout.write(`${report}\n${JSON.stringify({
    schemaVersion: 1,
    sensor: 'octocode-agent-opentui-control-restoration',
    restoration,
    pass: true,
  })}\n`);
}
