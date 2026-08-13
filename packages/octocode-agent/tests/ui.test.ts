import { describe, it, expect, afterEach } from 'vitest';
import {
  banner,
  BRAND_MARK,
  BRAND_NAME,
  checkLines,
  cmdRows,
  colorEnabled,
  diagLine,
  ellipsizeEnd,
  ellipsizeMiddle,
  fitText,
  header,
  hint,
  kv,
  launchBanner,
  link,
  makePainter,
  padEndVisible,
  rule,
  section,
  stripAnsi,
  terminalWidth,
  tildePath,
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

describe('width-aware layer', () => {
  afterEach(() => {
    delete process.env.COLUMNS;
  });

  it('terminalWidth honors COLUMNS and clamps to sane bounds', () => {
    delete process.env.COLUMNS;
    expect(terminalWidth()).toBeGreaterThanOrEqual(40);
    process.env.COLUMNS = '10';
    expect(terminalWidth()).toBe(40);
    process.env.COLUMNS = '5000';
    expect(terminalWidth()).toBe(200);
    process.env.COLUMNS = '120';
    expect(terminalWidth()).toBe(120);
  });

  it('ellipsizeEnd truncates exactly to the visible budget', () => {
    expect(ellipsizeEnd('hello world', 6)).toBe('hello…');
    expect(visibleLength(ellipsizeEnd('hello world', 6))).toBe(6);
    expect(ellipsizeEnd('hi', 6)).toBe('hi');
    expect(ellipsizeEnd('x', 1)).toBe('x');
  });

  it('ellipsizeMiddle keeps head and tail at 60/40', () => {
    const out = ellipsizeMiddle('/a/very/long/path/to/some/place/deep', 20);
    expect(visibleLength(out)).toBe(20);
    expect(out.startsWith('/a/')).toBe(true);
    expect(out.endsWith('deep')).toBe(true);
    expect(out).toContain('…');
  });

  it('tildePath collapses the home prefix only', () => {
    expect(tildePath('/home/u/.pi/agent', '/home/u')).toBe('~/.pi/agent');
    expect(tildePath('/home/u', '/home/u')).toBe('~');
    expect(tildePath('/var/tmp/x', '/home/u')).toBe('/var/tmp/x');
  });

  it('fitText middle-collapses paths, tail-collapses prose', () => {
    const pathOut = fitText('/x/y/z/aaaaaaaaaaaaaaaaaaaa/w', 12);
    expect(pathOut).toContain('…');
    expect(pathOut.startsWith('/x')).toBe(true);
    const proseOut = fitText('the quick brown fox jumps over', 12);
    expect(proseOut.endsWith('…')).toBe(true);
  });

  it('link emits OSC-8 only when interactive+painted; plain fallback keeps info', () => {
    const p = makePainter(true);
    expect(link(p, 'https://x.io', 'x.io', true)).toContain('\x1b]8;;https://x.io');
    expect(stripAnsi(link(p, 'https://x.io', 'x.io', true))).toBe('x.io');
    expect(link(p, 'https://x.io', 'x.io', false)).toBe('x.io (https://x.io)');
  });

  it('stripAnsi removes OSC-8 sequences for correct width math', () => {
    const linked = link(makePainter(true), 'https://example.com', 'example', true);
    expect(visibleLength(linked)).toBe(7);
  });

  it('rule adapts to narrow terminals', () => {
    process.env.COLUMNS = '50';
    expect(visibleLength(rule(makePainter(false)))).toBe(48);
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
