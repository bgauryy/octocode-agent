import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderAvailableSkillsAddendum, renderSkillsDashboard } from '../src/tools/skill-catalog.js';

test('available skills addendum lists skill names, descriptions, and source metadata', () => {
  const addendum = renderAvailableSkillsAddendum([
    { name: 'octocode-roast', description: 'Critical review workflow.', source: 'user', scope: 'global' },
    { name: 'octocode-awareness', description: 'Shared repo coordination and verification.' },
  ]);

  assert.match(addendum, /<available_skills>/);
  assert.match(addendum, /Pi-discovered skills available by name this turn/);
  assert.match(addendum, /load the minimal matching skill before acting by reading its SKILL\.md/);
  assert.match(addendum, /- octocode-awareness: Shared repo coordination and verification\./);
  assert.match(addendum, /- octocode-roast: Critical review workflow\. \[user\/global\]/);
});

test('available skills addendum is empty when Pi reports no skills', () => {
  assert.equal(renderAvailableSkillsAddendum(undefined), '');
  assert.equal(renderAvailableSkillsAddendum([]), '');
});

test('skills dashboard lists discovered skills and install guidance', () => {
  const dashboard = renderSkillsDashboard([
    { name: 'octocode-roast', description: 'Critical review workflow.', source: 'user', scope: 'global' },
    { name: 'octocode-awareness', description: 'Shared repo coordination and verification.' },
  ]);

  assert.match(dashboard, /^◆ Octocode skills/m);
  assert.match(dashboard, /Available now/);
  assert.match(dashboard, /- octocode-awareness: Shared repo coordination and verification\./);
  assert.match(dashboard, /- octocode-roast: Critical review workflow\. \[user\/global\]/);
  assert.match(dashboard, /\/skill:<name>/);
  assert.match(dashboard, /npx octocode skill --name <skill> --platform pi/);
});

test('skills dashboard explains empty discovery state', () => {
  const dashboard = renderSkillsDashboard(undefined);

  assert.match(dashboard, /none discovered/);
  assert.match(dashboard, /run \/reload after installing skills/);
});
