#!/usr/bin/env node
// Compatibility alias — prefer scripts/skill-review.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(here, 'skill-review.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
