import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { SYSTEM_PROMPT } from '../src/prompts/compose.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const sourceSkillsDir = path.join(packageRoot, 'skills');
const browserSkillDir = path.join(
  packageRoot,
  'subagents',
  'browser-agent',
  'skills',
  'browser-agent'
);

function activeSkillCatalog(): string[] {
  const content = fs.readFileSync(
    path.join(packageRoot, 'src', 'prompts', 'sections', 'skills.md'),
    'utf8'
  );
  return [...content.matchAll(/^- `([a-z0-9-]+)` —/gm)].map(
    match => match[1]!
  );
}

test('coder prompt exposes an explicit delegation and worker lifecycle contract', () => {
  assert.match(SYSTEM_PROMPT, /Delegation gate \(before spawning\)/);
  assert.match(SYSTEM_PROMPT, /Worker request packet \(required\)/);
  assert.match(SYSTEM_PROMPT, /workers inherit no parent conversation/i);
  assert.match(SYSTEM_PROMPT, /share the current `cwd`, filesystem/);
  assert.match(SYSTEM_PROMPT, /current turn to become idle or terminal/);
  assert.match(SYSTEM_PROMPT, /does not prove the delegated objective is complete/);
  assert.match(SYSTEM_PROMPT, /acceptance criteria pass/);
  assert.match(SYSTEM_PROMPT, /steer` once/);

  assert.doesNotMatch(SYSTEM_PROMPT, /octocode-subagents/);
  assert.doesNotMatch(SYSTEM_PROMPT, /No shared state between workers/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Prompt is the only channel/);
  assert.doesNotMatch(SYSTEM_PROMPT, /block until done/);
  assert.doesNotMatch(SYSTEM_PROMPT, /2 failed steers|correction failure 2/);
});

test('coder prompt keeps safety and delegation before detailed tool routing', () => {
  const safety = SYSTEM_PROMPT.indexOf('<safety>');
  const agents = SYSTEM_PROMPT.indexOf('<agents>');
  const tools = SYSTEM_PROMPT.indexOf('<tools>');
  const output = SYSTEM_PROMPT.indexOf('<output>');

  assert.ok(safety >= 0 && agents > safety, 'safety precedes delegation');
  assert.ok(agents < tools, 'delegation gate precedes detailed tool routing');
  assert.ok(output > tools, 'output contract remains at the end of execution guidance');
});

test('every active skill catalog entry resolves to a shipped SKILL.md or carries an explicit install command', () => {
  const content = fs.readFileSync(
    path.join(packageRoot, 'src', 'prompts', 'sections', 'skills.md'),
    'utf8'
  );
  const skills = activeSkillCatalog();
  assert.ok(skills.length > 0, 'skill catalog is not empty');

  for (const skill of skills) {
    const candidates = [
      path.join(sourceSkillsDir, skill, 'SKILL.md'),
      skill === 'browser-agent' ? path.join(browserSkillDir, 'SKILL.md') : '',
      // External install roots mirrored by EXTERNAL_SKILL_DIRS in subagents.ts:
      // `npx octocode skill --name <skill> --platform pi` lands in ~/.pi/agent/skills/
      // and monorepo layouts often stage skills at <cwd>/.agents/skills/.
      path.join(process.env.HOME || '', '.pi', 'agent', 'skills', skill, 'SKILL.md'),
      path.resolve(process.cwd(), '.agents', 'skills', skill, 'SKILL.md'),
    ].filter(Boolean);
    // An entry is compliant if its SKILL.md resolves anywhere (bundled or external
    // install), OR its catalog line explicitly documents a manual install command
    // (e.g. `Not bundled; install once: npx octocode skill ...`). The latter keeps the
    // contract — agents must always be able to obtain an advertised skill — while
    // letting the catalog teach installable-but-not-bundled skills like octocode-research.
    const catalogLine =
      content.match(new RegExp(`^- \`${skill}\` —.*$`, 'm'))?.[0] ?? '';
    const documentedInstall = /install once|npx octocode skill/i.test(catalogLine);
    assert.ok(
      candidates.some(candidate => fs.existsSync(candidate)) || documentedInstall,
      `prompt references missing skill: ${skill}`
    );
  }
});

// ─── Items 3-7: new TDD tests (RED until fixes applied) ────────────────────

test('octocode-cli: every skill --name command carries --platform', () => {
  // Item 3: the first "skill --name" line was shown without --platform pi,
  // misleading agents into installing to the wrong directory.
  const skillNameLines = SYSTEM_PROMPT.split('\n').filter(l => /skill --name/.test(l));
  assert.ok(skillNameLines.length > 0, 'skill --name commands must be present in the prompt');
  for (const line of skillNameLines) {
    const isNpx = /npx/.test(line);
    const hasPlatform = /--platform/.test(line);
    assert.ok(
      isNpx || hasPlatform,
      `skill --name line is missing --platform (use --platform pi or npx form): ${line.trim()}`
    );
  }
});

test('work-mode: LEARN/CLEAN/PROJECT phases carry inline annotations', () => {
  // Item 4: abbreviations LEARN? / CLEAN? / PROJECT? appeared with no explanation
  // of what each phase means. After fix each should carry a parenthetical.
  assert.match(
    SYSTEM_PROMPT,
    /LEARN\?\s*\(/,
    'LEARN? phase must have an inline annotation e.g. LEARN? (…)'
  );
  assert.match(
    SYSTEM_PROMPT,
    /CLEAN\?\s*\(/,
    'CLEAN? phase must have an inline annotation e.g. CLEAN? (…)'
  );
  assert.match(
    SYSTEM_PROMPT,
    /PROJECT\?\s*\(/,
    'PROJECT? phase must have an inline annotation e.g. PROJECT? (…)'
  );
});

test('agents: -ne flag is explained inline', () => {
  // Item 5: `pi -ne --list-models` was shown without explaining what -ne means.
  assert.match(
    SYSTEM_PROMPT,
    /-ne[^\n]*non-interactive|non-interactive[^\n]*-ne/i,
    '`-ne` must be explained as non-interactive (and/or no-extensions) near its usage'
  );
});

test('awareness: no stale hardcoded model names', () => {
  // Item 6: "Haiku or Composer 2.5" is stale and version-locks the prompt.
  assert.doesNotMatch(
    SYSTEM_PROMPT,
    /\bHaiku\b/,
    'Haiku is a stale model name — use generic phrasing like "the configured fast/small model"'
  );
  assert.doesNotMatch(
    SYSTEM_PROMPT,
    /Composer 2\.5/,
    'Composer 2.5 is a stale model name — use generic phrasing'
  );
});

test('compose: browser_agent section appears between tools and search_and_research', () => {
  // Item 7: browserAgent was slot 14/15 (just before output), far from the tools
  // it augments. After fix it moves to immediately after <tools>.
  const toolsIdx = SYSTEM_PROMPT.indexOf('<tools>');
  const browserIdx = SYSTEM_PROMPT.indexOf('<browser_agent>');
  const searchIdx = SYSTEM_PROMPT.indexOf('<search_and_research>');
  const outputIdx = SYSTEM_PROMPT.indexOf('<output>');

  assert.ok(toolsIdx >= 0, '<tools> section must be present');
  assert.ok(browserIdx >= 0, '<browser_agent> section must be present');
  assert.ok(searchIdx >= 0, '<search_and_research> section must be present');
  assert.ok(outputIdx >= 0, '<output> section must be present');

  assert.ok(browserIdx > toolsIdx, '<browser_agent> must appear after <tools>');
  assert.ok(browserIdx < searchIdx, '<browser_agent> must appear before <search_and_research>');
  assert.ok(outputIdx > browserIdx, '<output> must come after <browser_agent>');
});

test('persistence and compaction are conditional instead of mandatory ceremony', () => {
  assert.match(
    SYSTEM_PROMPT,
    /When a plan, RFC, handoff, or research result must outlive the current context/
  );
  assert.match(SYSTEM_PROMPT, /Do not create an artifact for an ordinary answer\/review/);
  assert.match(SYSTEM_PROMPT, /Persist a handoff only when work must survive/);
  assert.doesNotMatch(SYSTEM_PROMPT, /write findings to a doc → compact → execute/);
});
