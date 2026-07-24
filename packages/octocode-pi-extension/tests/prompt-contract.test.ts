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

test('coder prompt exposes explicit multi-worker orchestration and lifecycle contract', () => {
  assert.match(SYSTEM_PROMPT, /choose the cheapest correct form/);
  assert.match(SYSTEM_PROMPT, /Worker request packet \(required\)/);
  assert.match(SYSTEM_PROMPT, /workers inherit no parent conversation/i);
  assert.match(SYSTEM_PROMPT, /share the current `cwd`, filesystem/);
  assert.match(SYSTEM_PROMPT, /current turn to become idle or terminal/);
  assert.match(SYSTEM_PROMPT, /does not prove the delegated objective is complete/);
  assert.match(SYSTEM_PROMPT, /acceptance criteria pass/);
  assert.match(SYSTEM_PROMPT, /fan-out → barrier → reducer/);
  assert.match(SYSTEM_PROMPT, /Spawn all independent workers before waiting/);
  assert.match(SYSTEM_PROMPT, /`status`\/`wait` every relevant worker/);
  assert.match(SYSTEM_PROMPT, /keep `partial`\/`failed` separate/);
  assert.match(SYSTEM_PROMPT, /synthesize one parent answer/);
  assert.match(SYSTEM_PROMPT, /confirm no relevant worker remains starting\/running\/idle/);
  assert.match(SYSTEM_PROMPT, /steer` once/);

  assert.doesNotMatch(SYSTEM_PROMPT, /octocode-subagents/);
  assert.doesNotMatch(SYSTEM_PROMPT, /No shared state between workers/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Prompt is the only channel/);
  assert.doesNotMatch(SYSTEM_PROMPT, /block until done/);
  assert.doesNotMatch(SYSTEM_PROMPT, /2 failed steers|correction failure 2/);
});

test('coder prompt orders setup before delegation and delegation before detailed tool routing', () => {
  const safety = SYSTEM_PROMPT.indexOf('<safety>');
  const workMode = SYSTEM_PROMPT.indexOf('<work_mode>');
  const thinkFirst = SYSTEM_PROMPT.indexOf('<think_first>');
  const octocodeCli = SYSTEM_PROMPT.indexOf('<octocode_cli>');
  const skills = SYSTEM_PROMPT.indexOf('<skills>');
  const agents = SYSTEM_PROMPT.indexOf('<agents>');
  const tools = SYSTEM_PROMPT.indexOf('<tools>');
  const browserAgent = SYSTEM_PROMPT.indexOf('<browser_agent>');
  const search = SYSTEM_PROMPT.indexOf('<search_and_research>');
  const output = SYSTEM_PROMPT.indexOf('<output>');

  assert.ok(safety >= 0 && workMode > safety, 'safety precedes work classification');
  assert.ok(thinkFirst > workMode, 'think-first follows task classification');
  assert.ok(octocodeCli > thinkFirst, 'CLI/skill acquisition follows core reasoning policy');
  assert.ok(skills > octocodeCli, 'skill contract follows skill installation guidance');
  assert.ok(agents > skills, 'delegation sees skill contract before spawning');
  assert.ok(agents < tools, 'delegation gate precedes detailed tool routing');
  assert.ok(browserAgent > tools, 'browser agent routing follows tool catalog');
  assert.ok(search > browserAgent, 'research workflow follows browser-specific routing');
  assert.ok(output > search, 'output contract remains at the end of execution guidance');
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

test('octocode-cli documents MCP/native-first and npx fallback routing', () => {
  assert.match(SYSTEM_PROMPT, /If `\$OCTOCODE_CLI` is unset\/unavailable, use `npx octocode <command>`/);
  assert.match(SYSTEM_PROMPT, /Prefer connected Octocode MCP\/native Pi tool functions for research when available/);
  assert.match(SYSTEM_PROMPT, /fall back to `npx octocode`/);
  assert.match(SYSTEM_PROMPT, /if Octocode MCP\/native tools are connected, use those directly for research/);
  assert.match(SYSTEM_PROMPT, /Shelling to `node \$OCTOCODE_CLI tools <name>` or `npx octocode tools <name>` is a last resort/);
});

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
  assert.match(SYSTEM_PROMPT, /\.octocode\/tmp\/YYYYMMDD-HHMM-slug/);
  assert.match(SYSTEM_PROMPT, /SUMMARY-\{\{title\}\}\.md/);
  assert.match(SYSTEM_PROMPT, /future you or other agents/);
  assert.match(SYSTEM_PROMPT, /read (the )?handoff\/summary back/i);
  assert.match(SYSTEM_PROMPT, /Prefer a handoff over compaction when starting a focused new session\/thread/);
  assert.match(SYSTEM_PROMPT, /Do not create an artifact for an ordinary answer\/review/);
  assert.match(SYSTEM_PROMPT, /Persist a handoff only when work must survive/);
  assert.match(SYSTEM_PROMPT, /same logical task: continue from the summary/);
  assert.match(SYSTEM_PROMPT, /do not restart finished work/);
  assert.match(SYSTEM_PROMPT, /handoff is explicit and reviewable while compaction is lossy/);
  assert.match(SYSTEM_PROMPT, /Pi compaction is lossy/);
  assert.match(SYSTEM_PROMPT, /reloads as `summary \+ kept messages`/);
  assert.match(SYSTEM_PROMPT, /Pi['’]s native compaction/);
  assert.match(SYSTEM_PROMPT, /`ctx\.compact\(\)` \/ `\/compact`/);
  assert.match(SYSTEM_PROMPT, /adds continuation-focused summary instructions/);
  assert.match(SYSTEM_PROMPT, /queues a follow-up only after `onComplete`/);
  assert.match(SYSTEM_PROMPT, /Do not send a separate plain "continue"/);
  assert.match(SYSTEM_PROMPT, /Compact handoff structure/);
  assert.match(SYSTEM_PROMPT, /`state`.*why compacting now.*user sentiment\/preference/s);
  assert.match(SYSTEM_PROMPT, /`context`.*goal, constraints, decisions made.*decisive evidence anchors/s);
  assert.match(SYSTEM_PROMPT, /`leftovers`.*blockers, open questions.*live workers\/locks/s);
  assert.match(SYSTEM_PROMPT, /`plan\/task`.*next 1-3 dependent steps.*verification still owed/s);
  assert.match(SYSTEM_PROMPT, /`pickup`.*exact file, command, tool call, worker message, or user question/s);
  assert.match(SYSTEM_PROMPT, /After compaction.*read the summary\/handoff first/);
  assert.match(SYSTEM_PROMPT, /list\/status live workers when any were active/);
  assert.match(SYSTEM_PROMPT, /resume at `pickup`/);
  assert.match(SYSTEM_PROMPT, /If `pickup` is missing or stale/);
  assert.match(SYSTEM_PROMPT, /verified reusable gotcha.*Awareness memory/s);
  assert.doesNotMatch(SYSTEM_PROMPT, /write findings to a doc → compact → execute/);
});

test('prompt encodes leading agent best practices: action bias, non-ceremonial planning, parent-owned mutation', () => {
  assert.match(SYSTEM_PROMPT, /Action bias: do the next useful step instead of narrating intent/);
  assert.match(SYSTEM_PROMPT, /Plan only when it changes execution; skip ceremonial or single-step plans/);
  assert.match(SYSTEM_PROMPT, /do not load skills as ceremony/);
  assert.match(SYSTEM_PROMPT, /Keep dependent steps, shared decisions, user-facing synthesis, and final edits in the parent/);
  assert.match(SYSTEM_PROMPT, /prefer read-only workers and let the parent apply mutations/);
});

test('work-mode handles repo awareness and mid-task steering without broadening scope', () => {
  assert.match(SYSTEM_PROMPT, /new message while work is in progress/);
  assert.match(SYSTEM_PROMPT, /steering\/follow-up, not noise/);
  assert.match(SYSTEM_PROMPT, /Classify it as replace, append, or status/);
  assert.match(SYSTEM_PROMPT, /replace means drop the stale path/);
  assert.match(SYSTEM_PROMPT, /append means satisfy both within the same scoped task/);
  assert.match(SYSTEM_PROMPT, /Steering should change the next decision quickly/);
  assert.match(SYSTEM_PROMPT, /do not run expensive re-orientation before applying it/);
  assert.match(SYSTEM_PROMPT, /Be repo-aware/);
  assert.match(SYSTEM_PROMPT, /working tree state, staged\/unstaged changes, branch\/HEAD, and recent commit context/);
  assert.match(SYSTEM_PROMPT, /never overwrite user\/peer work/);
});

test('skills contract requires local instruction reading before action or delegation', () => {
  assert.match(SYSTEM_PROMPT, /If the user names a skill or the task clearly matches one/);
  assert.match(SYSTEM_PROMPT, /read its `SKILL\.md` completely/);
  assert.match(SYSTEM_PROMPT, /references required files\/resources/);
  assert.match(SYSTEM_PROMPT, /do not delegate reading or interpreting skill instructions to a worker/);
  assert.match(SYSTEM_PROMPT, /continue with the best fallback/);
});

test('output contract optimizes CLI DX with concise structure, flows, and focused questions', () => {
  assert.match(SYSTEM_PROMPT, /Write for a CLI: concise, scannable, and token-efficient/);
  assert.match(SYSTEM_PROMPT, /User-visible output is not thinking/);
  assert.match(SYSTEM_PROMPT, /omit private reasoning, self-talk, and tool narration/);
  assert.match(SYSTEM_PROMPT, /lead with the result, decision, or blocker/);
  assert.match(SYSTEM_PROMPT, /Structure by user need, not by everything you did/);
  assert.match(SYSTEM_PROMPT, /`Result`, `Changed`, `Verified`, `Next`/);
  assert.match(SYSTEM_PROMPT, /Omit empty sections/);
  assert.match(SYSTEM_PROMPT, /Describe flows textually when they help DX/);
  assert.match(SYSTEM_PROMPT, /`input -> decision -> action -> result`/);
  assert.match(SYSTEM_PROMPT, /Ask questions only when needed to proceed/);
  assert.match(SYSTEM_PROMPT, /Do not ask broad multi-part questionnaires/);
  assert.match(SYSTEM_PROMPT, /When several viable solutions exist, explain the options, trade-offs, and impact/);
  assert.match(SYSTEM_PROMPT, /recommend the smallest sound path/);
  assert.match(SYSTEM_PROMPT, /Never invent time estimates, dates, counts, model names, status, ownership, or other metadata/);
  assert.match(SYSTEM_PROMPT, /Before tool-heavy work, send one brief commentary update/);
  assert.match(SYSTEM_PROMPT, /about 60 seconds pass without user-visible progress/);
  assert.match(SYSTEM_PROMPT, /Keep these updates distinct from final output/);
  assert.match(SYSTEM_PROMPT, /never turn them into a transcript/);
  assert.match(SYSTEM_PROMPT, /tables\/diagrams only when relationships, mappings, complex flows, or design explanations/);
});

test('deep-check workflow uses Octocode tools, awareness, learning, and flexible delegation', () => {
  assert.match(SYSTEM_PROMPT, /do a deep check: orient, trace blast radius, inspect real callers\/contracts/);
  assert.match(SYSTEM_PROMPT, /Octocode local tools \(search, AST, LSP\)/);
  assert.match(SYSTEM_PROMPT, /visible workspace state from attend\/FilesUnderWork\/signals/);
  assert.match(SYSTEM_PROMPT, /exclusive locks only for non-mergeable files or\s+risky shared state/);
  assert.match(SYSTEM_PROMPT, /Record reusable verified learnings\/gotchas with references/);
  assert.match(SYSTEM_PROMPT, /\.octocode\/<kind>\/\.\.\./);
  assert.match(SYSTEM_PROMPT, /classifying task shape: goal, unknowns, dependencies, shared state, expected proof/);
  assert.match(SYSTEM_PROMPT, /choose the cheapest correct form/);
  assert.match(SYSTEM_PROMPT, /Communicate in small phases/);
  assert.match(SYSTEM_PROMPT, /combine `ghSearchCode` \/ `ghGetFileContent` \/ `ghViewRepoStructure` \/ `ghHistoryResearch` with `npmSearch` and `web`/);
  assert.match(SYSTEM_PROMPT, /Use web search when current docs, releases, issues, errors, or ecosystem knowledge can change the decision/);
  assert.match(SYSTEM_PROMPT, /independent lanes exist \(local code, GitHub\/npm, web\/current docs, tests\/logs, adversarial review\)/);
  assert.match(SYSTEM_PROMPT, /`web` only, GitHub\/npm only, read-only local research/);
  assert.doesNotMatch(SYSTEM_PROMPT, /rigid all-or-nothing research/i);
});

test('prompt requires logical assumption resolution and planning artifacts', () => {
  assert.match(SYSTEM_PROMPT, /If logic depends on an unknown, resolve it with code search, external\/GitHub\/npm research, web research, relevant skills\/evals, or one focused user question/);
  assert.match(SYSTEM_PROMPT, /Follow the RDD manifest \(`\/Users\/bgaryy\/code\/octocode\/MANIFEST\.md`\)/);
  assert.match(SYSTEM_PROMPT, /move from guessing to knowing with minimal sufficient evidence/);
  assert.match(SYSTEM_PROMPT, /For planning work, create a concise temp plan under `<workspace>\/\.octocode\/plans\/YYYYMMDD-HHMM-slug\/PLAN\.md`/);
  assert.match(SYSTEM_PROMPT, /for consequential designs, offer\/use `octocode-rfc-generator` instead of an ad-hoc plan/);
});

test('code prompt requires before and after architecture flow review', () => {
  assert.match(SYSTEM_PROMPT, /Before\/after edit review/);
  assert.match(SYSTEM_PROMPT, /before editing, review relevant code, architecture, and logic flows/);
  assert.match(SYSTEM_PROMPT, /input → processing → output graph/);
  assert.match(SYSTEM_PROMPT, /After editing, re-check the same flow/);
  assert.match(SYSTEM_PROMPT, /report flaws that remain or were introduced, with reasons/);
  assert.match(SYSTEM_PROMPT, /rigidities, workaround layers, looks-fixed patches, hidden blockers/);
  assert.match(SYSTEM_PROMPT, /fail future refactoring/);
});

test('coder prompt enforces blast radius, quality, and evidence-first fixes', () => {
  assert.match(SYSTEM_PROMPT, /blast radius\/impact/);
  assert.match(SYSTEM_PROMPT, /define change, blast radius, and impact before touching anything/);
  assert.match(SYSTEM_PROMPT, /correctness and maintainability beat “get it done at any cost\.”/);
  assert.match(SYSTEM_PROMPT, /Do not hide uncertainty with rigid rules, workarounds, or surface patches/);
  assert.match(SYSTEM_PROMPT, /fix the cause or state the blocker/);
  assert.match(SYSTEM_PROMPT, /Use checks, evals, and relevant skills to verify claims and solutions/);
  assert.match(SYSTEM_PROMPT, /when multiple fixes are viable, explain choices and impact to the user/);
  assert.match(SYSTEM_PROMPT, /Work like a researcher-architect: facts and logic first, hunches never/);
  assert.match(SYSTEM_PROMPT, /Solutions also need impact\/blast-radius notes and an executed check\/eval/);
});
