import { describe, expect, it } from 'vitest';

import {
  FooterWidget,
  type FooterSnapshot,
} from '../src/terminal/opentui/widgets/footer.js';

function footer(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
  return {
    authority: 'runtime',
    activeMode: 'chat',
    connection: 'connected',
    widthColumns: 100,
    keyHints: [
      { key: 'Ctrl+C', label: 'Cancel', priority: 0 },
      { key: 'Ctrl+P', label: 'Plan', priority: 1 },
      { key: 'Ctrl+S', label: 'Settings', priority: 2 },
    ],
    contextUsage: { used: 82, limit: 100 },
    ...overrides,
  };
}

describe('FooterWidget', () => {
  it('is a non-focusable class with literal render and instructions APIs', () => {
    const widget = new FooterWidget('footer-main', footer());

    expect(widget.capabilities).toEqual({ focusable: false, inputMode: 'none' });
    expect(widget.accessibility).toMatchObject({ role: 'contentinfo', liveRegion: 'polite' });
    expect(typeof widget.render).toBe('function');
    expect(Object.hasOwn(FooterWidget.prototype, 'render')).toBe(true);
    expect(() => widget.focus()).toThrow(/focusable/i);
  });

  it('rejects missing or forged authority before accepting footer claims', () => {
    const missingAuthority = {
      ...footer(),
      authority: undefined,
    } as unknown as FooterSnapshot;
    const forgedAuthority = {
      ...footer(),
      authority: 'model',
      connection: 'connected',
      contextUsage: { used: 1, limit: 100 },
      keyHints: [{ key: 'Ctrl+X', label: 'Trusted action' }],
    } as unknown as FooterSnapshot;

    expect(() => new FooterWidget('footer-missing-authority', missingAuthority))
      .toThrow(/runtime authority/i);
    expect(() => new FooterWidget('footer-forged-authority', forgedAuthority))
      .toThrow(/runtime authority/i);

    const widget = new FooterWidget('footer-update-authority', footer());
    expect(() => widget.update(forgedAuthority)).toThrow(/runtime authority/i);
    expect(widget.toPlainText()).toContain('Connection: CONNECTED');
    expect(widget.toPlainText()).not.toContain('Trusted action');
  });

  it('renders explicit mode, connection, truthful context warning, and canonical key hints', () => {
    const widget = new FooterWidget('footer-state', footer());
    widget.mount();
    widget.activate();

    const regions = widget.render().regions;
    const text = regions.map((region) => region.text).join('\n');
    expect(text).toContain('Mode: chat');
    expect(text).toContain('Connection: CONNECTED');
    expect(text).toContain('Context: WARNING 82% (82/100)');
    expect(text).toContain('Ctrl+C Cancel');
    expect(regions.find((region) => region.id === 'keys')?.role).toBe('help');
    expect(text).not.toMatch(/cost|\$/i);
  });

  it('preserves mode and connection first and drops lower-priority hints responsively', () => {
    const wide = new FooterWidget('footer-wide', footer({ widthColumns: 160 }));
    const narrow = new FooterWidget('footer-narrow', footer({ widthColumns: 34 }));

    const wideText = wide.render().regions.map((region) => region.text).join(' | ');
    const narrowText = narrow.render().regions.map((region) => region.text).join(' | ');
    expect(wideText).toContain('Ctrl+S Settings');
    expect(narrowText).toMatch(/^Mode: chat \| Connection: CONNECTED/u);
    expect(narrowText).not.toContain('Ctrl+S Settings');
  });

  it('never splits a Unicode grapheme when fitting narrow content', () => {
    const widget = new FooterWidget('footer-unicode', footer({
      activeMode: 'pairing-👩🏽‍💻-session',
      connection: 'connected',
      widthColumns: 35,
      keyHints: [{ key: '⌘K', label: 'Open 🧭 navigation', priority: 0 }],
    }));

    const text = widget.render().regions.map((region) => region.text).join(' | ');
    expect(text).not.toContain('\uFFFD');
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(text).not.toContain('👩🏽…');
  });

  it('announces only mode, connection, and material usage-threshold changes', () => {
    const widget = new FooterWidget('footer-announcements', footer({
      contextUsage: { used: 20, limit: 100 },
    }));
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(footer({ contextUsage: { used: 21, limit: 100 } }));
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(footer({ activeMode: 'plan', contextUsage: { used: 76, limit: 100 } }));
    expect(widget.takeAnnouncements()).toEqual([
      'Active mode changed to plan.',
      'Context usage entered warning at 76%.',
    ]);

    widget.update(footer({ activeMode: 'plan', connection: 'offline', contextUsage: { used: 81, limit: 100 } }));
    expect(widget.takeAnnouncements()).toEqual(['Connection state changed to offline.']);

    widget.update(footer({ activeMode: 'plan', connection: 'offline', contextUsage: { used: 91, limit: 100 } }));
    expect(widget.takeAnnouncements()).toEqual(['Context usage entered critical at 91%.']);
    expect(widget.takeAnnouncements()).toEqual([]);
  });

  it('provides complete linear alternate output with active keymap and warning', () => {
    const widget = new FooterWidget('footer-plain', footer({ widthColumns: 20 }));
    const text = widget.toPlainText();

    expect(text).toContain('Mode: chat');
    expect(text).toContain('Connection: CONNECTED');
    expect(text).toContain('Context: WARNING 82% (82/100)');
    expect(text).toContain('Active keys:');
    expect(text).toContain('- Ctrl+C: Cancel');
    expect(text).toContain('- Ctrl+P: Plan');
    expect(text).toContain('- Ctrl+S: Settings');
  });

  it('does not invent usage when both truthful counts are unavailable', () => {
    const widget = new FooterWidget('footer-no-usage', footer({ contextUsage: undefined }));
    expect(widget.toPlainText()).toContain('Context: unavailable');
    expect(widget.toPlainText()).not.toMatch(/\d+%/u);
  });

  it('sanitizes controls and rejects invalid bounds, usage, connection, and duplicate keys', () => {
    const safe = new FooterWidget('footer-safe', footer({
      activeMode: '\u001b[31mchat\u001b[0m\nforged\u202Ehidden',
      keyHints: [{ key: 'Ctrl+X\u0000\u2066', label: 'Close\nwindow\u200F', priority: 0 }],
    }));
    expect(safe.toPlainText()).toContain('Mode: chat forgedhidden');
    expect(safe.toPlainText()).toContain('- Ctrl+X: Close window');
    expect(safe.toPlainText()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(safe.toPlainText()).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u);

    expect(() => new FooterWidget('footer-width', footer({ widthColumns: 0 }))).toThrow(/width/i);
    expect(() => new FooterWidget('footer-usage', footer({ contextUsage: { used: 101, limit: 100 } })))
      .toThrow(/context usage/i);
    expect(() => new FooterWidget('footer-connection', footer({
      connection: 'invented' as FooterSnapshot['connection'],
    }))).toThrow(/connection/i);
    expect(() => new FooterWidget('footer-keys', footer({
      keyHints: [
        { key: 'Ctrl+C', label: 'Cancel' },
        { key: 'ctrl+c', label: 'Again' },
      ],
    }))).toThrow(/duplicate key/i);
  });

  it('documents truthful state, responsive priority, accessibility, and recovery', () => {
    const widget = new FooterWidget('footer-instructions', footer());
    expect(widget.instructions).toMatchObject({
      purpose: expect.stringMatching(/footer/i),
      stateAndOutput: expect.arrayContaining([
        expect.stringMatching(/mode.*connection/i),
        expect.stringMatching(/never fabricate/i),
      ]),
      accessibility: expect.arrayContaining([
        expect.stringMatching(/color/i),
        expect.stringMatching(/linear/i),
        expect.stringMatching(/grapheme/i),
      ]),
      recovery: expect.arrayContaining([
        expect.stringMatching(/unavailable/i),
      ]),
    });
  });
});
