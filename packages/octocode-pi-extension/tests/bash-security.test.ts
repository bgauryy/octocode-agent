/**
 * TDD tests for bash-tool.ts security hardening.
 * H1: Expanded catastrophic command patterns.
 * H2: Write-target detection completeness.
 *
 * These tests are RED against the un-patched source because:
 * - assertBashCommandAllowed is not yet exported.
 * - The BLOCKED_COMMAND_PATTERNS list does not yet include shutdown/reboot/halt/poweroff.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertBashCommandAllowed,
  extractBashWriteTargets,
} from '../src/tools/bash-tool.js';

const CWD = '/tmp/work';

// ─── H1: Catastrophic power-state commands ───────────────────────────────────

test('H1: blocks shutdown -h now', () => {
  assert.throws(
    () => assertBashCommandAllowed('shutdown -h now', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks bare reboot', () => {
  assert.throws(
    () => assertBashCommandAllowed('reboot', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks halt', () => {
  assert.throws(
    () => assertBashCommandAllowed('halt', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks poweroff', () => {
  assert.throws(
    () => assertBashCommandAllowed('poweroff', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks sudo reboot', () => {
  assert.throws(
    () => assertBashCommandAllowed('sudo reboot', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks reboot after semicolon separator', () => {
  assert.throws(
    () => assertBashCommandAllowed('echo done; reboot', CWD),
    /bash blocked|catastrophic/i,
  );
});

test('H1: blocks shutdown after && separator', () => {
  assert.throws(
    () => assertBashCommandAllowed('make build && shutdown -h now', CWD),
    /bash blocked|catastrophic/i,
  );
});

// ─── H1: False-positive guard — these must NOT be blocked ────────────────────

test('H1: does NOT block echo that mentions shutdown in quoted string', () => {
  // 'shutdown' inside a single-quoted string — not a command invocation
  assert.doesNotThrow(() =>
    assertBashCommandAllowed("echo 'system shutdown notice sent'", CWD),
  );
});

test('H1: does NOT block git commit message mentioning reboot', () => {
  assert.doesNotThrow(() =>
    assertBashCommandAllowed('git commit -m "fix: reboot handling improved"', CWD),
  );
});

test('H1: does NOT block a shell variable name containing reboot', () => {
  // The word "rebooting" ends with word characters, so \b anchoring preserves it
  // only when the command itself matches; a variable like REBOOTING_FLAG is not affected
  assert.doesNotThrow(() =>
    assertBashCommandAllowed('echo $REBOOTING_FLAG', CWD),
  );
});

// ─── H2: Write-target detection ──────────────────────────────────────────────

test('H2: detects exec > redirect', () => {
  const targets = extractBashWriteTargets('exec > /tmp/out.log', CWD);
  assert.ok(
    targets.includes('/tmp/out.log'),
    `exec > not detected; got: ${JSON.stringify(targets)}`,
  );
});

test('H2: detects exec >> append redirect', () => {
  const targets = extractBashWriteTargets('exec >> /tmp/appended.log', CWD);
  assert.ok(targets.includes('/tmp/appended.log'));
});

test('H2: variable-expansion redirect is recorded as a relative path (documented fail-open)', () => {
  // $OUTFILE cannot be shell-expanded; the extractor records the literal token so
  // the path guard can inspect it (fail-open: the token is treated as relative to cwd).
  const targets = extractBashWriteTargets('echo hi > $OUTFILE', CWD);
  assert.ok(
    targets.length > 0,
    'variable-expanded target must be recorded, not silently dropped',
  );
});
