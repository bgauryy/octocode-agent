#!/usr/bin/env node
// Dev entry point. The real launcher is bundled by esbuild into
// ../out/octocode-agent.mjs (a single self-running module — see scripts/build.mjs
// and package.json "bin"). Run `yarn build` in this package first.
//
// This shim simply delegates to that bundle so `node bin/octocode-agent.mjs`
// behaves identically to the published `octocode-agent` command. Importing the
// bundle runs its top-level `main(process.argv.slice(2))` and sets process.exitCode.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const bundle = new URL('../out/octocode-agent.mjs', import.meta.url);
if (!existsSync(fileURLToPath(bundle))) {
  console.error(
    'octocode-agent: build output missing at out/octocode-agent.mjs.\n' +
      'Run `yarn build` (or `yarn workspace octocode-agent build`) first.',
  );
  process.exit(1);
}
await import(bundle.href);
