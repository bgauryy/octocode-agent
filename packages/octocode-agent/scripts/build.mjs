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
  // pi + extension are runtime deps resolved from node_modules, not bundled.
  external: [
    ...baseOptions.external,
    '@earendil-works/pi-coding-agent',
    '@octocodeai/pi-extension',
  ],
  banner: { js: '#!/usr/bin/env node' },
  minify: false,
});

await chmod(outfile, 0o755);
