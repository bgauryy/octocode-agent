import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, test } from 'vitest';
import { registerGeneratedTool } from '../src/tools/dynamic-tools.js';
import { registerSkill } from '../src/tools/dynamic-skills.js';
import { getDynamicCapabilitiesAddendum } from '../src/tools/dynamic-catalog.js';

let toolsHome: string;
let skillsDir: string;
let prevHome: string | undefined;
let prevSkills: string | undefined;

beforeEach(() => {
  toolsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-tools-'));
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-skills-'));
  prevHome = process.env.OCTOCODE_HOME;
  prevSkills = process.env.OCTOCODE_DYNAMIC_SKILLS_DIR;
  process.env.OCTOCODE_HOME = toolsHome;
  process.env.OCTOCODE_DYNAMIC_SKILLS_DIR = skillsDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOCODE_HOME; else process.env.OCTOCODE_HOME = prevHome;
  if (prevSkills === undefined) delete process.env.OCTOCODE_DYNAMIC_SKILLS_DIR; else process.env.OCTOCODE_DYNAMIC_SKILLS_DIR = prevSkills;
  fs.rmSync(toolsHome, { recursive: true, force: true });
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

function addTool(name: string, description = 'desc') {
  return registerGeneratedTool({
    name,
    description,
    keywords: [name],
    capabilities: [],
    reason: 'reusable in test',
    source: 'export default async () => ({ ok: 1 });',
    test: 'process.exit(0);',
  });
}
function addSkill(name: string, description = 'A recurring workflow. Use when relevant.') {
  return registerSkill({
    name,
    description,
    reason: 'recurring workflow',
    skillMd: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## Steps\n1. First do the initial preparation step.\n2. Then perform the main action.\n3. Finally verify and report the result.`,
  });
}

test('empty registries produce an empty addendum (zero token cost)', () => {
  assert.equal(getDynamicCapabilitiesAddendum(), '');
});

test('populated registries produce a wrapped, labelled block', () => {
  addTool('toSlug', 'Slugify a string');
  addSkill('release-checklist', 'Run the release checklist. Use before publishing.');
  const out = getDynamicCapabilitiesAddendum();
  assert.match(out, /^<dynamic_capabilities>/);
  assert.match(out, /<\/dynamic_capabilities>$/);
  assert.match(out, /tools:/);
  assert.match(out, /- toSlug: Slugify a string/);
  assert.match(out, /skills:/);
  assert.match(out, /- release-checklist:/);
});

test('tools-only and skills-only cases omit the empty section', () => {
  addTool('onlyTool');
  const toolsOnly = getDynamicCapabilitiesAddendum();
  assert.match(toolsOnly, /tools:/);
  assert.doesNotMatch(toolsOnly, /skills:/);
});

test('long descriptions are truncated to bound token cost', () => {
  addTool('big', 'x'.repeat(500));
  const out = getDynamicCapabilitiesAddendum();
  const line = out.split('\n').find((l) => l.startsWith('- big:'))!;
  assert.ok(line.length <= 140, `line bounded, got ${line.length}`);
  assert.match(line, /…$/);
});

test('entry count is capped so a huge registry cannot bloat the prompt', () => {
  for (let i = 0; i < 60; i++) addTool(`tool-${i}`);
  const out = getDynamicCapabilitiesAddendum();
  const toolLines = out.split('\n').filter((l) => l.startsWith('- tool-'));
  assert.ok(toolLines.length <= 30, `capped, got ${toolLines.length}`);
  assert.match(out, /more \(call action:"list"\)/);
});

test('reflects changes on the next read (no cache, no watcher needed)', () => {
  assert.equal(getDynamicCapabilitiesAddendum(), '');
  addSkill('pr-review', 'Structured PR review.');
  assert.match(getDynamicCapabilitiesAddendum(), /- pr-review:/);
});
