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

test('buildWorkingLabel is an animated Thinking label with no redundant time/tokens', () => {
  const label = buildWorkingLabel({ startedAt: 1000, now: 13_000 });
  assert.match(label, /^Thinking\.+$/);
  assert.doesNotMatch(label, /Octocode/);
  assert.doesNotMatch(label, /tokens/);
  assert.doesNotMatch(label, /\d+s/); // no elapsed time (lives in the footer)
});

test('buildWorkingLabel dot tail cycles 1→3 by the second', () => {
  assert.equal(buildWorkingLabel({ startedAt: 0, now: 0 }), 'Thinking.');
  assert.equal(buildWorkingLabel({ startedAt: 0, now: 1000 }), 'Thinking..');
  assert.equal(buildWorkingLabel({ startedAt: 0, now: 2000 }), 'Thinking...');
  assert.equal(buildWorkingLabel({ startedAt: 0, now: 3000 }), 'Thinking.'); // wraps
});

test('spinner frames are non-empty', () => {
  assert.ok(OCTOCODE_SPINNER_FRAMES.length >= 2);
});

test('buildFooterSegments shows the active worker progress note next to the agents count', () => {
  const segs = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 0, activeTurnMs: 0,
    sessionMs: 0, activeWorkers: 2, agentDoing: 'Editing agent-tools.ts', planDone: 0, planTotal: 0, dirty: false,
  });
  const seg = segs.find((s) => s.text.startsWith('agents '))!;
  assert.match(seg.text, /^agents 2 ‣ /);
  assert.match(seg.text, /Editing/);
});

test('buildFooterSegments composes context %, tokens, turns, timing, workers, plan', () => {
  const segs = buildFooterSegments({
    tokens: 16_000, contextWindow: 200_000,
    completedTurns: 3, activeTurnMs: 9000, lastTurnMs: undefined,
    sessionMs: 120_000, activeWorkers: 2, planDone: 1, planTotal: 4,
    branch: 'main', dirty: true,
  });
  const joined = segs.map((s) => s.text).join(' | ');
  assert.match(joined, /8%/);          // 16000/200000
  assert.match(joined, /16\.0k\/200k/);
  assert.match(joined, /ctx [▓░]{8} 8%/); // visual gauge precedes the percentage
  assert.match(joined, /turns 3/);
  assert.match(joined, /active 9s/);
  assert.match(joined, /agents 2/);
  assert.match(joined, /plan 1\/4/);
  assert.match(joined, /main\*/);      // dirty marker
});

test('buildFooterSegments flags blocked/failed workers with warning/error colour', () => {
  const segs = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 1,
    activeTurnMs: 1000, sessionMs: 5000,
    activeWorkers: 3, blockedWorkers: 1, failedWorkers: 2,
    planDone: 0, planTotal: 0, dirty: false,
  });
  const blocked = segs.find((s) => s.text.includes('⚠'));
  const failed = segs.find((s) => s.text.includes('✗'));
  assert.equal(blocked?.text, '⚠1');
  assert.equal(blocked?.token, 'warning');
  assert.equal(failed?.text, '✗2');
  assert.equal(failed?.token, 'error');
});

test('buildFooterSegments appends the current plan doing step, ellipsized', () => {
  const long = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 0,
    activeTurnMs: 0, sessionMs: 0, activeWorkers: 0,
    planDone: 2, planTotal: 5,
    planDoing: 'migrate renderers onto the shared palette module now',
    dirty: false,
  }).find((s) => s.text.startsWith('plan '))!;
  assert.match(long.text, /^plan 2\/5 ‣ /);
  assert.match(long.text, /…$/); // long label is truncated

  const short = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 0,
    activeTurnMs: 0, sessionMs: 0, activeWorkers: 0,
    planDone: 1, planTotal: 2, planDoing: 'edit footer',
    dirty: false,
  }).find((s) => s.text.startsWith('plan '))!;
  assert.equal(short.text, 'plan 1/2 ‣ edit footer');
});

test('buildFooterSegments omits optional segments cleanly', () => {
  const segs = buildFooterSegments({
    tokens: 0, contextWindow: 0, completedTurns: 0,
    activeTurnMs: undefined, lastTurnMs: 1200, sessionMs: 5000,
    activeWorkers: 0, planDone: 0, planTotal: 0, branch: undefined, dirty: false,
  });
  const joined = segs.map((s) => s.text).join(' | ');
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
