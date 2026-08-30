import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetName = process.argv[2] ?? 'opentui-pty-smoke.mjs';
if (!new Set(['opentui-pty-smoke.mjs', 'opentui-pty-stream.mjs']).has(targetName)) {
  throw new Error(`Unsupported PTY sensor: ${targetName}`);
}
const smoke = resolve(packageRoot, 'tests', targetName);
const nodeArgs = ['--experimental-ffi', '--import', 'tsx', smoke];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const childCommand = `stty rows 24 cols 80 && exec ${[process.execPath, ...nodeArgs].map(shellQuote).join(' ')}`;

const result = process.platform === 'darwin'
  ? spawnSync('script', ['-q', '/dev/null', '/bin/sh', '-c', childCommand], {
      cwd: resolve(packageRoot, '../..'), stdio: 'inherit',
    })
  : process.platform === 'linux'
    ? spawnSync('script', [
        '--quiet', '--return',
        '--command', ['/bin/sh', '-c', childCommand].map(shellQuote).join(' '),
        '/dev/null',
      ], { cwd: resolve(packageRoot, '../..'), stdio: 'inherit' })
    : undefined;

if (result === undefined) {
  throw new Error(`OpenTUI PTY smoke is unsupported on ${process.platform}`);
}
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
