import {
  NATIVE_DESIGN_PALETTES,
  type NativeDesignPalette,
  type NativeDesignThemeMode,
} from '../../presentation/design/tokens.js';
import {
  NATIVE_DESIGN_TONE_CUES,
  type NativeDesignTone,
} from '../../presentation/design/semantics.js';

export type OpenTuiThemeMode = NativeDesignThemeMode;
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

export type OpenTuiThemeColors = NativeDesignPalette;

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

/** Accessible, immutable palettes for terminal background preference. */
export const OPEN_TUI_THEMES: Readonly<Record<OpenTuiThemeMode, OpenTuiTheme>> = Object.freeze({
  dark: Object.freeze({ mode: 'dark', colors: NATIVE_DESIGN_PALETTES.dark }),
  light: Object.freeze({ mode: 'light', colors: NATIVE_DESIGN_PALETTES.light }),
});

interface RoleCue {
  readonly marker: string;
  readonly label: string;
  readonly bold: boolean;
  readonly underline: boolean;
}

function designToneCue(
  tone: NativeDesignTone,
  attributes: Pick<RoleCue, 'bold' | 'underline'>,
): RoleCue {
  return Object.freeze({ ...NATIVE_DESIGN_TONE_CUES[tone], ...attributes });
}

const roleCues: Readonly<Record<OpenTuiSemanticRole, RoleCue>> = Object.freeze({
  text: Object.freeze({ marker: 'T', label: 'text', bold: false, underline: false }),
  muted: Object.freeze({ marker: '·', label: 'muted', bold: false, underline: false }),
  accent: Object.freeze({ marker: '◆', label: 'accent', bold: true, underline: false }),
  info: designToneCue('info', { bold: false, underline: false }),
  success: designToneCue('success', { bold: true, underline: false }),
  warning: designToneCue('warning', { bold: true, underline: false }),
  error: designToneCue('error', { bold: true, underline: false }),
  border: Object.freeze({ marker: '|', label: 'border', bold: false, underline: false }),
  focus: Object.freeze({ marker: '>', label: 'focus', bold: true, underline: true }),
  selection: Object.freeze({ marker: '*', label: 'selected', bold: true, underline: false }),
  path: Object.freeze({ marker: '/', label: 'path', bold: false, underline: false }),
  code: Object.freeze({ marker: '`', label: 'code', bold: false, underline: false }),
  link: Object.freeze({ marker: '↗', label: 'link', bold: false, underline: true }),
  count: designToneCue('count', { bold: true, underline: false }),
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
