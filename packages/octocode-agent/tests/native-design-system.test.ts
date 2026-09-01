import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  NATIVE_BROWSER_TYPOGRAPHY,
  NATIVE_DESIGN_CONTENT,
  NATIVE_DESIGN_LAYOUT,
  NATIVE_DESIGN_PALETTES,
  nativeBrowserTypographyCssVariables,
  nativeDesignCssVariables,
  nativeColorEnabledFromEnvironment,
} from '../src/presentation/design/tokens.js';
import { OPEN_TUI_THEMES } from '../src/terminal/opentui/theme.js';

describe('native presentation design system', () => {
  it('is the single palette source for terminal and browser adapters', () => {
    expect(OPEN_TUI_THEMES.dark.colors).toBe(NATIVE_DESIGN_PALETTES.dark);
    expect(OPEN_TUI_THEMES.light.colors).toBe(NATIVE_DESIGN_PALETTES.light);
    expect(nativeDesignCssVariables('dark')).toContain(
      `--octocode-background:${NATIVE_DESIGN_PALETTES.dark.background}`,
    );
    expect(nativeDesignCssVariables('light')).toContain(
      `--octocode-text:${NATIVE_DESIGN_PALETTES.light.text}`,
    );
  });

  it('disables automatic color for NO_COLOR, dumb terminals, and non-TTY output', () => {
    expect(nativeColorEnabledFromEnvironment({ NO_COLOR: '1' }, { isTty: true })).toBe(false);
    expect(nativeColorEnabledFromEnvironment({ NO_COLOR: '' }, { isTty: true })).toBe(true);
    expect(nativeColorEnabledFromEnvironment({ TERM: 'dumb' }, { isTty: true })).toBe(false);
    expect(nativeColorEnabledFromEnvironment({}, { isTty: false })).toBe(false);
  });

  it('keeps non-empty FORCE_COLOR as the explicit highest-precedence override', () => {
    expect(nativeColorEnabledFromEnvironment(
      { NO_COLOR: '1', TERM: 'dumb', FORCE_COLOR: '1' },
      { isTty: false },
    )).toBe(true);
  });

  it('owns browser typography without claiming terminal font control', () => {
    expect(NATIVE_BROWSER_TYPOGRAPHY.sansFontStack).toContain('system-ui');
    expect(NATIVE_BROWSER_TYPOGRAPHY.monospaceFontStack).toContain('monospace');
    expect(nativeBrowserTypographyCssVariables()).toContain(
      `--octocode-font-sans:${NATIVE_BROWSER_TYPOGRAPHY.sansFontStack}`,
    );
    expect(nativeBrowserTypographyCssVariables()).toContain('--octocode-font-size:14px');
  });

  it('owns shared responsive thresholds and interaction content', () => {
    expect(NATIVE_DESIGN_LAYOUT.wideColumns).toBeGreaterThanOrEqual(72);
    expect(NATIVE_DESIGN_LAYOUT.minimumActivityRows).toBeGreaterThan(0);
    expect(NATIVE_DESIGN_CONTENT.composerPlaceholder).toMatch(/Octocode/u);
    expect(NATIVE_DESIGN_CONTENT.thinking).toBe('Thinking…');
    expect(NATIVE_DESIGN_CONTENT.shortcutOverlayKey).toBe('?');
  });

  it('keeps browser color literals inside the shared token owner', () => {
    const source = readFileSync(new URL('../src/native-settings-page.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/#[0-9a-f]{6,8}\b/iu);
  });
});
