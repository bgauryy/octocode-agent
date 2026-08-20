#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const root = new URL('../', import.meta.url);
const outDir = new URL('out/', root);

await rm(outDir, { recursive: true, force: true });

await build({
  entryPoints: [new URL('src/index.ts', root).pathname, new URL('src/cli.ts', root).pathname],
  outdir: outDir.pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:sqlite'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

await execFileAsync(process.execPath, [
  new URL('../../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
  '-p',
  new URL('tsconfig.json', root).pathname,
  '--emitDeclarationOnly',
]);

await chmod(new URL('cli.js', outDir), 0o755);
