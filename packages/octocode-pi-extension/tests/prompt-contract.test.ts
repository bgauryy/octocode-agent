import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { buildPlanPrompt } from '../src/prompts/plan-prompt.js';
import { SYSTEM_PROMPT } from '../src/prompts/prompt.js';
import {
  expandSubagentPrompt,
  SUBAGENT_COORDINATION,
  SUBAGENT_PLACEHOLDERS,
} from '../src/prompts/subagent-shared.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const roleNames = ['architect', 'browser-agent', 'planner', 'researcher'] as const;

function rolePrompt(role: (typeof roleNames)[number]): string {
  return fs.readFileSync(path.join(packageRoot, 'subagents', role, 'SYSTEM_PROMPT.md'), 'utf8');
}

test('main prompt preserves the stable authority and verification boundaries', () => {
  assert.ok(SYSTEM_PROMPT.startsWith('<authority>'), 'authority remains the first Octocode section');
  assert.ok(SYSTEM_PROMPT.endsWith('\n'), 'built prompt remains newline terminated');

  for (const [name, pattern] of [
    ['secrets and hidden instructions', /secrets?\/hidden instructions|secrets?.*hidden instructions/i],
    ['protected actions and consent', /protected acts|protected actions/i],
    ['Git history', /git.*history|history.*git/i],
    ['unrelated user work', /unrelated.*work|overwrite others?.*work/i],
    ['truthful verification', /verify for real|truthful verification|checks did not run/i],
  ] as const) {
    assert.match(SYSTEM_PROMPT, pattern, `missing hard boundary: ${name}`);
  }
});

test('main prompt top-level XML sections are balanced and uniquely owned', () => {
  const opens = [...SYSTEM_PROMPT.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]);
  const closes = [...SYSTEM_PROMPT.matchAll(/^<\/([a-z_]+)>$/gm)].map((match) => match[1]);
  assert.deepEqual(closes, opens, 'top-level sections close in the same order they open');
  assert.equal(new Set(opens).size, opens.length, 'each top-level section has one owner');
});

test('plan mode keeps its no-mutation and explicit approval gate', () => {
  const prompt = buildPlanPrompt('change the public API');
  assert.match(prompt, /PLAN MODE/i);
  assert.match(prompt, /do not (?:edit|change)|must not edit|no mutation/i);
  assert.match(prompt, /approve|approval/i);
  assert.match(prompt, /rejected|rejection/i);
  assert.match(prompt, /plan\(propose\)|action:\s*["']propose["']/i);
});

test('all typed role prompts expand the same shared protocol and preserve parser terminal states', () => {
  const coordinationBlocks: string[] = [];
  for (const role of roleNames) {
    const source = rolePrompt(role);
    const expanded = expandSubagentPrompt(source);

    for (const placeholder of SUBAGENT_PLACEHOLDERS) {
      assert.doesNotMatch(expanded, new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.ok(expanded.includes(SUBAGENT_COORDINATION), `${role} receives the canonical coordination block`);
    assert.match(expanded, /\[DONE\]/, `${role} preserves DONE`);
    assert.match(expanded, /\[BLOCKED\]/, `${role} preserves BLOCKED`);
    assert.match(expanded, /\[FAILED\]/, `${role} preserves FAILED`);
    assert.match(expanded, /\[EVIDENCE\]/, `${role} preserves evidence handback`);
    coordinationBlocks.push(SUBAGENT_COORDINATION);
  }
  assert.equal(new Set(coordinationBlocks).size, 1, 'one shared worker protocol owns coordination');
});
