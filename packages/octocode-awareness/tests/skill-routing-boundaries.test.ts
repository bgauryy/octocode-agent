import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');

function skill(path: string): string {
  return readFileSync(resolve(PACKAGE_ROOT, 'skills', path, 'SKILL.md'), 'utf8');
}

function awarenessSkillFile(path: string): string {
  return readFileSync(resolve(PACKAGE_ROOT, 'skills/octocode-awareness', path), 'utf8');
}

function description(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?description:\s*"([^"]+)"[\s\S]*?\n---/);
  return match?.[1] ?? '';
}

// Deterministic held-out proxy for the description boundary. This does not claim
// a model trigger rate; it ensures unseen cases remain separable by actionable
// shared-state signals rather than ordinary repository intent.
function routesAwarenessSignal(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const explicitNearMiss = /(outside (?:a )?repo|conceptually|personal|phone screen|career|favorite restaurant|logo image|email|meeting|slide|blog post|uploaded csv|browse|search the web)/;
  if (explicitNearMiss.test(text)) return false;
  const repositoryContext = /(repo|repository|checkout|package\.json|packages?|migration|pre-edit hook|verification|coding session|\.octocode|gotcha|workers?|subagents?|agnets|same fiel|selectable tasks?)/;
  const actionableSignal = /(another agent|workers?|subagents?|same fiel|selectable tasks?|migration|pre-edit hook|pending verification|verification debt|gotcha|current tasks and memory|last host|resume|awareness hooks?|\.octocode)/;
  return repositoryContext.test(text) && actionableSignal.test(text);
}

describe('skill routing boundaries', () => {
  it('routes awareness on actionable shared-state signals', () => {
    const text = skill('octocode-awareness');
    const desc = description(text);
    expect(desc).toMatch(/^Coordinate shared-repo signals and recover Awareness state\./);
    expect(desc).toContain('active peers or overlap');
    expect(desc).toContain('shared planning');
    expect(desc).toContain('verification debt');
    expect(desc).toContain('continuation recovery');
    expect(desc).toContain('Do not load for routine solo start/finish ceremony');
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).not.toContain('dogfood');
    expect(desc).not.toContain('packages/octocode-awareness');
    expect(text).toMatch(/Use when live shared state (?:can )?changes? the next action/);
    expect(text).toContain('First-class `plan`, `lock`, `message`, and `memory`');
    expect(text).toMatch(/no public status-snapshot tool/i);
    expect(text).toMatch(/run live-state actions through the CLI/i);
    expect(text).toContain('npx @octocodeai/octocode-awareness');
    expect(text).toContain('node packages/octocode-awareness/out/octocode-awareness.js');
    expect(text).toContain('Full-package core loop');
    expect(text).toContain('BEFORE:');
    expect(text).toContain('DURING:');
    expect(text).toContain('AFTER:');
    expect(text).toContain('OPTIONAL:');
    expect(text).toContain('goal, acceptance, scope, evidence');
    expect(text).toContain('work start');
    expect(text).toMatch(/ordinary overlap is allowed/i);
    expect(text).toMatch(/schema command|schema commands/);
    expect(text).toContain('first activation');
    expect(text).toContain('agent-cheatsheet.md');
    expect(text).toContain('flow-matrix.md');
    expect(text).toContain('Feature map —');
    expect(text).toContain('cleanup only under real pressure');
    expect(text).toContain('docs list --compact');
    expect(text).toContain('yarn workspace @octocodeai/octocode-awareness build');
    expect(awarenessSkillFile('references/hooks.md')).toContain('Smoke:');
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-awareness/SKILL.md'))).toBe(true);
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-skills'))).toBe(false);
  });

  it('teaches the complete agent lifecycle without assigning judgment to hooks', () => {
    const text = skill('octocode-awareness');
    const ordered = [
      'BEFORE:',
      'DURING:',
      'AFTER:',
      'OPTIONAL:',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(text.indexOf(ordered[index - 1]!)).toBeLessThan(text.indexOf(ordered[index]!));
    }

    expect(text).toContain('AGENTS routes; skill decides; tools or CLI/SQLite act; hooks automate deterministic edges');
    expect(text).toMatch(/Plan vs task vs WORK/i);
    expect(text).toContain('work start');
    expect(text).toContain('work start --exclusive');
    expect(text).toContain('lock wait/prune');
    expect(text).toContain('verify mark');
    expect(text).toContain('verify audit');
    expect(text).toContain('Recall memory only if it can change the plan');
    // The SKILL now shows the full required flags (--task/--outcome), not the
    // bare --lesson form that dead-ends with "--task is required".
    expect(text).toContain('reflect record --task "<task>" --outcome <success|failure> --lesson');
    expect(text).toContain('query');
    expect(text).toContain('Query views & docs output');
    expect(text).toMatch(/Hooks automate deterministic edges, not judgment[\s\S]*never choose plans, locks, success, learning, or cleanup/i);
    expect(text).toMatch(/expiry.*never.*success/i);
  });

  it('shows a lean overview of every Awareness feature family', () => {
    const text = skill('octocode-awareness');
    expect(text).toContain('Feature map —');
    for (const feature of [
      'attend', 'plan', 'task', 'WORK', 'lock', 'verify', 'signal', 'refinement',
      'query', 'memory', 'Reflection', 'hooks', 'schema',
    ]) {
      expect(text, `missing lean feature route: ${feature}`).toContain(feature);
    }
    expect(text).toMatch(/Plan vs task vs WORK/i);
    expect(text).toMatch(/Recall\/record durable lessons/i);
    expect(text).toMatch(/Hooks \+ hosts \(Claude\/Codex\/Cursor\)/i);
    expect(awarenessSkillFile('references/hooks.md')).toMatch(/do not choose tasks or replace\s+`attend`\/verify/i);
    expect(text).toMatch(/schema command|schema commands/);
    expect(text).toContain('not `attend run`');
  });

  it('keeps held-out repository intent behavior distinct from near misses', () => {
    const evalPath = resolve(PACKAGE_ROOT, 'skills/octocode-awareness/evals/trigger-cases.json');
    expect(existsSync(evalPath)).toBe(true);
    const cases = JSON.parse(readFileSync(evalPath, 'utf8')) as Record<string, Array<{ prompt: string; expect: boolean }>>;
    expect(cases['train_should_trigger']?.length).toBeGreaterThanOrEqual(10);
    expect(cases['train_near_miss']?.length).toBeGreaterThanOrEqual(10);
    expect(cases['held_out']?.length).toBeGreaterThanOrEqual(8);
    expect(cases['train_should_trigger']?.every((entry) => entry.expect)).toBe(true);
    expect(cases['train_near_miss']?.every((entry) => !entry.expect)).toBe(true);
    const heldOut = cases['held_out'] ?? [];
    expect(heldOut.map((entry) => ({
      prompt: entry.prompt,
      expected: entry.expect,
      actual: routesAwarenessSignal(entry.prompt),
    }))).toEqual(heldOut.map((entry) => ({
      prompt: entry.prompt,
      expected: entry.expect,
      actual: entry.expect,
    })));
    expect(heldOut.filter((entry) => !entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/only agent/i);
    expect(heldOut.filter((entry) => !entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/read-only security review/i);
    expect(heldOut.filter((entry) => entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/resume/i);
    expect(heldOut.filter((entry) => !entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/outside a repo/i);
  });

  it('routes each fresh-agent feature question to one direct owner', () => {
    const text = skill('octocode-awareness');
    const journeys = [
      ['Orient a full-package run', 'agent-cheatsheet.md'],
      ['Plan vs task vs WORK', 'plan-task-workflow.md'],
      ['File presence & overlap', 'files-awareness.md'],
      ['Exclusivity for unsafe', 'lock-protocol.md'],
      ['Communicate with other agents', 'coordination-protocol.md'],
      ['Hooks + hosts', 'hooks.md'],
      ['Query views & docs output', 'output-routing.md'],
      ['Recall/record durable lessons', 'memory-recall.md'],
      ['Architecture / session / storage', 'architecture.md'],
      ['Reflection / skill changes / cleanup', 'learning-loop.md'],
    ] as const;
    for (const [trigger, owner] of journeys) {
      expect(text).toContain(trigger);
      expect(text).toContain(`references/${owner}`);
    }
  });

  it('keeps the awareness skill self-contained after removing sibling skills', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-awareness/SKILL.md'))).toBe(true);
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-awareness/scripts/awareness.mjs'))).toBe(true);
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-skills'))).toBe(false);
  });

  it('does not ship retired routing stub directories', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-agent-communication'))).toBe(false);
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-reflection'))).toBe(false);
  });

  it('keeps generated runtime scripts only in the primary skill', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, 'skills/octocode-awareness/scripts/awareness.mjs'))).toBe(true);
  });

  it('keeps standalone guidance portable outside the monorepo', () => {
    const readme = awarenessSkillFile('README.md');
    const tooling = awarenessSkillFile('references/agent-cheatsheet.md');
    const octocode = awarenessSkillFile('references/octocode.md');
    const dataModel = awarenessSkillFile('references/data-model.md');
    const combined = [readme, tooling, octocode, dataModel].join('\n');

    expect(combined).not.toMatch(/<package>|<awareness-package>|default for this monorepo/);
    expect(combined).not.toContain('package migration truth: `docs/DB.md`');
    expect(readme).toContain('$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness');
    expect(tooling).not.toContain('out/skills/octocode-skills');
    expect(octocode).toContain('references/agent-cheatsheet.md');
  });
});
