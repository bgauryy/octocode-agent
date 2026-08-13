import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  formatCompact,
  formatDurationShort,
  buildWorkingLabel,
  buildFooterSegments,
  resolveSystemTheme,
  resolveSystemThemeName,
  deriveSessionName,
  OCTOCODE_SPINNER_FRAMES,
  OCTOCODE_THEME_DARK,
  OCTOCODE_THEME_LIGHT,
} from '../src/ui-extras.js';

test('formatCompact abbreviates thousands and millions', () => {
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(1234), '1.2k');
  assert.equal(formatCompact(45_000_000), '45M');
});

test('formatDurationShort renders s / m s / h m', () => {
  assert.equal(formatDurationShort(0), '0s');
  assert.equal(formatDurationShort(12_000), '12s');
  assert.equal(formatDurationShort(63_000), '1m 3s');
  assert.equal(formatDurationShort(3_600_000 + 120_000), '1h 2m');
  assert.equal(formatDurationShort(undefined), '—');
});

test('buildWorkingLabel shows elapsed and compact tokens when available', () => {
  const label = buildWorkingLabel({ startedAt: 1000, now: 13_000, tokens: 13_400 });
  assert.match(label, /Octocode/);
  assert.match(label, /12s/);
  assert.match(label, /13\.4k tokens/);
});

test('buildWorkingLabel omits tokens when unknown', () => {
  const label = buildWorkingLabel({ startedAt: 1000, now: 5000, tokens: undefined });
  assert.match(label, /4s/);
  assert.doesNotMatch(label, /tokens/);
});

test('spinner frames are non-empty', () => {
  assert.ok(OCTOCODE_SPINNER_FRAMES.length >= 2);
});

test('buildFooterSegments composes context %, tokens, turns, timing, workers, plan', () => {
  const segs = buildFooterSegments({
    tokens: 16_000, contextWindow: 200_000,
    completedTurns: 3, activeTurnMs: 9000, lastTurnMs: undefined,
    sessionMs: 120_000, activeWorkers: 2, planDone: 1, planTotal: 4,
    branch: 'main', dirty: true,
  });
  const joined = segs.join(' | ');
  assert.match(joined, /8%/);          // 16000/200000
  assert.match(joined, /16\.0k\/200k/);
  assert.match(joined, /turns 3/);
  assert.match(joined, /active 9s/);
  assert.match(joined, /agents 2/);
  assert.match(joined, /plan 1\/4/);
  assert.match(joined, /main\*/);      // dirty marker
});

test('buildFooterSegments omits optional segments cleanly', () => {
  const segs = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 0,
    activeTurnMs: undefined, lastTurnMs: 1200, sessionMs: 5000,
    activeWorkers: 0, planDone: 0, planTotal: 0, branch: undefined, dirty: false,
  });
  const joined = segs.join(' | ');
  assert.doesNotMatch(joined, /agents/);
  assert.doesNotMatch(joined, /plan \d/);
  assert.match(joined, /last 1s/);
});

test('theme name constants are the shipped theme ids', () => {
  assert.equal(OCTOCODE_THEME_DARK, 'octocode-dark');
  assert.equal(OCTOCODE_THEME_LIGHT, 'octocode-light');
});

test('resolveSystemTheme maps macOS appearance to our themes', () => {
  assert.equal(resolveSystemTheme('Dark'), OCTOCODE_THEME_DARK);
  assert.equal(resolveSystemTheme(''), OCTOCODE_THEME_LIGHT);   // AppleInterfaceStyle unset => light
  assert.equal(resolveSystemTheme(null), OCTOCODE_THEME_LIGHT);
});

test('resolveSystemThemeName: macOS resolves from AppleInterfaceStyle (always decidable)', () => {
  assert.equal(resolveSystemThemeName({ platform: 'darwin', appleInterfaceStyle: 'Dark' }), OCTOCODE_THEME_DARK);
  assert.equal(resolveSystemThemeName({ platform: 'darwin', appleInterfaceStyle: '' }), OCTOCODE_THEME_LIGHT);
  assert.equal(resolveSystemThemeName({ platform: 'darwin', appleInterfaceStyle: undefined }), OCTOCODE_THEME_LIGHT);
});

test('resolveSystemThemeName: non-macOS uses COLORFGBG background heuristic', () => {
  // COLORFGBG is "fg;bg"; bg 0-6 = dark terminal, 7/15 = light.
  assert.equal(resolveSystemThemeName({ platform: 'linux', colorfgbg: '15;0' }), OCTOCODE_THEME_DARK);
  assert.equal(resolveSystemThemeName({ platform: 'linux', colorfgbg: '0;15' }), OCTOCODE_THEME_LIGHT);
  assert.equal(resolveSystemThemeName({ platform: 'linux', colorfgbg: '0;7' }), OCTOCODE_THEME_LIGHT);
});

test('resolveSystemThemeName: returns null when undetectable (keep current theme)', () => {
  assert.equal(resolveSystemThemeName({ platform: 'linux' }), null);
  assert.equal(resolveSystemThemeName({ platform: 'win32', colorfgbg: 'garbage' }), null);
  assert.equal(resolveSystemThemeName({ platform: 'linux', colorfgbg: '' }), null);
});

test('deriveSessionName cleans and truncates the first line', () => {
  assert.equal(deriveSessionName('  Fix the auth  bug\nmore'), 'Fix the auth bug');
  assert.equal(deriveSessionName(''), '');
  const long = deriveSessionName('x'.repeat(80));
  assert.ok(long.length <= 48);
  assert.match(deriveSessionName('add feature'.repeat(20)), /…$/);
});
