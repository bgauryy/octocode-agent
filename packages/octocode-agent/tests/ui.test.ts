import { describe, it, expect } from 'vitest';
import {
  banner,
  BRAND_MARK,
  BRAND_NAME,
  checkLines,
  cmdRows,
  colorEnabled,
  diagLine,
  header,
  hint,
  kv,
  launchBanner,
  makePainter,
  padEndVisible,
  section,
  stripAnsi,
  visibleLength,
} from '../src/ui.js';

describe('colorEnabled', () => {
  it('is off when NO_COLOR is set', () => {
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
  });
  it('is on when FORCE_COLOR is set, even without a TTY', () => {
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
  });
  it('is off for a dumb terminal', () => {
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false);
  });
  it('follows TTY detection otherwise', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });
});

describe('makePainter', () => {
  it('is identity when disabled', () => {
    const p = makePainter(false);
    expect(p.green('x')).toBe('x');
    expect(p.bold('y')).toBe('y');
    expect(p.brand('z')).toBe('z');
    expect(p.accent('w')).toBe('w');
    expect(p.gray('v')).toBe('v');
  });
  it('wraps with ANSI when enabled and stripAnsi reverses it', () => {
    const p = makePainter(true);
    const painted = p.red('err');
    expect(painted).not.toBe('err');
    expect(stripAnsi(painted)).toBe('err');
  });
  it('paints brand and accent with distinct codes', () => {
    const p = makePainter(true);
    expect(p.brand('x')).not.toBe(p.accent('x'));
  });
});

describe('banner', () => {
  it('mentions the brand', () => {
    expect(stripAnsi(banner(makePainter(false), 'doctor'))).toContain('octocode-agent');
  });
});

describe('visibleLength / padEndVisible', () => {
  it('measures visible length ignoring ANSI codes', () => {
    const p = makePainter(true);
    expect(visibleLength(p.red('abc'))).toBe(3);
  });
  it('pads to the visible width so colored cells still align', () => {
    const p = makePainter(true);
    const colored = padEndVisible(p.red('ab'), 5);
    expect(visibleLength(colored)).toBe(5);
    expect(stripAnsi(colored)).toBe('ab   ');
  });
  it('never truncates a value wider than the column', () => {
    expect(padEndVisible('extra-long', 3)).toBe('extra-long');
  });
});

describe('header', () => {
  it('renders brand mark, space-joined name, and a rule', () => {
    const text = stripAnsi(header(makePainter(false), 'doctor'));
    const lines = text.split('\n');
    expect(lines[1]).toBe(`${BRAND_MARK} ${BRAND_NAME} doctor`);
    expect(lines[2]).toMatch(/^─+$/);
  });
  it('omits the name separator for the bare scenes', () => {
    const text = stripAnsi(header(makePainter(false), ''));
    expect(text.split('\n')[1]).toBe(`${BRAND_MARK} ${BRAND_NAME}`);
  });
});

describe('section / kv / hint', () => {
  const p = makePainter(false);
  it('section renders the title', () => {
    expect(section(p, 'Get started')).toBe('Get started');
  });
  it('kv aligns the key column to the given width', () => {
    expect(kv(p, 'core', '1.3.0')).toBe('core               1.3.0');
  });
  it('hint prefixes an arrow', () => {
    expect(hint(p, 'next step')).toBe('→ next step');
  });
});

describe('checkLines', () => {
  const p = makePainter(false);
  it('renders ok, fail, and warn glyphs with aligned labels', () => {
    expect(checkLines(p, 'ok', 'core', '1.3.0')[0]).toBe('✓ core         1.3.0');
    expect(checkLines(p, 'fail', 'core', 'missing')[0]).toMatch(/^✗ core/);
    expect(checkLines(p, 'warn', 'auth', 'no keys')[0]).toMatch(/^! auth/);
  });
  it('adds a fix continuation line only for failures with a fix', () => {
    expect(checkLines(p, 'fail', 'core', 'missing', 'update core')).toHaveLength(2);
    expect(checkLines(p, 'fail', 'core', 'missing', 'update core')[1]).toContain(
      'fix: update core',
    );
    expect(checkLines(p, 'ok', 'core', '1.3.0', 'ignored')).toHaveLength(1);
  });
});

describe('cmdRows', () => {
  it('aligns descriptions across uneven command names', () => {
    const rows = cmdRows(makePainter(false), [
      ['run', 'headless'],
      ['completion <shell>', 'print script'],
    ]);
    expect(rows[0]).toBe('  run                 headless');
    expect(rows[1]).toBe('  completion <shell>  print script');
  });
});

describe('launchBanner', () => {
  it('shows the brand and the known version parts', () => {
    const text = stripAnsi(
      launchBanner(makePainter(false), { launcher: '1.0.2', core: '1.3.0', pi: '0.80.3' }),
    );
    expect(text).toBe(`${BRAND_MARK} ${BRAND_NAME}  v1.0.2 · core 1.3.0 · pi 0.80.3`);
  });
  it('skips unknown parts without dangling separators', () => {
    const text = stripAnsi(
      launchBanner(makePainter(false), { launcher: null, core: '1.3.0', pi: null }),
    );
    expect(text).toBe(`${BRAND_MARK} ${BRAND_NAME}  core 1.3.0`);
  });
});

describe('diagLine', () => {
  it('keeps the brand prefix shape and the full message', () => {
    expect(stripAnsi(diagLine(makePainter(true), 'octocode-agent: boom'))).toBe(
      'octocode-agent: boom',
    );
    expect(stripAnsi(diagLine(makePainter(true), 'boom'))).toBe('octocode-agent: boom');
  });
});
