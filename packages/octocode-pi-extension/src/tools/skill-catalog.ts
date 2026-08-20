import type { SkillInfo } from '../types.js';

// Dashboard caps: on-demand output, so it can afford the full picture.
const MAX_SKILLS = 80;
const MAX_DESCRIPTION_CHARS = 180;
// Prompt-block caps: the addendum is re-injected EVERY turn, so it is budgeted
// harder — fewer entries, tighter descriptions, and an explicit pointer to the
// /octocode-skills dashboard instead of a silent cut ("compaction is budget").
const MAX_PROMPT_SKILLS = 30;
const MAX_PROMPT_DESCRIPTION_CHARS = 120;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit = MAX_DESCRIPTION_CHARS): string {
  const oneLine = clean(text);
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function skillSortKey(skill: SkillInfo): string {
  return clean(skill.name).toLowerCase();
}

/**
 * Live projection of Pi-discovered skills into the Octocode prompt layer.
 *
 * Pi already includes skills in its own prompt, but Octocode replaces/augments the
 * system prompt and also needs a compaction-durable reminder that every loaded
 * skill has a name + description and should be loaded when context matches. This
 * projection is rebuilt from `systemPromptOptions.skills` every turn, so skill
 * installs/removals are reflected without a watcher and the block survives
 * compaction through the normal before_agent_start prompt reinjection.
 */
function validSkills(skills: SkillInfo[] | undefined): SkillInfo[] {
  return (skills ?? [])
    .filter((skill) => clean(skill.name).length > 0)
    .sort((a, b) => skillSortKey(a).localeCompare(skillSortKey(b)));
}

function formatSkillLine(skill: SkillInfo, descriptionLimit = MAX_DESCRIPTION_CHARS): string {
  const description = skill.description ? truncate(skill.description, descriptionLimit) : '(no description)';
  const source = [skill.source, skill.scope].filter(Boolean).join('/');
  return `- ${skill.name}: ${description}${source ? ` [${source}]` : ''}`;
}

export function renderSkillsDashboard(skills: SkillInfo[] | undefined): string {
  const valid = validSkills(skills);
  const shown = valid.slice(0, MAX_SKILLS);
  return [
    '◆ Octocode skills',
    '',
    'Available now',
    ...(shown.length > 0 ? shown.map((skill) => formatSkillLine(skill)) : ['(none discovered — run /reload after installing skills)']),
    ...(valid.length > shown.length ? [`- …and ${valid.length - shown.length} more skill(s)`] : []),
    '',
    'How to use',
    'Load one explicitly with /skill:<name>, or ask normally and the agent should read SKILL.md when the task matches.',
    'Install bundled skills with: npx octocode skill --name <skill> --platform pi',
    'Refresh discovery with /reload after installs/removals.',
  ].join('\n');
}

export function renderAvailableSkillsAddendum(skills: SkillInfo[] | undefined): string {
  const valid = validSkills(skills);
  if (valid.length === 0) return '';

  const shown = valid.slice(0, MAX_PROMPT_SKILLS);
  const lines = shown.map((skill) => formatSkillLine(skill, MAX_PROMPT_DESCRIPTION_CHARS));
  if (valid.length > shown.length) lines.push(`- …and ${valid.length - shown.length} more skill(s) — see /octocode-skills for the full catalog`);

  return [
    '<available_skills>',
    'Pi-discovered skills available by name this turn. Use this catalog with the <skills> policy: when the user names a skill or the task context matches a description, load the minimal matching skill before acting by reading its SKILL.md (or using /skill:<name> when appropriate). Do not load skills as ceremony.',
    ...lines,
    '</available_skills>',
  ].join('\n');
}
