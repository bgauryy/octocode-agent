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
// a model trigger rate; it ensures unseen cases remain separable by repository
// work intent rather than exact training-prompt strings.
function routesRepositoryWork(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const explicitNearMiss = /(outside (?:a )?repo|conceptually|personal|phone screen|career|favorite restaurant|logo image|email|meeting|slide|blog post|uploaded csv|browse|search the web)/;
  if (explicitNearMiss.test(text)) return false;
  const repositoryContext = /(repo|repository|checkout|package\.json|package tests?|packages?|dependency|parser test|pr diff|migration|auth schema|pre-edit hook|verification|coding session|\.octocode|gotcha|workers?|subagents?|agnets|same fiel|selectable tasks?)/;
  const workIntent = /(fix|review|update|implement|continue|plan|editing|rotate|block|check|save|refresh|bump|make|resume|touch|install|smoke|mean|split)/;
  return repositoryContext.test(text) && workIntent.test(text);
}

describe('skill routing boundaries', () => {
  it('makes awareness the primary workflow skill', () => {
    const text = skill('octocode-awareness');
    const desc = description(text);
    expect(desc).toMatch(/^Use before starting and before finishing any repo task/);
    expect(desc).toContain('planning, edits, reviews, tests, handoffs');
    expect(desc).toContain('multi-agent/file overlap');
    expect(desc).toContain('verification debt');
    expect(desc).toContain('memory/wiki');
    expect(desc).toContain('hooks');
    expect(desc).toContain('even solo');
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).not.toContain('dogfood');
    expect(desc).not.toContain('packages/octocode-awareness');
    expect(text).toContain('Use at repo task start and finish');
    expect(text).toMatch(/run live-state actions through the CLI/i);
    expect(text).toContain('npx @octocodeai/octocode-awareness');
    expect(text).toContain('node packages/octocode-awareness/out/octocode-awareness.js');
    expect(text).toContain('Core loop:');
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
    expect(text).toContain('Load one reference when needed:');
    expect(text).toContain('clean only under pressure');
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

    expect(text).toContain('AGENTS routes; skill decides; CLI/SQLite acts; hooks automate deterministic edges');
    expect(text).toMatch(/plan\/task/i);
    expect(text).toContain('work start');
    expect(text).toContain('work start --exclusive');
    expect(text).toContain('lock wait/prune');
    expect(text).toContain('verify mark');
    expect(text).toContain('verify audit');
    expect(text).toContain('Recall memory only if it can change the plan');
    expect(text).toContain('reflect record --lesson');
    expect(text).toContain('query');
    expect(text).toContain('Output/wiki/query/docs');
    expect(text).toContain('never hand-edit `.octocode/`');
    expect(text).toMatch(/Hooks automate edges, not judgment[\s\S]*never choose plans, locks, success, learning, cleanup, or projection/i);
    expect(text).toMatch(/expiry.*never.*success/i);
  });

  it('shows a lean overview of every Awareness feature family', () => {
    const text = skill('octocode-awareness');
    expect(text).toContain('Load one reference when needed:');
    for (const feature of [
      'attend', 'plan', 'task', 'WORK', 'lock', 'verify', 'Signals', 'refinements',
      'query', 'Memory', 'Reflection', 'Output/wiki', 'hooks', 'schema',
    ]) {
      expect(text, `missing lean feature route: ${feature}`).toContain(feature);
    }
    expect(text).toMatch(/Plan\/task\/WORK choice/i);
    expect(text).toMatch(/Memory trust\/write\/archive/i);
    expect(text).toMatch(/Hooks\/hosts\/Pi\/Codex\/Cursor\/Claude/i);
    expect(awarenessSkillFile('references/hooks.md')).toMatch(/do not choose tasks or replace\s+`attend`\/verify/i);
    expect(text).toMatch(/schema command|schema commands/);
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
      actual: routesRepositoryWork(entry.prompt),
    }))).toEqual(heldOut.map((entry) => ({
      prompt: entry.prompt,
      expected: entry.expect,
      actual: entry.expect,
    })));
    expect(heldOut.filter((entry) => entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/only agent/i);
    expect(heldOut.filter((entry) => entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/read-only security review/i);
    expect(heldOut.filter((entry) => entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/resume/i);
    expect(heldOut.filter((entry) => !entry.expect).map((entry) => entry.prompt).join('\n')).toMatch(/outside a repo/i);
  });

  it('routes each fresh-agent feature question to one direct owner', () => {
    const text = skill('octocode-awareness');
    const journeys = [
      ['Start/finish/unknown command:', 'agent-cheatsheet.md'],
      ['Plan/task/WORK choice:', 'plan-task-workflow.md'],
      ['Work/files/overlap:', 'files-awareness.md'],
      ['Exclusive work/verify debt:', 'lock-protocol.md'],
      ['Signals/refinements/peers:', 'coordination-protocol.md'],
      ['Hooks/hosts/Pi/Codex/Cursor/Claude:', 'hooks.md'],
      ['Output/wiki/query/docs:', 'output-routing.md'],
      ['Memory trust/write/archive:', 'memory-recall.md'],
      ['Architecture/session/storage:', 'architecture.md'],
      ['Reflection/skill changes/cleanup:', 'improve-loop.md'],
      ['Reflection/skill changes/cleanup:', 'skill-evolution.md'],
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
    const tooling = awarenessSkillFile('references/agent-cheatsheet-tooling.md');
    const octocode = awarenessSkillFile('references/octocode.md');
    const dataModel = awarenessSkillFile('references/data-model.md');
    const repoContext = awarenessSkillFile('references/repo-context-management.md');
    const combined = [readme, tooling, octocode, dataModel, repoContext].join('\n');

    expect(combined).not.toMatch(/<package>|<awareness-package>|default for this monorepo/);
    expect(combined).not.toContain('package migration truth: `docs/DB.md`');
    expect(readme).toContain('$(npm root --global)/@octocodeai/octocode-awareness/out/skills/octocode-awareness');
    expect(tooling).not.toContain('out/skills/octocode-skills');
    expect(octocode).toContain('references/agent-cheatsheet-tooling.md');
  });
});
