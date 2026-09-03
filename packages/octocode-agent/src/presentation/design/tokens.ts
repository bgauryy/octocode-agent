export type NativeDesignThemeMode = 'dark' | 'light';

export interface NativeDesignPalette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly info: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly border: string;
  readonly focus: string;
  readonly selectionText: string;
  readonly selectionBackground: string;
  readonly path: string;
  readonly code: string;
  readonly link: string;
  readonly count: string;
  readonly diffAdded: string;
  readonly diffRemoved: string;
  readonly diffContext: string;
}

const dark: NativeDesignPalette = Object.freeze({
  background: '#0b0f14', surface: '#111820', surfaceRaised: '#17212b',
  text: '#f2f4f7', muted: '#aeb7c2', accent: '#63b3ff', info: '#72c7ff',
  success: '#70d69b', warning: '#ffd166', error: '#ff858f', border: '#8491a1',
  focus: '#91c9ff', selectionText: '#ffffff', selectionBackground: '#285b85',
  path: '#9ac6ff', code: '#e6b673', link: '#72c7ff', count: '#d2a8ff',
  diffAdded: '#70d69b', diffRemoved: '#ff858f', diffContext: '#aeb7c2',
});

const light: NativeDesignPalette = Object.freeze({
  background: '#fcfcfd', surface: '#f4f6f8', surfaceRaised: '#e9eef3',
  text: '#18202a', muted: '#52606d', accent: '#075ea8', info: '#075a9c',
  success: '#176b3a', warning: '#7a4b00', error: '#a61b29', border: '#596574',
  focus: '#005a9c', selectionText: '#102a43', selectionBackground: '#cde7ff',
  path: '#174f8a', code: '#7a4b00', link: '#075a9c', count: '#6b2da8',
  diffAdded: '#176b3a', diffRemoved: '#a61b29', diffContext: '#52606d',
});

export const NATIVE_DESIGN_PALETTES: Readonly<Record<NativeDesignThemeMode, NativeDesignPalette>> =
  Object.freeze({ dark, light });

/** Browser-only typography tokens. Terminal font selection remains emulator-owned. */
export const NATIVE_BROWSER_TYPOGRAPHY = Object.freeze({
  sansFontStack: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  monospaceFontStack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  baseFontSizePx: 14,
  lineHeight: 1.5,
});

export const NATIVE_DESIGN_LAYOUT = Object.freeze({
  wideColumns: 72,
  shortRows: 24,
  minimumActivityRows: 4,
  maximumActionRows: 8,
  composerRows: 3,
  composerHelpRows: 1,
  fixedChromeRows: 4,
});

export const NATIVE_DESIGN_CONTENT = Object.freeze({
  composerPlaceholder: 'What should I work on?',
  composerHelp: '› Ask Octocode  ·  Enter send · Shift+Enter newline · / commands · @ files',
  activityTab: 'Activity',
  contextTab: 'Context',
  thinking: 'Thinking…',
  shortcutOverlayKey: '?',
  settingsOpening: 'Opening the secure local settings page in your browser…',
  shortcutHelp: [
    'Shortcuts',
    'Tab / Shift-Tab  Move focus',
    'Left / Right     Change Activity or Context when its tabs are focused',
    'Enter            Send message',
    'Shift+Enter      Insert newline',
    'Esc              Close overlay or cancel the current action',
    'Ctrl-C           Interrupt active work',
    '?                Close this help',
  ] as const,
});

const CSS_VARIABLES: Readonly<Record<keyof NativeDesignPalette, string>> = Object.freeze({
  background: 'background', surface: 'surface', surfaceRaised: 'surface-raised',
  text: 'text', muted: 'muted', accent: 'accent', info: 'info', success: 'success',
  warning: 'warning', error: 'error', border: 'border', focus: 'focus',
  selectionText: 'selection-text', selectionBackground: 'selection-background',
  path: 'path', code: 'code', link: 'link', count: 'count', diffAdded: 'diff-added',
  diffRemoved: 'diff-removed', diffContext: 'diff-context',
});

export function nativeDesignCssVariables(mode: NativeDesignThemeMode): string {
  const palette = NATIVE_DESIGN_PALETTES[mode];
  return (Object.keys(CSS_VARIABLES) as (keyof NativeDesignPalette)[])
    .map((key) => `--octocode-${CSS_VARIABLES[key]}:${palette[key]}`)
    .join(';');
}

export function nativeBrowserTypographyCssVariables(): string {
  return [
    `--octocode-font-sans:${NATIVE_BROWSER_TYPOGRAPHY.sansFontStack}`,
    `--octocode-font-mono:${NATIVE_BROWSER_TYPOGRAPHY.monospaceFontStack}`,
    `--octocode-font-size:${NATIVE_BROWSER_TYPOGRAPHY.baseFontSizePx}px`,
    `--octocode-line-height:${NATIVE_BROWSER_TYPOGRAPHY.lineHeight}`,
  ].join(';');
}

export function nativeColorEnabledFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  output: { readonly isTty?: boolean } = {},
): boolean {
  if ((env.FORCE_COLOR ?? '').length > 0) return true;
  if ((env.NO_COLOR ?? '').length > 0) return false;
  if ((env.TERM ?? '').trim().toLowerCase() === 'dumb') return false;
  return output.isTty ?? process.stdout.isTTY === true;
}
