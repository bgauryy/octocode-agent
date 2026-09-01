import { fitTerminalText, terminalDisplayWidth } from '../widgets/layout.js';

export const OCTOCODE_WORDMARK: readonly string[] = Object.freeze([
  '██████╗  ██████╗████████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗   ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔═══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝  ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║█████╗    ██║     ██║   ██║██║  ██║█████╗',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║██╔══╝    ██║     ██║   ██║██║  ██║██╔══╝',
  '╚██████╔╝╚██████╗   ██║   ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗  ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═════╝  ╚═════╝   ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]);

export const OCTOCODE_TAGLINE = 'Your AI coding agent';
export const OCTOCODE_BETA_NOTICE = 'BETA VERSION · for issues: https://github.com/bgauryy/octocode-agent/issues';
export const OCTOCODE_COMPACT_MARK = '🔍🐙 Octocode';

export const OCTOCODE_WORDMARK_WIDTH = OCTOCODE_WORDMARK.reduce(
  (maximum, line) => Math.max(maximum, terminalDisplayWidth(line)),
  0,
);

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const amplitude = normalizedSaturation * Math.min(normalizedLightness, 1 - normalizedLightness);
  const channel = (offset: number): string => {
    const key = (offset + normalizedHue / 30) % 12;
    const value = normalizedLightness
      - amplitude * Math.max(Math.min(key - 3, 9 - key, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, value))).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Deterministic purple wave color used for one glyph in the full wordmark. */
export function octocodeWaveColor(column: number, row: number, lineWidth: number): string {
  const normalizedX = column / Math.max(1, lineWidth - 1);
  const normalizedY = row / Math.max(1, OCTOCODE_WORDMARK.length - 1);
  const horizontal = Math.sin(normalizedX * Math.PI * 5 + 0.2);
  const vertical = Math.sin(normalizedY * Math.PI * 3.5 + 0.8);
  const diagonal = Math.cos((normalizedX + normalizedY) * Math.PI * 4.5 + 0.5);
  const skewed = Math.sin(normalizedX * Math.PI * 7 - normalizedY * Math.PI * 2.5 + 0.3);
  const cross = Math.cos(normalizedX * Math.PI * 2 + normalizedY * Math.PI * 6 + 1);
  const micro = Math.sin(column * 17.391 + row * 31.719) * 0.08;
  const wave = horizontal * 0.28 + vertical * 0.22 + diagonal * 0.2
    + skewed * 0.18 + cross * 0.12 + micro;
  return hslToHex(278 + wave * 42, 88 + wave * 9, 56 + wave * 20);
}

function fitLine(value: string, width: number): string {
  return terminalDisplayWidth(value) <= width ? value : fitTerminalText(value, width);
}

export interface OctocodeBannerInput {
  readonly width: number;
  readonly version?: string;
  readonly statusLine: string;
}

/** Pure, width-safe native projection of the canonical Octocode startup banner. */
export function renderOctocodeBannerLines(input: OctocodeBannerInput): readonly string[] {
  const brandLines = input.width < OCTOCODE_WORDMARK_WIDTH
    ? [fitLine(OCTOCODE_COMPACT_MARK, input.width)]
    : OCTOCODE_WORDMARK;
  return Object.freeze([
    ...brandLines,
    ...(input.version === undefined ? [] : [fitLine(`v${input.version}`, input.width)]),
    fitLine(OCTOCODE_TAGLINE, input.width),
    fitLine(OCTOCODE_BETA_NOTICE, input.width),
    fitLine(input.statusLine, input.width),
  ]);
}
