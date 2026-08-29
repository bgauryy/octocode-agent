#!/usr/bin/env node
/**
 * octocode-agent build script.
 * Single ESM bundle → out/octocode-agent.mjs (executable).
 */
import { build } from 'esbuild';
import { chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseOptions } from '../../../build.config.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile     = join(packageRoot, 'out', 'octocode-agent.mjs');

await rm(join(packageRoot, 'out'), { recursive: true, force: true });

await build({
  ...baseOptions,
  entryPoints: [join(packageRoot, 'src', 'cli.ts')],
  outfile,
  // Keep runtime protocol libraries external. The MCP client includes CommonJS
  // process helpers that cannot be safely inlined into the ESM executable.
  external: [
    ...baseOptions.external,
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/client/*',
    '@octocodeai/octocode-shared',
    '@octocodeai/octocode-shared/*',
    'ajv',
  ],
  banner: { js: '#!/usr/bin/env node' },
  minify: false,
});

await chmod(outfile, 0o755);
