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
