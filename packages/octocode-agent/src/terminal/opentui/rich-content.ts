import {
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  type Renderable,
  SyntaxStyle,
  t,
  TextTableRenderable,
  type TextTableContent,
} from '@opentui/core';

type RendererContext = ConstructorParameters<typeof MarkdownRenderable>[0];

export interface MarkdownRichContent {
  readonly kind: 'markdown';
  readonly id: string;
  readonly content: string;
  readonly streaming?: boolean;
}

export interface CodeRichContent {
  readonly kind: 'code';
  readonly id: string;
  readonly content: string;
  readonly language?: string;
  readonly showLineNumbers?: boolean;
  readonly wrapMode?: 'none' | 'char' | 'word';
}

export interface DiffRichContent {
  readonly kind: 'diff';
  readonly id: string;
  readonly content: string;
  readonly language?: string;
  readonly view?: 'unified' | 'split';
  readonly showLineNumbers?: boolean;
  readonly wrapMode?: 'none' | 'char' | 'word';
}

export interface TableRichContent {
  readonly kind: 'table';
  readonly id: string;
  readonly rows: readonly (readonly string[])[];
  readonly showBorders?: boolean;
  readonly wrapMode?: 'none' | 'char' | 'word';
}

export type OpenTuiRichContent = MarkdownRichContent | CodeRichContent | DiffRichContent | TableRichContent;

export type OpenTuiRichRenderable = MarkdownRenderable | LineNumberRenderable | DiffRenderable | TextTableRenderable;

export interface MountedOpenTuiRichContent {
  readonly kind: OpenTuiRichContent['kind'];
  readonly root: OpenTuiRichRenderable;
  update(content: OpenTuiRichContent): void;
  destroy(): void;
}

export interface OpenTuiRichContentStyle {
  readonly foreground?: string;
  readonly background?: string;
  readonly muted?: string;
  readonly accent?: string;
  readonly path?: string;
  readonly code?: string;
  readonly link?: string;
  readonly count?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly error?: string;
  readonly added?: string;
  readonly removed?: string;
  readonly context?: string;
  readonly border?: string;
  readonly selectionForeground?: string;
  readonly selectionBackground?: string;
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  php: 'php',
  python: 'python',
  py: 'python',
  ruby: 'ruby',
  rust: 'rust',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

function normalizeLanguage(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized];
}

function createSyntaxStyle(style: OpenTuiRichContentStyle): SyntaxStyle {
  const baseForeground = style.code ?? style.foreground;
  return SyntaxStyle.fromStyles({
    default: { ...(baseForeground === undefined ? {} : { fg: baseForeground }) },
    comment: { ...(style.muted === undefined ? {} : { fg: style.muted }), italic: true },
    keyword: { ...(style.accent === undefined ? {} : { fg: style.accent }), bold: true },
    string: { ...(style.success === undefined ? {} : { fg: style.success }) },
    number: { ...(style.count === undefined ? {} : { fg: style.count }) },
    function: { ...(style.accent === undefined ? {} : { fg: style.accent }) },
    type: { ...(style.link === undefined ? {} : { fg: style.link }) },
    operator: { ...(style.link === undefined ? {} : { fg: style.link }) },
    'markup.heading': { ...(style.accent === undefined ? {} : { fg: style.accent }), bold: true },
    'markup.raw': { ...(style.code === undefined ? {} : { fg: style.code }) },
    'markup.link.url': { ...(style.path === undefined ? {} : { fg: style.path }), underline: true },
    'markup.bold': { bold: true },
    'markup.italic': { italic: true },
    'markup.link': { ...(style.link === undefined ? {} : { fg: style.link }), underline: true },
    'diagnostic.warning': { ...(style.warning === undefined ? {} : { fg: style.warning }), bold: true },
    'diagnostic.error': { ...(style.error === undefined ? {} : { fg: style.error }), bold: true },
  });
}

function tableContent(rows: TableRichContent['rows']): TextTableContent {
  return rows.map((row) => row.map((cell) => t`${cell}`.chunks));
}

function assertCompatible(current: OpenTuiRichContent, next: OpenTuiRichContent): void {
  if (current.kind !== next.kind) {
    throw new TypeError(`cannot change rich content kind from ${current.kind} to ${next.kind}`);
  }
  if (current.id !== next.id) {
    throw new TypeError(`cannot change rich content id from ${current.id} to ${next.id}`);
  }
}

/** Mounts one toolkit-owned rich renderable and returns an in-place lifecycle handle. */
export function mountOpenTuiRichContent(
  renderer: RendererContext,
  parent: Renderable,
  initial: OpenTuiRichContent,
  style: OpenTuiRichContentStyle = {},
): MountedOpenTuiRichContent {
  let current = initial;
  let destroyed = false;
  const syntaxStyle = initial.kind === 'table' ? undefined : createSyntaxStyle(style);
  let code: CodeRenderable | undefined;

  const root: OpenTuiRichRenderable = (() => {
    if (initial.kind === 'markdown') {
      return new MarkdownRenderable(renderer, {
        id: initial.id,
        content: initial.content,
        syntaxStyle: syntaxStyle!,
        streaming: initial.streaming ?? false,
        width: '100%',
        conceal: true,
        concealCode: false,
        ...(style.foreground === undefined ? {} : { fg: style.foreground }),
        ...(style.background === undefined ? {} : { bg: style.background }),
        tableOptions: {
          ...(style.border === undefined ? {} : { borderColor: style.border }),
          selectable: true,
        },
      });
    }
    if (initial.kind === 'code') {
      code = new CodeRenderable(renderer, {
        id: `${initial.id}-code`,
        content: initial.content,
        filetype: normalizeLanguage(initial.language),
        syntaxStyle: syntaxStyle!,
        wrapMode: initial.wrapMode ?? 'none',
        width: '100%',
        drawUnstyledText: true,
        ...(style.foreground === undefined ? {} : { fg: style.foreground }),
        ...(style.background === undefined ? {} : { bg: style.background }),
        ...(style.selectionForeground === undefined ? {} : { selectionFg: style.selectionForeground }),
        ...(style.selectionBackground === undefined ? {} : { selectionBg: style.selectionBackground }),
      });
      return new LineNumberRenderable(renderer, {
        id: initial.id,
        target: code,
        showLineNumbers: initial.showLineNumbers ?? true,
        width: '100%',
        minWidth: 3,
        paddingRight: 1,
        ...(style.muted === undefined ? {} : { fg: style.muted }),
        ...(style.background === undefined ? {} : { bg: style.background }),
      });
    }
    if (initial.kind === 'diff') {
      return new DiffRenderable(renderer, {
        id: initial.id,
        diff: initial.content,
        filetype: normalizeLanguage(initial.language),
        syntaxStyle,
        view: initial.view ?? 'unified',
        wrapMode: initial.wrapMode ?? 'none',
        showLineNumbers: initial.showLineNumbers ?? true,
        width: '100%',
        ...(style.foreground === undefined ? {} : { fg: style.foreground }),
        ...(style.added === undefined ? {} : { addedSignColor: style.added }),
        ...(style.removed === undefined ? {} : { removedSignColor: style.removed }),
        ...(style.added === undefined ? {} : { addedBg: style.background ?? style.added }),
        ...(style.removed === undefined ? {} : { removedBg: style.background ?? style.removed }),
        ...(style.context === undefined ? {} : { contextBg: style.background ?? style.context }),
        ...(style.selectionForeground === undefined ? {} : { selectionFg: style.selectionForeground }),
        ...(style.selectionBackground === undefined ? {} : { selectionBg: style.selectionBackground }),
      });
    }
    return new TextTableRenderable(renderer, {
      id: initial.id,
      content: tableContent(initial.rows),
      width: '100%',
      height: Math.max(1, initial.rows.length + (initial.showBorders === false ? 0 : 2)),
      flexShrink: 0,
      wrapMode: initial.wrapMode ?? 'word',
      columnWidthMode: 'full',
      columnFitter: 'balanced',
      showBorders: initial.showBorders ?? true,
      outerBorder: initial.showBorders ?? true,
      cellPaddingX: 1,
      cellPaddingY: 0,
      ...(style.foreground === undefined ? {} : { fg: style.foreground }),
      ...(style.background === undefined ? {} : { bg: style.background }),
      ...(style.border === undefined ? {} : { borderColor: style.border }),
      ...(style.selectionForeground === undefined ? {} : { selectionFg: style.selectionForeground }),
      ...(style.selectionBackground === undefined ? {} : { selectionBg: style.selectionBackground }),
    });
  })();

  parent.add(root);

  return {
    kind: initial.kind,
    root,
    update(next): void {
      if (destroyed) throw new Error('cannot update destroyed rich content');
      assertCompatible(current, next);
      if (next.kind === 'markdown' && root instanceof MarkdownRenderable) {
        root.content = next.content;
        root.streaming = next.streaming ?? false;
      } else if (next.kind === 'code' && code) {
        code.filetype = normalizeLanguage(next.language);
        code.wrapMode = next.wrapMode ?? 'none';
        code.content = next.content;
        (root as LineNumberRenderable).showLineNumbers = next.showLineNumbers ?? true;
      } else if (next.kind === 'diff' && root instanceof DiffRenderable) {
        root.filetype = normalizeLanguage(next.language);
        root.view = next.view ?? 'unified';
        root.wrapMode = next.wrapMode ?? 'none';
        root.showLineNumbers = next.showLineNumbers ?? true;
        root.diff = next.content;
      } else if (next.kind === 'table' && root instanceof TextTableRenderable) {
        root.wrapMode = next.wrapMode ?? 'word';
        root.showBorders = next.showBorders ?? true;
        root.outerBorder = next.showBorders ?? true;
        root.height = Math.max(1, next.rows.length + (next.showBorders === false ? 0 : 2));
        root.content = tableContent(next.rows);
      }
      current = next;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      root.destroyRecursively();
      syntaxStyle?.destroy();
    },
  };
}
