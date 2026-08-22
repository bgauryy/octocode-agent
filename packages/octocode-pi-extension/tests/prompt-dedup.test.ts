/**
 * TDD tests for shouldAppendSystemPrompt — M3: proofSlice false-positive fix.
 *
 * The proofSlice check (first 160 chars) returns false-negative when
 * Pi's system prompt contains the exact same first 160 characters as the
 * Octocode prompt. After the fix, the function relies only on
 * SYSTEM_PROMPT_MARKER, which is deterministic and unique.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { shouldAppendSystemPrompt } from '../src/prompt.js';
import { SYSTEM_PROMPT_MARKER } from '../src/constants.js';

// A string that is exactly 160 chars long (easy to embed in both prompts).
const PROOF_CONTENT = 'A'.repeat(160);

// Octocode prompt whose first 160 chars are PROOF_CONTENT.
const OCTOCODE_PROMPT_WITH_PROOF = `${PROOF_CONTENT}\n\nThis is the rest of the Octocode prompt.`;

// Pi's own system prompt that happens to contain those same 160 chars — but NO marker.
const PI_PROMPT_CONTAINING_PROOF =
  `Pi's own system prompt.\n\n${PROOF_CONTENT}\n\nPi's own guidance continues here.`;

// ─── Baseline: marker-based detection works correctly ────────────────────────

test('returns false when SYSTEM_PROMPT_MARKER is already present', () => {
  const existing =
    `Some pi system prompt\n\n` +
    `${SYSTEM_PROMPT_MARKER}\n${OCTOCODE_PROMPT_WITH_PROOF}\n${SYSTEM_PROMPT_MARKER}`;
  assert.equal(shouldAppendSystemPrompt(existing, OCTOCODE_PROMPT_WITH_PROOF), false);
});

test('returns true when marker is absent and systemPrompt has no overlap', () => {
  const piPrompt = 'You are a helpful assistant. No shared content here.';
  assert.equal(shouldAppendSystemPrompt(piPrompt, OCTOCODE_PROMPT_WITH_PROOF), true);
});

// ─── M3: proofSlice false-positive scenario — RED until fix applied ────────────

test('M3: returns true when marker absent, even if Pi prompt contains the exact first 160 chars of the Octocode prompt', () => {
  // This is the proofSlice false-positive scenario:
  // - PI_PROMPT_CONTAINING_PROOF includes the first 160 chars of OCTOCODE_PROMPT_WITH_PROOF.
  // - SYSTEM_PROMPT_MARKER is absent from PI_PROMPT_CONTAINING_PROOF.
  // - Correct answer: shouldAppendSystemPrompt → true (need to append).
  // - Buggy answer (proofSlice code): false (wrongly skips the append).
  assert.equal(
    shouldAppendSystemPrompt(PI_PROMPT_CONTAINING_PROOF, OCTOCODE_PROMPT_WITH_PROOF),
    true,
    'Must return true when marker absent, even if the first 160 chars of the Octocode prompt appear verbatim in the Pi prompt',
  );
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('returns false for an empty Octocode prompt', () => {
  assert.equal(shouldAppendSystemPrompt('anything', ''), false);
  assert.equal(shouldAppendSystemPrompt('anything', '   '), false);
});

test('returns true when the system prompt is empty', () => {
  assert.equal(shouldAppendSystemPrompt('', OCTOCODE_PROMPT_WITH_PROOF), true);
});

test('returns false when marker appears mid-prompt', () => {
  const systemWithMarker =
    `Intro text.\n\n${SYSTEM_PROMPT_MARKER}\nSome content.\n${SYSTEM_PROMPT_MARKER}\n\nTrailing.`;
  assert.equal(shouldAppendSystemPrompt(systemWithMarker, OCTOCODE_PROMPT_WITH_PROOF), false);
});

// ─── stripProjectContext: the real --no-context mechanism ─────────────────────

import { stripProjectContext } from '../src/prompt.js';

test('stripProjectContext removes Pi project_context block, preserves the rest', () => {
  const pi = `Base prompt.\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="AGENTS.md">\nrepo rules\n</project_instructions>\n\n</project_context>\n\nCurrent date: 2026-08-17`;
  const out = stripProjectContext(pi);
  assert.doesNotMatch(out, /project_context|repo rules|AGENTS\.md/);
  assert.match(out, /Base prompt\./);
  assert.match(out, /Current date: 2026-08-17/);
});

test('stripProjectContext is a no-op without the block', () => {
  assert.equal(stripProjectContext('plain prompt'), 'plain prompt');
});

// ─── stripPiSkillsSection: Octocode owns the model-facing skill flow ──────────

import { stripPiSkillsSection } from '../src/prompt.js';

test('stripPiSkillsSection removes Pi read-based skills section, preserves the rest', () => {
  const pi = [
    'Base prompt.',
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
    '  <skill>',
    '    <name>demo</name>',
    '    <description>Demo skill.</description>',
    '    <location>/tmp/demo/SKILL.md</location>',
    '  </skill>',
    '</available_skills>',
    'Current working directory: /repo',
  ].join('\n');
  const out = stripPiSkillsSection(pi);
  assert.doesNotMatch(out, /Use the read tool to load/, 'read-tool instruction removed (Octocode removes the read builtin)');
  assert.doesNotMatch(out, /available_skills|\/tmp\/demo/, 'Pi catalog removed — the Octocode addendum is the single catalog');
  assert.match(out, /Base prompt\./);
  assert.match(out, /Current working directory: \/repo/);
});

test('stripPiSkillsSection is a no-op without the section and never touches the Octocode addendum tag', () => {
  assert.equal(stripPiSkillsSection('plain prompt'), 'plain prompt');
  const octocodeBlock = '<available_skills>\nSkills available by name this turn.\n</available_skills>';
  assert.equal(stripPiSkillsSection(octocodeBlock), octocodeBlock, 'only the Pi-worded section is stripped');
});

// ─── mergeManagedAppendSystem: idempotent block, repairs corruption ───────────
import { mergeManagedAppendSystem } from '../src/prompt.js';
import { MANAGED_BLOCK_START, MANAGED_BLOCK_END } from '../src/constants.js';

test('mergeManagedAppendSystem appends a managed block to plain content', () => {
  const out = mergeManagedAppendSystem('user notes', 'OCTO PROMPT');
  assert.match(out, /^user notes\n\n/);
  assert.ok(out.includes(MANAGED_BLOCK_START) && out.includes(MANAGED_BLOCK_END));
  assert.match(out, /OCTO PROMPT/);
});

test('mergeManagedAppendSystem replaces an existing well-formed block in place (idempotent, no growth)', () => {
  const once = mergeManagedAppendSystem('keep me', 'V1');
  const twice = mergeManagedAppendSystem(once, 'V2');
  assert.equal(twice.match(new RegExp(MANAGED_BLOCK_START, 'g'))?.length, 1, 'exactly one managed block');
  assert.match(twice, /keep me/);
  assert.match(twice, /V2/);
  assert.doesNotMatch(twice, /V1/, 'old prompt replaced');
});

test('mergeManagedAppendSystem repairs a dangling START (missing END) instead of stacking a second block', () => {
  const corrupted = `real notes\n\n${MANAGED_BLOCK_START}\nhalf-written prompt with no end`;
  const out = mergeManagedAppendSystem(corrupted, 'FRESH');
  assert.equal(out.match(new RegExp(MANAGED_BLOCK_START, 'g'))?.length, 1, 'the orphaned START is dropped, one block remains');
  assert.match(out, /real notes/, 'content before the broken block is preserved');
  assert.doesNotMatch(out, /half-written/, 'the dangling half-block is removed');
  assert.match(out, /FRESH/);
});
