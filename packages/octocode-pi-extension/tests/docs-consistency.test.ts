import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  listBundledSkills,
  listExtensionHarness,
  OCTOCODE_SUPPORT_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
} from '../src/index.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const OCTOCODE_RESEARCH_TOOL_NAMES = [
  'ghSearchCode',
  'ghSearchRepos',
  'ghSearchPullRequests',
  'ghSearchIssues',
  'ghSearchCommits',
  'ghGetFileContent',
  'ghViewRepoStructure',
  'ghCloneRepo',
  'localSearchCode',
  'localFindFiles',
  'localFindDeadCode',
  'localGetFileContent',
  'localViewStructure',
  'lspGetSemantics',
  'npmSearch',
] as const;

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
    new RegExp(`\\| Guarded Pi builtin overrides \\| ${OVERRIDDEN_BUILTIN_TOOL_NAMES.length} \\(`)
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

test('support tool inventory exposes only the consolidated coordination surface', () => {
  for (const name of ['agent', 'callTool', 'skill', 'plan', 'localServer', 'lock', 'message']) {
    assert.ok(OCTOCODE_SUPPORT_TOOL_NAMES.includes(name as never), `${name} missing from support inventory`);
  }
  for (const name of ['awarenessStatus', 'awarenessPlan', 'claim', 'task', 'handoff', 'verify', 'awarenessAgents']) {
    assert.equal(OCTOCODE_SUPPORT_TOOL_NAMES.includes(name as never), false, `${name} must not have a public alias`);
  }
});

test('agent-facing docs expose only the consolidated media surface', () => {
  for (const relativePath of ['README.md', 'HARNESS.md', 'docs/TOOLS.md']) {
    const content = readPackageFile(relativePath);
    assert.ok(content.includes('`readMedia`'), `readMedia missing from ${relativePath}`);
    assert.ok(content.includes('`media`'), `media missing from ${relativePath}`);
    assert.doesNotMatch(content, /\| `readImage` \||\| `createMedia` \|/, `${relativePath} advertises a retired media tool`);
  }
});

test('agent-facing docs expose file instead of public edit/write tools', () => {
  for (const relativePath of ['README.md', 'HARNESS.md', 'docs/TOOLS.md', 'docs/OVERRIDES.md']) {
    const content = readPackageFile(relativePath);
    assert.ok(content.includes('`file`'), `file missing from ${relativePath}`);
    assert.doesNotMatch(content, /\| `edit` \| Keep|\| `write` \| Keep/, `${relativePath} retains edit/write as public tools`);
  }
});

test('README command table lists every harness command entry', () => {
  const readme = readPackageFile('README.md');
  const harness = listExtensionHarness(packageRoot);

  for (const command of harness.extensionCommands) {
    assert.ok(readme.includes(`\`${command}\``), `${command} missing from README`);
  }
});

test('TOOLS browser guidance uses the unified agent facade', () => {
  const tools = readPackageFile('docs/TOOLS.md');

  assert.match(tools, /`agent`.*browser.*lifecycle/is);
  assert.doesNotMatch(tools, /browserAgent\(\.\.\.\).*spawnAgent\(\.\.\.\).*AgentMessage\(\.\.\.\)/s);
});

test('agent-facing research inventories match the current 15-tool catalog', () => {
  const documents = [
    ['root AGENTS', readPackageFile('../../AGENTS.md')],
    ['README', readPackageFile('README.md')],
    ['HARNESS', readPackageFile('HARNESS.md')],
    ['TOOLS', readPackageFile('docs/TOOLS.md')],
  ] as const;

  for (const [label, content] of documents) {
    for (const tool of OCTOCODE_RESEARCH_TOOL_NAMES) {
      assert.ok(content.includes(`\`${tool}\``), `${tool} missing from ${label}`);
    }
    assert.doesNotMatch(content, /ghHistoryResearch|localBinaryInspect/, `${label} names removed tools`);
    assert.doesNotMatch(content, /OCTOCODE_UNIFIED_TASK_FLOW/, `${label} advertises a removed rollback flag`);
  }

  assert.match(documents[0][1], /Research catalog \(15\)/);
  assert.match(documents[1][1], /Octocode MCP research tools \(15\)/);
  assert.match(documents[2][1], /All 15 Octocode research tools/);
  assert.match(documents[3][1], /The 15 Octocode research tools/);
  assert.doesNotMatch(documents[0][1], /\$OCTO search|`oqlSearch`/);
});

test('README bundled-skill count and names match the built assets', () => {
  const readme = readPackageFile('README.md');
  const skills = listBundledSkills(path.join(packageRoot, 'dist'));

  assert.equal(skills.length, 11);
  assert.match(readme, new RegExp(`## Bundled skills \\(${skills.length}\\)`));
  assert.match(readme, new RegExp(`\\| Bundled main-agent skills \\| ${skills.length} \\|`));
  for (const skill of skills) {
    assert.ok(readme.includes(`\`${skill}\``), `${skill} missing from README bundled-skill inventory`);
  }
  assert.doesNotMatch(readme, /`octocode-awareness-lite` is copied|^- `octocode-awareness-lite`$/m);
});

test('HARNESS summary counts match stable source contracts', () => {
  const harnessDoc = readPackageFile('HARNESS.md');

  assert.match(harnessDoc, /\n15  support tools/);
  assert.match(harnessDoc, /\n 5  worker profiles/);
  assert.match(harnessDoc, /\n 8  stable system-prompt sections/);
  assert.match(harnessDoc, /stable eight-section decision kernel/);
});


test('HARNESS and UI inventories derive from the current extension harness', () => {
  const harnessDoc = readPackageFile('HARNESS.md');
  const uiDoc = readPackageFile('docs/UI.md');
  const harness = listExtensionHarness(packageRoot);

  assert.match(harnessDoc, new RegExp(`### Support Tools — ${OCTOCODE_SUPPORT_TOOL_NAMES.length}\\b`));
  for (const tool of harness.supportTools) {
    assert.ok(harnessDoc.includes(`\`${tool}\``), `${tool} missing from HARNESS support inventory`);
  }
  assert.match(harnessDoc, new RegExp(`\n${harness.extensionCommands.length}  slash commands`));
  assert.match(harnessDoc, /researcher, architect, and planner profiles use standalone prompts/);
  for (const profile of ['researcher', 'architect', 'planner', 'browser', 'custom']) {
    assert.ok(harnessDoc.includes(`\`${profile}\``), `${profile} missing from HARNESS agent profiles`);
  }
  assert.doesNotMatch(harnessDoc, /spawnSubagent[^\n]*browser-agent/);
  assert.doesNotMatch(harnessDoc, /bundles its skill assets|bundled skill\s+\(octocode-awareness/);

  assert.match(uiDoc, new RegExp(`✓ tools: 0 native Pi tools \\+ ${OCTOCODE_SUPPORT_TOOL_NAMES.length} support tools`));
  assert.doesNotMatch(uiDoc, /13 native Pi tools \+ 7 support tools/);
});
