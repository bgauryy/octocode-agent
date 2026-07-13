/**
 * File read-state tracking and per-file mutation queue.
 *
 * Centralises two shared-state concerns that previously lived in edit-tool.ts
 * but are consumed by write-tool.ts and octocode-tools.ts as well:
 *
 *   1. Read-state map — records content hashes so the edit tool can detect
 *      stale reads before writing (a lost-update guard).
 *   2. Per-file mutation queue — serialises concurrent read-modify-write cycles
 *      on the same file path so parallel tool calls cannot race.
 *
 * Keeping these in one place removes the coupling where write-tool and
 * octocode-tools previously imported from edit-tool.
 */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReadState {
  mtimeMs: number;
  size: number;
  contentHash: string;
  readAt: number;
}

export interface ReadStateCheck {
  state: 'fresh' | 'missing' | 'stale';
  message: string;
}

// ─── Module-level state ───────────────────────────────────────────────────────

const readStates = new Map<string, ReadState>();

/**
 * Per-file serialisation queue. Each key is an absolute file path; the value
 * is the settled tail of the promise chain for that file. New operations
 * are appended to the tail and execute after the previous one completes,
 * preserving read-modify-write atomicity without a global lock.
 */
const fileQueues = new Map<string, Promise<void>>();

// ─── Private helpers ──────────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Resolve a possibly-relative file path against cwd. */
export function resolveFilePath(filePath: string, cwd = process.cwd()): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

// ─── Mutation queue ───────────────────────────────────────────────────────────

/**
 * Run `fn` after all previously-queued mutations on `key` have settled.
 * Errors inside `fn` propagate to the caller but do not stall the queue for
 * future operations.
 */
export function withFileMutationQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(key) ?? Promise.resolve();
  const execution = prev.then(() => fn());
  // Tail never rejects — errors propagate via execution, not the queue.
  const tail = execution.then(() => {}, () => {});
  fileQueues.set(key, tail);
  void tail.then(() => {
    if (fileQueues.get(key) === tail) fileQueues.delete(key);
  });
  return execution;
}

// ─── Read-state tracking ──────────────────────────────────────────────────────

/** Record a content-hash snapshot of the file for later stale detection. */
export async function recordFileReadState(filePath: string, cwd = process.cwd()): Promise<void> {
  const absolutePath = resolveFilePath(filePath, cwd);
  const [stats, content] = await Promise.all([stat(absolutePath), readFile(absolutePath, 'utf8')]);
  readStates.set(absolutePath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    contentHash: contentHash(content),
    readAt: Date.now(),
  });
}

/**
 * Check whether `absolutePath` has changed since the last recorded read.
 *
 * - Fast path: if mtime+size are both unchanged, skip the hash read.
 * - Authoritative path: if they differ, compare content hashes so a
 *   same-content re-write (e.g. editor touch) is NOT falsely reported stale.
 *
 * Throws if `requireRecentRead` is true and no state is recorded.
 */
export async function checkReadState(
  absolutePath: string,
  requireRecentRead: boolean,
): Promise<ReadStateCheck> {
  const state = readStates.get(absolutePath);
  if (!state) {
    const message = 'No prior localGetFileContent read state recorded for this file.';
    if (requireRecentRead) {
      throw new Error(
        `${message} Re-read the file before editing or set requireRecentRead:false intentionally.`,
      );
    }
    return { state: 'missing', message };
  }

  const stats = await stat(absolutePath);
  let stale: boolean;
  if (stats.mtimeMs === state.mtimeMs && stats.size === state.size) {
    stale = false;
  } else {
    const current = await readFile(absolutePath, 'utf8');
    stale = contentHash(current) !== state.contentHash;
  }
  if (stale) {
    throw new Error('File changed since last recorded read. Re-read the target range before editing.');
  }
  return {
    state: 'fresh',
    message: `Fresh read state recorded ${Math.max(0, Date.now() - state.readAt)}ms ago.`,
  };
}

/** Test helper: reset all recorded read states between tests. */
export function clearReadStatesForTests(): void {
  readStates.clear();
}
