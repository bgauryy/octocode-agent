import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  discoverSkills,
  formatSkillUsageLines,
  getSkillUsage,
  recordSkillLoad,
  registerSkillTool,
  resetSkillUsageForTests,
} from '../src/tools/skill-tool.js';
import type { ToolDefinition, ToolCallResult, PiContext, SkillInfo } from '../src/types.js';

afterEach(() => {
  resetSkillUsageForTests();
});

function makeSkillDir(root: string, name: string, description: string, extraFiles: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nDo the workflow.\n`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octo-skill-tool-'));
}

// ─── discovery ────────────────────────────────────────────────────────────────

test('discoverSkills finds project skills under .agents/skills with frontmatter name + description', () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo workflow skill.');
  const skills = discoverSkills(cwd);
  const demo = skills.find((s) => s.name === 'demo-flow');
  assert.ok(demo, 'project skill discovered');
  assert.equal(demo!.description, 'Demo workflow skill.');
  assert.equal(demo!.source, 'project');
  assert.ok(demo!.path.endsWith('SKILL.md'));
  assert.equal(demo!.dir, path.dirname(demo!.path));
});

test('discoverSkills: Pi-provided entries take precedence over disk scan for the same name', () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Disk description.');
  const piSkills: SkillInfo[] = [{ name: 'demo-flow', description: 'Pi description.', path: '/pi/demo-flow/SKILL.md', source: 'user', scope: 'global' }];
  const skills = discoverSkills(cwd, piSkills);
  const demo = skills.find((s) => s.name === 'demo-flow');
  assert.equal(demo!.description, 'Pi description.', 'Pi is the live session authority');
  assert.equal(demo!.source, 'user/global');
});

test('discoverSkills scans the common ecosystem roots (claude/cursor/codex/octocode/pi) in both scopes', () => {
  const cwd = tmpWorkspace();
  const home = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.claude', 'skills'), 'claude-skill', 'From project claude.');
  makeSkillDir(path.join(cwd, '.cursor', 'skills'), 'cursor-skill', 'From project cursor.');
  makeSkillDir(path.join(cwd, '.codex', 'skills'), 'codex-skill', 'From project codex.');
  makeSkillDir(path.join(cwd, '.octocode', 'skills'), 'octo-skill', 'From project octocode.');
  makeSkillDir(path.join(cwd, '.pi', 'skills'), 'pi-skill', 'From project pi.');
  makeSkillDir(path.join(home, '.claude', 'skills'), 'home-claude-skill', 'From user claude.');
  makeSkillDir(path.join(home, '.pi', 'agent', 'skills'), 'home-pi-skill', 'From user pi.');
  const bySource = Object.fromEntries(discoverSkills(cwd, undefined, home).map((s) => [s.name, s.source]));
  assert.equal(bySource['claude-skill'], 'project:claude');
  assert.equal(bySource['cursor-skill'], 'project:cursor');
  assert.equal(bySource['codex-skill'], 'project:codex');
  assert.equal(bySource['octo-skill'], 'project:octocode');
  assert.equal(bySource['pi-skill'], 'project:pi');
  assert.equal(bySource['home-claude-skill'], 'user:claude');
  assert.equal(bySource['home-pi-skill'], 'user', 'the primary pi user root keeps its plain label');
});

test('discoverSkills dedupes by NAME across roots — most-authoritative root wins', () => {
  const cwd = tmpWorkspace();
  const home = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'shared-skill', 'Canonical .agents version.');
  makeSkillDir(path.join(cwd, '.claude', 'skills'), 'shared-skill', 'Claude copy.');
  makeSkillDir(path.join(home, '.cursor', 'skills'), 'shared-skill', 'User cursor copy.');
  const skills = discoverSkills(cwd, undefined, home);
  const matches = skills.filter((s) => s.name === 'shared-skill');
  assert.equal(matches.length, 1, 'one entry per name');
  assert.equal(matches[0]!.description, 'Canonical .agents version.');
  assert.equal(matches[0]!.source, 'project');
});

test('discoverSkills skips directories without SKILL.md and missing roots without throwing', () => {
  const cwd = tmpWorkspace();
  fs.mkdirSync(path.join(cwd, '.agents', 'skills', 'not-a-skill'), { recursive: true });
  assert.doesNotThrow(() => discoverSkills(cwd));
  assert.ok(!discoverSkills(cwd).some((s) => s.name === 'not-a-skill'));
});

test('discoverSkills filters Awareness Lite because it is prompt-owned coordination', () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'octocode-awareness-lite', 'Old skill copy.');
  const piSkills: SkillInfo[] = [{ name: 'octocode-awareness-lite', description: 'Pi copy.', path: '/pi/octocode-awareness-lite/SKILL.md' }];
  const skills = discoverSkills(cwd, piSkills);
  assert.ok(!skills.some((s) => s.name === 'octocode-awareness-lite'));
});

// ─── usage ledger (observability) ─────────────────────────────────────────────

test('usage ledger records loads and formats dashboard lines, newest first', () => {
  recordSkillLoad('a-skill', 1000);
  recordSkillLoad('a-skill', 2000);
  recordSkillLoad('b-skill', 3000);
  assert.equal(getSkillUsage().get('a-skill')?.count, 2);
  const lines = formatSkillUsageLines();
  assert.deepEqual(lines, ['- b-skill: loaded 1×', '- a-skill: loaded 2×']);
});

// ─── the skill tool ───────────────────────────────────────────────────────────

async function makeTool(piSkills?: SkillInfo[]): Promise<ToolDefinition> {
  const { Type } = await import('typebox');
  let def: ToolDefinition | undefined;
  registerSkillTool(
    { registerTool: (d: ToolDefinition) => { def = d; } },
    Type,
    new Set<string>(),
    (_pi, _names, d) => { def = d; },
    () => piSkills,
  );
  assert.ok(def);
  return def!;
}

async function run(def: ToolDefinition, params: Record<string, unknown>, cwd: string): Promise<ToolCallResult> {
  return def.execute('id', params, undefined, undefined, { cwd } as unknown as PiContext) as Promise<ToolCallResult>;
}

test('skill load returns SKILL.md content, directory, and shipped files; records usage', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo.', { 'scripts/run.sh': '#!/bin/sh\n' });
  const def = await makeTool();
  const res = await run(def, { action: 'load', name: 'demo-flow', reason: 'The current task needs the demo workflow.' }, cwd);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(res.isError ?? false, false);
  assert.match(text, /skill: demo-flow \[project\]/);
  assert.match(text, /directory: /);
  assert.match(text, /Resolve every relative path/);
  assert.match(text, /files: scripts\/run\.sh/);
  assert.match(text, /# demo-flow/, 'full SKILL.md body returned');
  assert.equal(getSkillUsage().get('demo-flow')?.count, 1, 'load recorded for observability');
});

test('skill load is the default action and matches names case-insensitively', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'Demo-Flow', 'Demo.');
  const def = await makeTool();
  const res = await run(def, { name: 'demo-flow', reason: 'The current task needs the demo workflow.' }, cwd);
  assert.equal(res.isError ?? false, false);
  assert.match((res.content[0] as { text: string }).text, /skill: Demo-Flow/);
});

test('skill load requires a user-visible trigger reason', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo.');
  const def = await makeTool();
  const res = await run(def, { action: 'load', name: 'demo-flow' }, cwd);
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /requires reason explaining why it matches the current task/);
});

test('skill load on an unknown name errors with the available catalog', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo.');
  const def = await makeTool();
  const res = await run(def, { action: 'load', name: 'nope', reason: 'The task needs a workflow.' }, cwd);
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Unknown skill: nope/);
  assert.match((res.content[0] as { text: string }).text, /demo-flow/);
});

test('skill list shows every discovered skill with source and session usage', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo workflow.');
  const def = await makeTool();
  await run(def, { action: 'load', name: 'demo-flow', reason: 'The current task needs the demo workflow.' }, cwd);
  const res = await run(def, { action: 'list' }, cwd);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /skill\(\{action:"load", name:"…", reason:"why it matches"\}\)/);
  assert.match(text, /- demo-flow \[project\] \(loaded 1× this session\): Demo workflow\./);
});

test('skill render rows explain the trigger, suppress successful results, and keep errors visible', async () => {
  const cwd = tmpWorkspace();
  makeSkillDir(path.join(cwd, '.agents', 'skills'), 'demo-flow', 'Demo.');
  const def = await makeTool();
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const reason = 'The task needs a repeatable demo workflow.';
  const callRow = def.renderCall!({ action: 'load', name: 'demo-flow', reason }, theme).render(100).join('\n');
  assert.match(callRow, /◆ skill · demo-flow/);
  assert.match(callRow, /why: The task needs a repeatable demo workflow\./);
  const ok = await run(def, { name: 'demo-flow', reason }, cwd);
  const okLines = (def.renderResult as (r: ToolCallResult, o: object, t: object) => { render(w: number): string[] })(ok, {}, theme).render(100);
  assert.deepEqual(okLines, []);
  const bad = await run(def, { name: 'nope', reason }, cwd);
  const badRow = (def.renderResult as (r: ToolCallResult, o: object, t: object) => { render(w: number): string[] })(bad, {}, theme).render(100).join('\n');
  assert.match(badRow, /✗ skill · Unknown skill: nope/);
});
