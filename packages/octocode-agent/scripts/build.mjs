#!/usr/bin/env node
import { chmod, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const outfile = new URL('../out/octocode-agent.mjs', import.meta.url).pathname;

await rm(new URL('../out/', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: [new URL('../src/cli.ts', import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  external: ['@earendil-works/pi-coding-agent', '@octocodeai/pi-extension'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

await chmod(outfile, 0o755);
