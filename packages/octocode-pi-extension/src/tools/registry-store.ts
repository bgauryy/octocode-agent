/**
 * registry-store — shared primitives for the filesystem-backed dynamic registries
 * (dynamic-tools and dynamic-skills). Both persist a JSON index under a directory
 * shared by many parallel agents and need the same atomic write, corruption-safe
 * read, cross-process mutex, and keyword tokenization. This module is the single
 * source of truth for that machinery so a fix (e.g. a stale-lock reclaim change)
 * lands in one place instead of two hand-copied blocks.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A candidate needs at least this many overlapping keyword tokens to count as a match. */
export const KEYWORD_MATCH_THRESHOLD = 2;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** Lowercase alphanumeric token set, used for keyword-overlap fallback resolution. */
export function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Atomic JSON write on the same filesystem (write-temp + rename) so a concurrent
 * reader never observes a partial/torn file.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Read+parse JSON, returning `fallback` on missing/corrupt/invalid content rather
 * than throwing — a corrupt index must never crash the agent. `isValid` lets the
 * caller reject a structurally wrong (but parseable) shape.
 */
export function readJsonSafe<T>(filePath: string, fallback: T, isValid?: (raw: unknown) => boolean): T {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return fallback;
    if (isValid && !isValid(raw)) return fallback;
    return raw as T;
  } catch {
    return fallback;
  }
}

/**
 * Cross-process mutex around a read-modify-write of a shared registry directory.
 * `fs.mkdirSync` is atomic — it fails if the lock dir already exists — so it is a
 * correct inter-process lock. NOT reentrant: callers must not nest. A lock older
 * than LOCK_STALE_MS is treated as abandoned (crashed holder) and reclaimed so a
 * dead process can never wedge the registry.
 *
 * @param dir       registry root (created if missing)
 * @param lockName  lock directory name (e.g. `.index.lock`)
 * @param label     used in the timeout error message
 */
export function withRegistryLock<T>(dir: string, lockName: string, label: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, lockName);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat → retry immediately
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`${label} registry lock timeout`);
      // Block ~15ms without burning the CPU / event loop. Atomics.wait on a
      // throwaway shared buffer is a synchronous sleep (index ops are sub-ms, so
      // real contention is rare and brief).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // already released
    }
  }
}
