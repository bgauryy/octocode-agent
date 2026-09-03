#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const artifactRoot = process.env.OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR;
const requiredPlatforms = ['darwin', 'linux', 'win32'];

function fail(message) {
  console.error(`\n✗ octocode-agent publish blocked: ${message}\n`);
  process.exit(1);
}

if (!artifactRoot) {
  fail(
    'OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR is required and must point to the assembled release artifacts.'
  );
}

if (!isAbsolute(artifactRoot)) {
  fail('OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR must be an absolute path.');
}

if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
  fail(`native artifact directory does not exist: ${artifactRoot}`);
}

const targetPattern = /^(darwin|linux|win32)-[a-z0-9_]+$/;
const targets = readdirSync(artifactRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && targetPattern.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const missingPlatforms = requiredPlatforms.filter(
  (platform) => !targets.some((target) => target.startsWith(`${platform}-`))
);
if (missingPlatforms.length > 0) {
  fail(
    `assembled artifacts are missing required platforms: ${missingPlatforms.join(', ')}. ` +
      `Found: ${targets.join(', ') || 'none'}.`
  );
}

const missingBinaries = [];
for (const target of targets) {
  const extension = target.startsWith('win32-') ? '.exe' : '';
  for (const binary of ['octocode-agent-core-rust', 'octocode-agent-fs']) {
    const file = join(artifactRoot, target, `${binary}${extension}`);
    if (!existsSync(file) || !statSync(file).isFile()) {
      missingBinaries.push(file);
    }
  }
}

if (missingBinaries.length > 0) {
  fail(`assembled artifacts are incomplete:\n  ${missingBinaries.join('\n  ')}`);
}

console.log(`✓ octocode-agent publish artifacts verified: ${targets.join(', ')}`);
