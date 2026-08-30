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
    'ajv',
    'yaml',
  ],
  // Some bundled AI SDK dependencies still contain dynamic CommonJS requires.
  // Provide an ESM-local require so builtins such as `path` remain available in
  // the single-file executable on modern Node releases.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __octocodeCreateRequire } from 'node:module';\nconst require = __octocodeCreateRequire(import.meta.url);",
  },
  minify: false,
});

await chmod(outfile, 0o755);
