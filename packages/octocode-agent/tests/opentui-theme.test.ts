import { describe, expect, it } from 'vitest';

import {
  OPEN_TUI_THEMES,
  contrastRatio,
  resolveOpenTuiRole,
  type OpenTuiSemanticRole,
} from '../src/terminal/opentui/theme.js';

const semanticRoles: readonly OpenTuiSemanticRole[] = [
  'text',
  'muted',
  'accent',
  'info',
  'success',
  'warning',
  'error',
  'border',
  'focus',
  'selection',
  'path',
  'code',
  'link',
  'count',
  'diffAdded',
  'diffRemoved',
  'diffContext',
];

describe('OpenTUI theme', () => {
  it('calculates WCAG contrast deterministically', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#0b0f14', '#F2F4F7'))
      .toBeCloseTo(contrastRatio('#F2F4F7', '#0B0F14'), 10);
    expect(() => contrastRatio('red', '#ffffff')).toThrow(/hex color/i);
  });

  it.each(['dark', 'light'] as const)(
    '%s mode keeps normal text at 4.5:1 and accents or boundaries at 3:1',
    (mode) => {
      const { colors } = OPEN_TUI_THEMES[mode];

      for (const background of [colors.background, colors.surface, colors.surfaceRaised]) {
        expect(contrastRatio(colors.text, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.muted, background)).toBeGreaterThanOrEqual(4.5);
        for (const foreground of [
          colors.accent,
          colors.info,
          colors.success,
          colors.warning,
          colors.error,
          colors.border,
          colors.focus,
          colors.path,
          colors.code,
          colors.link,
          colors.count,
          colors.diffAdded,
          colors.diffRemoved,
          colors.diffContext,
        ]) {
          expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
        }
      }

      expect(contrastRatio(colors.selectionText, colors.selectionBackground))
        .toBeGreaterThanOrEqual(4.5);
    },
  );

  it('exposes the same stable semantic roles in both modes', () => {
    expect(Object.keys(OPEN_TUI_THEMES.dark.colors))
      .toEqual(Object.keys(OPEN_TUI_THEMES.light.colors));

    for (const mode of ['dark', 'light'] as const) {
      for (const role of semanticRoles) {
        const resolved = resolveOpenTuiRole(role, { mode, colorMode: 'truecolor' });
        expect(resolved.label).not.toHaveLength(0);
        expect(resolved.marker).not.toHaveLength(0);
        expect(resolved.foreground).toMatch(/^#[0-9a-f]{6}$/iu);
      }
    }
  });

  it('maps semantic roles to the ANSI-16 vocabulary without losing textual cues', () => {
    for (const role of semanticRoles) {
      const resolved = resolveOpenTuiRole(role, { mode: 'dark', colorMode: 'ansi16' });
      expect(resolved.foreground).toMatch(/^(?:black|red|green|yellow|blue|magenta|cyan|white|gray)$/u);
      expect(resolved.label).not.toHaveLength(0);
      expect(resolved.marker).not.toHaveLength(0);
    }
  });

  it('keeps every role legible and distinguishable when color is disabled', () => {
    const resolved = semanticRoles.map((role) => resolveOpenTuiRole(role, {
      mode: 'dark',
      colorMode: 'none',
    }));

    expect(resolved.every(({ foreground, background }) => (
      foreground === undefined && background === undefined
    ))).toBe(true);
    expect(new Set(resolved.map(({ label }) => label)).size).toBe(semanticRoles.length);
    expect(new Set(resolved.map(({ marker }) => marker)).size).toBe(semanticRoles.length);
  });
});
