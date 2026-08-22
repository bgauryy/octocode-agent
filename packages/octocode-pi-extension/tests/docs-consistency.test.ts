import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  listExtensionHarness,
  OCTOCODE_SUPPORT_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
} from '../src/index.js';

const packageRoot = path.resolve(import.meta.dirname, '..');

function readPackageFile(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

test('README surface counts match the harness source', () => {
  const readme = readPackageFile('README.md');
  const harness = listExtensionHarness(packageRoot);

  assert.match(
    readme,
    new RegExp(`\\| Pi support tools \\| ${OCTOCODE_SUPPORT_TOOL_NAMES.length} \\|`)
  );
  assert.match(
    readme,
    new RegExp(`\\| Replacement edit \\+ write \\+ bash tools \\| ${OVERRIDDEN_BUILTIN_TOOL_NAMES.length} \\|`)
  );
  assert.match(
    readme,
    new RegExp(`\\| Slash command entries \\| ${harness.extensionCommands.length} \\|`)
  );
  assert.match(
    readme,
    new RegExp(`## Slash command entries \\(${harness.extensionCommands.length}\\)`)
  );
});

test('support tool inventory includes every registered support surface beyond builtin overrides', () => {
  for (const name of ['callTool', 'callSkill', 'skill', 'plan', 'localServer']) {
    assert.ok(OCTOCODE_SUPPORT_TOOL_NAMES.includes(name as never), `${name} missing from support inventory`);
  }
});

test('README command table lists every harness command entry', () => {
  const readme = readPackageFile('README.md');
  const harness = listExtensionHarness(packageRoot);

  for (const command of harness.extensionCommands) {
    assert.ok(readme.includes(`\`${command}\``), `${command} missing from README`);
  }
});

test('TOOLS browser-agent guidance uses the current browserAgent spawn flow', () => {
  const tools = readPackageFile('docs/TOOLS.md');

  assert.match(tools, /browserAgent\(\.\.\.\).*spawnAgent\(\.\.\.\).*AgentMessage\(\.\.\.\)/s);
  assert.doesNotMatch(tools, /spawnSubagent` \(agent: "browser-agent"\)/);
});
