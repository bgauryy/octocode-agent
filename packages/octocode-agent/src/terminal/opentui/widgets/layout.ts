import { segmentGraphemes } from './sanitize.js';

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function terminalGraphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}/u.test(value)) return 2;
  for (const character of value) {
    if (/\p{Mark}/u.test(character) || character === '\u200d'
      || character === '\ufe0e' || character === '\ufe0f') continue;
    return isWideCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return 0;
}

export function terminalDisplayWidth(value: string): number {
  return segmentGraphemes(value)
    .reduce((total, grapheme) => total + terminalGraphemeWidth(grapheme), 0);
}

export function fitTerminalText(value: string, widthColumns: number): string {
  if (!Number.isSafeInteger(widthColumns) || widthColumns < 0) {
    throw new Error('terminal text width must be a non-negative integer');
  }
  if (widthColumns === 0) return '';
  if (terminalDisplayWidth(value) <= widthColumns) return value;
  if (widthColumns === 1) return '…';

  const kept: string[] = [];
  let used = 0;
  for (const grapheme of segmentGraphemes(value)) {
    const next = terminalGraphemeWidth(grapheme);
    if (used + next > widthColumns - 1) break;
    kept.push(grapheme);
    used += next;
  }
  return `${kept.join('')}…`;
}
