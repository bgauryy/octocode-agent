/**
 * picker.ts — minimal dependency-free arrow-key select list (P3).
 *
 * Renders rows once, redraws in place on ↑/↓ (or j/k), resolves the chosen id
 * on Enter, resolves null on Esc/q/Ctrl-C. The key source (stdin) is injectable
 * for tests; on a non-TTY stdin it resolves null immediately so callers fall
 * back to their non-interactive path.
 */
import readline from 'node:readline';
import { type Painter } from './ui.js';

export interface PickerRow {
  id: string;
  label: string;
  meta?: string;
}
export interface SelectOneOpts {
  title: string;
  rows: PickerRow[];
  /** Cap the list; extra rows are silently omitted (caller should rank). */
  maxRows?: number;
}

const ESC = '\u001b[';

function renderRows(p: Painter, rows: PickerRow[], cursor: number): string[] {
  return rows.map((row, i) => {
    const pointer = i === cursor ? p.brand('›') : ' ';
    const label = i === cursor ? p.bold(row.label) : row.label;
    const meta = row.meta ? p.dim(` · ${row.meta}`) : '';
    return ` ${pointer} ${label}${meta}`;
  });
}

/**
 * Arrow-key picker → chosen id, or null on quit / non-TTY.
 * Reads keys from `stdin` (defaults to process.stdin) via keypress events.
 */
export async function selectOne(
  p: Painter,
  opts: SelectOneOpts,
  stdin: NodeJS.ReadStream = process.stdin as NodeJS.ReadStream,
): Promise<string | null> {
  const rows = opts.rows.slice(0, opts.maxRows ?? 12);
  if (rows.length === 0) return null;
  if (!stdin.isTTY) return null;
  if (stdin === (process.stdin as unknown) && !process.stdout.isTTY) return null;

  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    const raw = typeof stdin.setRawMode === 'function';
    if (raw) stdin.setRawMode(true);
    stdin.resume();

    process.stdout.write(`\n${p.bold(p.brand(opts.title))}\n`);
    const footer = () => p.gray(`   ↑↓ j/k move · Enter select · q quit (${rows.length})`);
    let cursor = 0;
    let painted = 0;
    const paint = () => {
      const lines = renderRows(p, rows, cursor);
      for (const line of lines) process.stdout.write(line + ESC + '0K\n');
      process.stdout.write(footer() + ESC + '0K\n');
      painted = lines.length + 1;
      process.stdout.write(ESC + `${painted}A`);
    };
    paint();

    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      switch (key?.name) {
        case 'up':
        case 'k':
          cursor = (cursor - 1 + rows.length) % rows.length;
          paint();
          break;
        case 'down':
        case 'j':
          cursor = (cursor + 1) % rows.length;
          paint();
          break;
        case 'return':
          finish(rows[cursor]?.id ?? null);
          break;
        case 'escape':
          finish(null);
          break;
        default:
          if (key?.name === 'q' || (key?.ctrl && key?.name === 'c')) finish(null);
      }
    };
    const finish = (id: string | null) => {
      stdin.removeListener('keypress', onKey);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(ESC + `${painted}B\n`);
      resolve(id);
    };
    stdin.on('keypress', onKey);
  });
}
