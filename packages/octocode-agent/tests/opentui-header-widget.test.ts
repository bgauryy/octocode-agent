import { describe, expect, it, vi } from 'vitest';

import {
  HeaderWidget,
  type HeaderSnapshot,
} from '../src/terminal/opentui/widgets/header.js';

function header(overrides: Partial<HeaderSnapshot> = {}): HeaderSnapshot {
  return {
    authority: 'runtime',
    title: 'Octocode',
    sessionId: 'session-123',
    modelId: 'openai/gpt-5.6',
    trust: 'trusted',
    working: 'idle',
    width: 120,
    ...overrides,
  };
}

describe('HeaderWidget', () => {
  it('renders one canonical, color-independent line with non-focusable region semantics', () => {
    const widget = new HeaderWidget('header-main', header());
    widget.mount();
    widget.activate();

    const rendered = widget.render();
    const line = rendered.regions[0]?.text ?? '';

    expect(rendered).toMatchObject({
      kind: 'header',
      focused: false,
      capabilities: { focusable: false, inputMode: 'none' },
      accessibility: { role: 'banner', liveRegion: 'polite' },
    });
    expect(rendered.regions).toHaveLength(1);
    expect(line).toContain('Octocode');
    expect(line).toContain('IDLE');
    expect(line).toContain('trust TRUSTED');
    expect(line).toContain('model openai/gpt-5.6');
    expect(line).toContain('session session-123');
    expect(line).not.toContain('\n');
    expect(line).not.toMatch(/\u001b/u);
  });

  it('drops lower-priority session and model details before trust and working state on narrow terminals', () => {
    const widget = new HeaderWidget('header-narrow', header({
      title: 'Octocode 👩🏽‍💻',
      modelId: 'provider/extremely-long-model-name',
      sessionId: 'session-with-a-very-long-canonical-identifier',
      width: 39,
    }));

    const line = widget.render().regions[0]?.text ?? '';
    expect(line).toContain('trust TRUSTED');
    expect(line).toContain('IDLE');
    expect(line).not.toContain('session ');
    expect(line).not.toContain('model ');
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(HeaderWidget.displayWidth(line)).toBeLessThanOrEqual(39);
  });

  it('truncates only at grapheme boundaries and respects terminal column width', () => {
    const widget = new HeaderWidget('header-graphemes', header({
      title: '👩🏽‍💻👩🏽‍💻👩🏽‍💻 café',
      width: 15,
    }));

    const line = widget.render().regions[0]?.text ?? '';
    expect(HeaderWidget.displayWidth(line)).toBeLessThanOrEqual(15);
    expect(line).not.toMatch(/\p{Mark}$/u);
    expect(line).not.toMatch(/\u200d$/u);
    expect(line).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it('provides complete, untruncated alternate text independent of the viewport', () => {
    const widget = new HeaderWidget('header-alternate', header({
      title: 'A long canonical title',
      modelId: 'provider/model-with-a-long-name',
      sessionId: 'session-with-a-long-id',
      width: 12,
    }));

    const visible = widget.render().regions[0]?.text ?? '';
    const alternate = widget.toPlainText();
    expect(HeaderWidget.displayWidth(visible)).toBeLessThanOrEqual(12);
    expect(alternate).toContain('A long canonical title');
    expect(alternate).toContain('provider/model-with-a-long-name');
    expect(alternate).toContain('session-with-a-long-id');
    expect(alternate).toContain('trust TRUSTED');
    expect(alternate).toContain('IDLE');
  });

  it('strips terminal controls, collapses multiline values, and rejects invalid bounds or authority', () => {
    const widget = new HeaderWidget('header-safe', header({
      title: '\u001b]0;forged title\u0007Octo\ncode\u001b[2J',
      sessionId: 'session\r\n123',
      modelId: '\u001bPforged-device-command\u001b\\\u202emodel\u001b[0m',
    }));
    const text = widget.toPlainText();

    expect(text).toContain('Octo code');
    expect(text).toContain('session session 123');
    expect(text).toContain('model model');
    expect(text).not.toContain('forged title');
    expect(text).not.toContain('forged-device-command');
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(() => new HeaderWidget('header-width', header({ width: 0 }))).toThrow(/width/i);
    expect(() => new HeaderWidget('header-authority', header({
      authority: 'agent' as HeaderSnapshot['authority'],
    }))).toThrow(/runtime authority/i);
  });

  it('announces only material session, model, and trust changes, never renders or cosmetic state', () => {
    const widget = new HeaderWidget('header-announcements', header());

    expect(widget.takeAnnouncements()).toEqual([]);
    widget.render();
    widget.render();
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(header({ working: 'active', title: 'Octocode Agent', width: 80 }));
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(header({
      title: 'Octocode Agent',
      working: 'active',
      sessionId: 'session-456',
      modelId: 'openai/gpt-6',
      trust: 'untrusted',
      width: 80,
    }));
    expect(widget.takeAnnouncements()).toEqual([
      'Session changed to session-456.',
      'Model changed to openai/gpt-6.',
      'Workspace trust changed to UNTRUSTED.',
    ]);
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(header({
      title: 'Octocode Agent',
      working: 'active',
      sessionId: 'session-456',
      modelId: 'openai/gpt-6',
      trust: 'untrusted',
      width: 79,
    }));
    expect(widget.takeAnnouncements()).toEqual([]);
  });

  it('exposes literal render and complete agent instructions', () => {
    const widget = new HeaderWidget('header-instructions', header());
    const adapter = { render: vi.fn(), destroy: vi.fn() };

    const state = widget.render(adapter);
    expect(Object.prototype.hasOwnProperty.call(HeaderWidget.prototype, 'render')).toBe(true);
    expect(typeof widget.render).toBe('function');
    expect(adapter.render).toHaveBeenCalledWith(state);
    expect(widget.instructions).toMatchObject({
      purpose: expect.stringMatching(/canonical.*header/i),
      inputs: expect.arrayContaining([
        expect.stringMatching(/runtime.*authority/i),
        expect.stringMatching(/trust/i),
      ]),
      stateAndOutput: expect.arrayContaining([
        expect.stringMatching(/session.*model.*trust/i),
      ]),
      accessibility: expect.arrayContaining([
        expect.stringMatching(/color/i),
        expect.stringMatching(/alternate/i),
      ]),
      recovery: expect.arrayContaining([
        expect.stringMatching(/reject.*agent/i),
      ]),
    });
  });
});
