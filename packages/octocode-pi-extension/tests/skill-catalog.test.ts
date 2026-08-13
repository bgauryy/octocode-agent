import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderAvailableSkillsAddendum } from '../src/tools/skill-catalog.js';

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
