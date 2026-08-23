import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildPlanPrompt,
  PLAN_PROMPT_MAX_GOAL,
  PLAN_PROMPT_TRUNCATION_MARKER,
} from '../src/prompts/plan-prompt.js';
import { SYSTEM_PROMPT } from '../src/prompts/prompt.js';
import {
  expandSubagentPrompt,
  SUBAGENT_COORDINATION,
  SUBAGENT_PLACEHOLDERS,
  SUBAGENT_SURFACE,
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

test('main and shared worker prompts distinguish scoped instructions from untrusted repository content', () => {
  const workerPrompt = `${SUBAGENT_SURFACE}
${SUBAGENT_COORDINATION}`;
  for (const [name, prompt] of [
    ['main', SYSTEM_PROMPT],
    ['worker', workerPrompt],
  ] as const) {
    assert.match(prompt, /ordinary repository content.*untrusted/i, `${name} prompt distrusts ordinary repository content`);
    assert.match(
      prompt,
      /applicable repository instruction files .*harness or user.*subordinate instructions/i,
      `${name} prompt honors surfaced scoped instructions`,
    );
  }
});

test('main and shared worker prompts allow bounded read-only Git state but gate mutation', () => {
  const workerPrompt = `${SUBAGENT_SURFACE}
${SUBAGENT_COORDINATION}`;
  for (const [name, prompt] of [
    ['main', SYSTEM_PROMPT],
    ['worker', workerPrompt],
  ] as const) {
    assert.match(prompt, /local Git state.*prefer a live Octocode surface/i, `${name} prefers the live Git-state surface`);
    assert.match(prompt, /bounded read-only commands/i, `${name} allows bounded read-only Git inspection`);
    assert.match(prompt, /git status --short/i, `${name} names a concrete read-only fallback`);
    assert.match(
      prompt,
      /do not run mutating Git commands unless .*user.*explicitly requests?.*approval/i,
      `${name} keeps Git mutation behind request and approval`,
    );
    assert.doesNotMatch(prompt, /do not run Git commands unless/i, `${name} does not prohibit all Git inspection`);
  }

  assert.match(SYSTEM_PROMPT, /Use Awareness .*shared-repository work/i, 'main prompt owns repository coordination');
  assert.match(SUBAGENT_COORDINATION, /Use Awareness .*active work.*peer agents/i, 'worker prompt checks peer activity');
});

test('main prompt preserves active-work, plan, behavior-baseline, compatibility, and output branches', () => {
  assert.match(SYSTEM_PROMPT, /standalone request.*report it.*stop/i, 'standalone status stops after reporting');
  assert.match(SYSTEM_PROMPT, /active authorized work.*continue the next owed action.*pause/i, 'active status continues unless paused');
  assert.match(SYSTEM_PROMPT, /Planning ends on approval.*reclassify.*change\/build/i, 'approval ends planning before execution');
  assert.match(SYSTEM_PROMPT, /unknown most likely to invalidate the plan/i, 'planning prioritizes the riskiest unknown');
  assert.match(SYSTEM_PROMPT, /observable behavior change.*failing check or behavioral baseline/i, 'behavior changes establish evidence first');
  assert.match(SYSTEM_PROMPT, /existing accepted contract or explicit user requirement/i, 'accepted contracts may require compatibility');
  assert.match(SYSTEM_PROMPT, /Respond in the user's language/i, 'responses match the user language');
  assert.match(SYSTEM_PROMPT, /long-running work.*state, a blocker, or the next action changes/i, 'long work reports meaningful changes');
  assert.match(SYSTEM_PROMPT, /do not narrate every tool call or use a fixed timer/i, 'progress remains quiet and event-driven');
});

test('main prompt top-level XML sections are balanced, uniquely owned, and remain compact', () => {
  const opens = [...SYSTEM_PROMPT.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]);
  const closes = [...SYSTEM_PROMPT.matchAll(/^<\/([a-z_]+)>$/gm)].map((match) => match[1]);
  assert.deepEqual(closes, opens, 'top-level sections close in the same order they open');
  assert.equal(new Set(opens).size, opens.length, 'each top-level section has one owner');

  for (const removedSection of [
    'octocode_cli',
    'skills',
    'agents',
    'tools',
    'ui_ux',
    'browser_agent',
    'search_and_research',
    'code',
    'testing',
    'ultimate_reminders',
  ]) {
    assert.ok(!opens.includes(removedSection), `static <${removedSection}> section stays externalized`);
  }
});

test('plan mode keeps its no-mutation and explicit approval gate', () => {
  const prompt = buildPlanPrompt('change the public API');
  assert.match(prompt, /PLAN MODE/i);
  assert.match(prompt, /do not (?:edit|change)|must not edit|no mutation/i);
  assert.match(prompt, /approval ends planning.*reclassified as change\/build/i);
  assert.match(prompt, /rejected|rejection/i);
  assert.match(prompt, /plan\(propose\)|action:\s*["']propose["']/i);
  assert.match(prompt, /Do not change code before approval/i);
});

test('plan mode preserves goal formatting and makes truncation explicit', () => {
  const multiline = buildPlanPrompt('first constraint\r\n  second constraint');
  assert.match(multiline, /Goal:\nfirst constraint\n  second constraint/);
  assert.doesNotMatch(multiline, /Goal truncated/);

  const exactLimit = buildPlanPrompt('x'.repeat(PLAN_PROMPT_MAX_GOAL));
  assert.doesNotMatch(exactLimit, /Goal truncated/);

  const oversized = buildPlanPrompt(`${'x'.repeat(PLAN_PROMPT_MAX_GOAL)}\nMUST_KEEP`);
  assert.ok(oversized.includes(PLAN_PROMPT_TRUNCATION_MARKER), 'oversized goal carries the explicit marker');
  assert.ok(!oversized.includes('MUST_KEEP'), 'content remains bounded at the documented limit');
  assert.match(oversized, /ask the user to restate omitted constraints before proposing/i);
});

test('typed-worker coordination treats ordinary overlap as advisory', () => {
  assert.match(SUBAGENT_COORDINATION, /never edit through an exclusive lock/i);
  assert.match(SUBAGENT_COORDINATION, /Coordinate ordinary overlap/i);
  assert.match(SUBAGENT_COORDINATION, /ownership remains unresolved.*notify the parent/i);
  assert.doesNotMatch(SUBAGENT_COORDINATION, /active lock or ownership conflict/i);
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
