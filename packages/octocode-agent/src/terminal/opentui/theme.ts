export type OpenTuiThemeMode = 'dark' | 'light';
export type OpenTuiColorMode = 'truecolor' | 'ansi16' | 'none';
export type OpenTuiSemanticRole =
  | 'text'
  | 'muted'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'border'
  | 'focus'
  | 'selection'
  | 'path'
  | 'code'
  | 'link'
  | 'count'
  | 'diffAdded'
  | 'diffRemoved'
  | 'diffContext';

export interface OpenTuiThemeColors {
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

export interface OpenTuiTheme {
  readonly mode: OpenTuiThemeMode;
  readonly colors: OpenTuiThemeColors;
}

export interface ResolvedOpenTuiRole {
  readonly foreground?: string;
  readonly background?: string;
  /** A concise visible cue; semantic state must never depend on color alone. */
  readonly marker: string;
  /** A stable text equivalent suitable for alternate or screen-reader output. */
  readonly label: string;
  readonly bold: boolean;
  readonly underline: boolean;
}

const darkColors: OpenTuiThemeColors = Object.freeze({
  background: '#0b0f14',
  surface: '#111820',
  surfaceRaised: '#17212b',
  text: '#f2f4f7',
  muted: '#aeb7c2',
  accent: '#63b3ff',
  info: '#72c7ff',
  success: '#70d69b',
  warning: '#ffd166',
  error: '#ff858f',
  border: '#8491a1',
  focus: '#91c9ff',
  selectionText: '#ffffff',
  selectionBackground: '#285b85',
  path: '#9ac6ff',
  code: '#e6b673',
  link: '#72c7ff',
  count: '#d2a8ff',
  diffAdded: '#70d69b',
  diffRemoved: '#ff858f',
  diffContext: '#aeb7c2',
});

const lightColors: OpenTuiThemeColors = Object.freeze({
  background: '#fcfcfd',
  surface: '#f4f6f8',
  surfaceRaised: '#e9eef3',
  text: '#18202a',
  muted: '#52606d',
  accent: '#075ea8',
  info: '#075a9c',
  success: '#176b3a',
  warning: '#7a4b00',
  error: '#a61b29',
  border: '#596574',
  focus: '#005a9c',
  selectionText: '#102a43',
  selectionBackground: '#cde7ff',
  path: '#174f8a',
  code: '#7a4b00',
  link: '#075a9c',
  count: '#6b2da8',
  diffAdded: '#176b3a',
  diffRemoved: '#a61b29',
  diffContext: '#52606d',
});

/** Accessible, immutable palettes for terminal background preference. */
export const OPEN_TUI_THEMES: Readonly<Record<OpenTuiThemeMode, OpenTuiTheme>> = Object.freeze({
  dark: Object.freeze({ mode: 'dark', colors: darkColors }),
  light: Object.freeze({ mode: 'light', colors: lightColors }),
});

interface RoleCue {
  readonly marker: string;
  readonly label: string;
  readonly bold: boolean;
  readonly underline: boolean;
}

const roleCues: Readonly<Record<OpenTuiSemanticRole, RoleCue>> = Object.freeze({
  text: Object.freeze({ marker: 'T', label: 'text', bold: false, underline: false }),
  muted: Object.freeze({ marker: '·', label: 'muted', bold: false, underline: false }),
  accent: Object.freeze({ marker: '◆', label: 'accent', bold: true, underline: false }),
  info: Object.freeze({ marker: 'i', label: 'info', bold: false, underline: false }),
  success: Object.freeze({ marker: '✓', label: 'success', bold: true, underline: false }),
  warning: Object.freeze({ marker: '!', label: 'warning', bold: true, underline: false }),
  error: Object.freeze({ marker: '×', label: 'error', bold: true, underline: false }),
  border: Object.freeze({ marker: '|', label: 'border', bold: false, underline: false }),
  focus: Object.freeze({ marker: '>', label: 'focus', bold: true, underline: true }),
  selection: Object.freeze({ marker: '*', label: 'selected', bold: true, underline: false }),
  path: Object.freeze({ marker: '/', label: 'path', bold: false, underline: false }),
  code: Object.freeze({ marker: '`', label: 'code', bold: false, underline: false }),
  link: Object.freeze({ marker: '↗', label: 'link', bold: false, underline: true }),
  count: Object.freeze({ marker: '#', label: 'count', bold: true, underline: false }),
  diffAdded: Object.freeze({ marker: '+', label: 'added', bold: true, underline: false }),
  diffRemoved: Object.freeze({ marker: '−', label: 'removed', bold: true, underline: false }),
  diffContext: Object.freeze({ marker: '@', label: 'context', bold: false, underline: false }),
});

const ansi16Foreground: Readonly<Record<OpenTuiSemanticRole, string>> = Object.freeze({
  text: 'white',
  muted: 'gray',
  accent: 'cyan',
  info: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  border: 'gray',
  focus: 'cyan',
  selection: 'white',
  path: 'blue',
  code: 'yellow',
  link: 'cyan',
  count: 'magenta',
  diffAdded: 'green',
  diffRemoved: 'red',
  diffContext: 'gray',
});

function parseHexColor(color: string): readonly [number, number, number] {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new TypeError(`Expected a six-digit hex color, received ${JSON.stringify(color)}`);
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function relativeLuminance(color: string): number {
  const channels = parseHexColor(color).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]!) + (0.7152 * channels[1]!) + (0.0722 * channels[2]!);
}

/** WCAG relative-luminance contrast ratio in the inclusive range 1..21. */
export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function truecolorForRole(
  role: OpenTuiSemanticRole,
  colors: OpenTuiThemeColors,
): Pick<ResolvedOpenTuiRole, 'foreground' | 'background'> {
  if (role === 'selection') {
    return { foreground: colors.selectionText, background: colors.selectionBackground };
  }
  return { foreground: colors[role] };
}

/** Resolves color plus redundant text/shape cues for a terminal's color capability. */
export function resolveOpenTuiRole(
  role: OpenTuiSemanticRole,
  options: { readonly mode: OpenTuiThemeMode; readonly colorMode: OpenTuiColorMode },
): ResolvedOpenTuiRole {
  const cue = roleCues[role];
  const base = {
    marker: cue.marker,
    label: cue.label,
    bold: cue.bold,
    underline: cue.underline,
  };
  if (options.colorMode === 'none') return base;
  if (options.colorMode === 'ansi16') {
    return {
      ...base,
      foreground: ansi16Foreground[role],
      ...(role === 'selection' ? { background: 'blue' } : {}),
    };
  }
  return { ...base, ...truecolorForRole(role, OPEN_TUI_THEMES[options.mode].colors) };
}
