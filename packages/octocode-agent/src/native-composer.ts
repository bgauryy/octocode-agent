import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NATIVE_SLASH_COMMANDS } from './native-command-catalog.js';

export { NATIVE_SLASH_COMMANDS } from './native-command-catalog.js';
export type { NativeSlashCommand } from './native-command-catalog.js';

export type ComposerAssistMode = 'command' | 'file';

export interface ComposerTrigger {
  readonly mode: ComposerAssistMode;
  readonly fragment: string;
  readonly start: number;
  readonly end: number;
}

export interface NativeComposerSuggestion {
  readonly id: string;
  readonly kind: ComposerAssistMode;
  readonly label: string;
  readonly insertText: string;
  readonly description?: string;
}

const EXCLUDED_DIRECTORIES = new Set(['.git', '.octocode', 'node_modules', 'dist', 'out', 'target', 'coverage']);
const SENSITIVE_FILES = new Set(['.env', '.npmrc', '.pypirc', '.netrc', '.credentials', 'credentials.json']);
const CATALOG_TTL_MS = 2_000;
const MAX_DISCOVERED_FILES = 5_000;
const MAX_DEPTH = 12;
const MAX_RESULTS = 50;

const DEFAULT_PASTE_LINE_THRESHOLD = 10;
const DEFAULT_PASTE_CHARACTER_THRESHOLD = 1_000;
const DEFAULT_MAX_RETAINED_PASTE_BYTES = 4 * 1024 * 1024;
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu;
const TERMINAL_STRING_SEQUENCE =
  /(?:\u001b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/gu;
const UNSAFE_PASTE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const BIDI_FORMATTING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu;

export interface ComposerPasteStoreOptions {
  readonly maxStoredBytes?: number;
}

export interface PreparedComposerPaste {
  /** Safe text inserted into the renderer-owned composer view. */
  readonly displayText: string;
  /** Whether displayText is a view-only marker backed by retained content. */
  readonly compacted: boolean;
}

interface RetainedComposerPaste {
  readonly marker: string;
  readonly content: string;
  readonly bytes: number;
}

function sanitizeComposerPaste(value: string): string {
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(TERMINAL_STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(BIDI_FORMATTING, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u2028\u2029]/gu, '\n')
    .replace(UNSAFE_PASTE_CONTROLS, '');
}

function occurrenceCount(value: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - token.length) {
    const found = value.indexOf(token, offset);
    if (found < 0) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

/**
 * Retains large composer pastes outside the visual draft while keeping submit
 * lossless. Markers are display data only; unknown or duplicated markers stay
 * literal so user-authored text cannot accidentally select retained content.
 */
export class ComposerPasteStore {
  private readonly maxStoredBytes: number;
  private readonly retained = new Map<string, RetainedComposerPaste>();
  private nextId = 1;
  private bytes = 0;

  constructor(options: ComposerPasteStoreOptions = {}) {
    const maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_RETAINED_PASTE_BYTES;
    if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 0) {
      throw new RangeError('maxStoredBytes must be a non-negative safe integer.');
    }
    this.maxStoredBytes = maxStoredBytes;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  prepare(raw: string): PreparedComposerPaste {
    const content = sanitizeComposerPaste(raw);
    const lineCount = content.split('\n').length;
    const characterCount = Array.from(content).length;
    const shouldCompact = lineCount > DEFAULT_PASTE_LINE_THRESHOLD
      || characterCount > DEFAULT_PASTE_CHARACTER_THRESHOLD;
    if (!shouldCompact) return Object.freeze({ displayText: content, compacted: false });

    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > this.maxStoredBytes - this.bytes) {
      return Object.freeze({ displayText: content, compacted: false });
    }

    const id = this.nextId;
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const detail = lineCount > DEFAULT_PASTE_LINE_THRESHOLD
      ? `+${lineCount} lines`
      : `${characterCount} chars`;
    const marker = `[paste #${id}:${digest} ${detail}]`;
    this.retained.set(marker, Object.freeze({ marker, content, bytes }));
    this.nextId += 1;
    this.bytes += bytes;
    return Object.freeze({ displayText: marker, compacted: true });
  }

  expand(draft: string): string {
    let expanded = draft;
    for (const paste of this.retained.values()) {
      if (occurrenceCount(expanded, paste.marker) === 1) {
        expanded = expanded.replace(paste.marker, paste.content);
      }
    }
    return expanded;
  }

  clear(): void {
    this.retained.clear();
    this.bytes = 0;
    this.nextId = 1;
  }
}

function safeCursor(value: string, cursor: number): number {
  return Number.isSafeInteger(cursor) ? Math.max(0, Math.min(value.length, cursor)) : value.length;
}

export function parseComposerTrigger(value: string, cursor = value.length): ComposerTrigger | undefined {
  const end = safeCursor(value, cursor);
  const before = value.slice(0, end);
  if (before.startsWith('/') && !before.slice(0, end).includes('\n') && !/\s/.test(before)) {
    return { mode: 'command', fragment: before.slice(1), start: 0, end };
  }
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]!))) return undefined;
  const fragment = before.slice(at + 1);
  if (/\s/.test(fragment) || fragment.startsWith('"')) return undefined;
  return { mode: 'file', fragment, start: at, end };
}

function quoteFileReference(value: string): string {
  return /\s/.test(value) ? `@"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : `@${value}`;
}

export function applyComposerSuggestion(
  value: string,
  trigger: ComposerTrigger,
  suggestion: NativeComposerSuggestion,
): { readonly value: string; readonly cursor: number } {
  const insertion = suggestion.kind === 'command' ? `/${suggestion.insertText} ` : quoteFileReference(suggestion.insertText);
  const next = `${value.slice(0, trigger.start)}${insertion}${value.slice(trigger.end)}`;
  return { value: next, cursor: trigger.start + insertion.length };
}

function scorePath(candidate: string, query: string): number | undefined {
  if (!query) return candidate.length;
  const normalized = candidate.toLocaleLowerCase('en-US');
  const needle = query.toLocaleLowerCase('en-US');
  const direct = normalized.indexOf(needle);
  if (direct >= 0) return direct * 10 + candidate.length;
  let offset = 0;
  let score = candidate.length + 100;
  for (const character of needle) {
    const found = normalized.indexOf(character, offset);
    if (found < 0) return undefined;
    score += found - offset;
    offset = found + 1;
  }
  return score;
}

export class WorkspaceFileCatalog {
  private readonly root: string;
  private indexed?: Promise<readonly string[]>;
  private indexedAt = 0;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async search(fragment: string, signal?: AbortSignal): Promise<readonly NativeComposerSuggestion[]> {
    if (signal?.aborted) return [];
    if (this.indexed === undefined || Date.now() - this.indexedAt >= CATALOG_TTL_MS) {
      this.indexedAt = Date.now();
      this.indexed = this.discover();
    }
    const files = await this.indexed;
    if (signal?.aborted) return [];
    return files
      .map((file) => ({ file, score: scorePath(file, fragment) }))
      .filter((entry): entry is { file: string; score: number } => entry.score !== undefined)
      .sort((left, right) => left.score - right.score || left.file.localeCompare(right.file))
      .slice(0, MAX_RESULTS)
      .map(({ file }) => Object.freeze({
        id: `file-${createHash('sha256').update(file).digest('hex').slice(0, 24)}`,
        kind: 'file' as const,
        label: file,
        insertText: file,
      }));
  }

  private async discover(): Promise<readonly string[]> {
    const files: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_DISCOVERED_FILES) return;
      let entries: Dirent<string>[];
      try { entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' }); }
      catch { return; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= MAX_DISCOVERED_FILES) return;
        if (SENSITIVE_FILES.has(entry.name) || entry.name.startsWith('.env.')) continue;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name), depth + 1);
        } else if (entry.isFile()) {
          files.push(path.relative(this.root, path.join(directory, entry.name)).split(path.sep).join('/'));
        }
      }
    };
    await visit(this.root, 0);
    return Object.freeze(files);
  }
}

export function commandSuggestions(fragment: string): readonly NativeComposerSuggestion[] {
  const query = fragment.toLocaleLowerCase('en-US');
  return NATIVE_SLASH_COMMANDS
    .filter(({ name }) => name.startsWith(query))
    .map(({ name, description }) => Object.freeze({
      id: `command-${name}`,
      kind: 'command' as const,
      label: `/${name}`,
      insertText: name,
      description,
    }));
}
