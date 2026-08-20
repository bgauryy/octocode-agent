/**
 * dynamic-tools — the deterministic core of the `callTool` meta-tool.
 *
 * A "dynamic tool" is a self-contained, verified capability persisted to a
 * filesystem registry under `getOctocodeHome()/dynamic-tools/`. Each tool is a
 * directory with a `tool.mjs` (default async export `(metadata) => result`), a
 * `tool.test.mjs` used as a verification gate, and an entry in `index.json`.
 *
 * This module owns everything that is deterministic and unit-testable:
 *   - registry read/write (atomic, concurrency-safe via write-temp + rename)
 *   - O(1) resolve (exact name) with a keyword/description fallback
 *   - verification-gated registration (a tool is only indexed if its test passes)
 *   - checksum tamper-detection before execution
 *   - capability gating (declared net/fs/exec must be explicitly allowed)
 *   - isolated subprocess execution with a hard timeout
 *
 * Codegen (create/enhance/fix) is intentionally NOT here — it needs an LLM and
 * lives in the `callTool` tool, which spawns a tool-smith subagent and then calls
 * `registerGeneratedTool` with the produced source + test. Keeping codegen out of
 * this module keeps the core deterministic and fully testable.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getOctocodeHome } from '../env.js';

/** A capability a dynamic tool may declare. Escalation beyond `[]` needs approval. */
export type Capability = 'net' | 'fs' | 'exec';

export interface ToolManifestEntry {
  name: string;
  description: string;
  keywords: string[];
  capabilities: Capability[];
  /** Why this capability deserves a persisted, reusable tool (recorded at create time). */
  reason: string;
  /**
   * Enforce OS-level isolation when running this tool (Node permission model:
   * denied-by-default fs/net/child_process, scrubbed env). Default true. A tool may be
   * created with `sandboxed:false` only for trusted capabilities that genuinely need
   * broad host access; that decision is recorded here.
   */
  sandboxed: boolean;
  /**
   * The tool is a pure function of its metadata (same input → same output, no side
   * effects). When true AND it declares no capabilities, results are memoized per
   * (name, version, metadata) to skip repeat subprocess spawns. Default false.
   */
  deterministic: boolean;
  /** Absolute path to the tool's `tool.mjs`. */
  entry: string;
  version: number;
  /** sha256 of the exact `tool.mjs` source at registration time. */
  checksum: string;
  createdAt: string;
  updatedAt: string;
  stats: { calls: number; failures: number; lastUsedAt: string | null };
}

interface RegistryIndex {
  version: 1;
  tools: Record<string, ToolManifestEntry>;
}

export type ResolveResult =
  | { hit: 'exact'; entry: ToolManifestEntry }
  | { hit: 'keyword'; entry: ToolManifestEntry; score: number }
  | { hit: 'miss' };

export interface RegisterInput {
  name: string;
  description: string;
  keywords: string[];
  capabilities: Capability[];
  /** Why this tool should exist as a reusable capability (required, non-empty). */
  reason: string;
  /** Enforce OS-level isolation (default true). Set false only for trusted broad-access tools. */
  sandboxed?: boolean;
  /** Pure function of metadata → enables result memoization (default false). */
  deterministic?: boolean;
  /** Full source of `tool.mjs`. */
  source: string;
  /** Full source of `tool.test.mjs` — MUST exit 0 for the tool to be registered. */
  test: string;
}

export type RegisterResult =
  | { ok: true; entry: ToolManifestEntry }
  | { ok: false; reason: 'invalid-name' | 'no-reason' | 'test-failed' | 'test-timeout'; detail?: string };

export type RunResult =
  | { ok: true; result: unknown; cached?: boolean }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'checksum-mismatch'
        | `capability-denied:${Capability}`
        | 'exec-failed'
        | 'exec-timeout'
        | 'bad-output';
      detail?: string;
    };

// In-memory memoization for deterministic tools. Process-scoped (safe: keyed by tool
// version, so re-registration busts it) and bounded FIFO so it can't grow unbounded.
const RESULT_CACHE_MAX = 256;
const resultCache = new Map<string, unknown>();
function storeInCache(key: string, value: unknown): void {
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, value);
}

const KEYWORD_MATCH_THRESHOLD = 2;
const DEFAULT_RUN_TIMEOUT_MS = 5_000;
const DEFAULT_TEST_TIMEOUT_MS = 15_000;
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// ─── paths ──────────────────────────────────────────────────────────────────

/** Registry root: `getOctocodeHome()/dynamic-tools`. Never hand-roll this path. */
export function getRegistryDir(env?: NodeJS.ProcessEnv): string {
  return path.join(getOctocodeHome(env), 'dynamic-tools');
}

function indexPath(dir: string): string {
  return path.join(dir, 'index.json');
}

function toolDir(dir: string, name: string): string {
  return path.join(dir, name);
}

// ─── registry io (atomic) ─────────────────────────────────────────────────────

function ensureRegistry(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(indexPath(dir))) {
    writeIndex(dir, { version: 1, tools: {} });
  }
}

export function readIndex(dir = getRegistryDir()): RegistryIndex {
  ensureRegistry(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')) as RegistryIndex;
    if (!raw || typeof raw !== 'object' || !raw.tools) return { version: 1, tools: {} };
    return raw;
  } catch {
    // Corrupt index → treat as empty rather than crash the agent.
    return { version: 1, tools: {} };
  }
}

function writeIndex(dir: string, idx: RegistryIndex): void {
  // Atomic on the same filesystem → a reader never observes a partial/torn index.
  const tmp = `${indexPath(dir)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath(dir));
}

/**
 * Cross-process mutex around a read-modify-write of the shared registry (which lives under
 * getOctocodeHome() and is used by many parallel agents). `fs.mkdirSync` is atomic — it
 * fails if the lock dir already exists — so it is a correct inter-process lock. Not
 * reentrant: callers must not nest withIndexLock. A lock older than STALE_MS is treated as
 * abandoned (crashed holder) and reclaimed so a dead process can never wedge the registry.
 */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
function withIndexLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.index.lock');
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
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('dynamic-tools registry lock timeout');
      const until = Date.now() + 15;
      while (Date.now() < until) {
        /* brief spin; index ops are sub-ms */
      }
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

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

// ─── resolve (O(1) exact + keyword fallback) ──────────────────────────────────

/**
 * Resolve a request to an existing tool. Exact name match is O(1). On a miss,
 * a keyword overlap against tool keywords (from `toolType` + `intent`) is scored;
 * a candidate needs at least KEYWORD_MATCH_THRESHOLD overlapping tokens to count,
 * which keeps false reuse low. Anything below threshold is a genuine miss.
 */
export function resolveTool(
  toolType: string,
  intent = '',
  dir = getRegistryDir(),
): ResolveResult {
  const idx = readIndex(dir);
  const exact = idx.tools[toolType];
  if (exact) return { hit: 'exact', entry: exact };

  const tokens = tokenize(`${toolType} ${intent}`);
  let best: { entry: ToolManifestEntry; score: number } | null = null;
  for (const entry of Object.values(idx.tools)) {
    const kw = new Set(entry.keywords.map((k) => k.toLowerCase()));
    let score = 0;
    for (const t of tokens) if (kw.has(t)) score++;
    if (!best || score > best.score) best = { entry, score };
  }
  if (best && best.score >= KEYWORD_MATCH_THRESHOLD) {
    return { hit: 'keyword', entry: best.entry, score: best.score };
  }
  return { hit: 'miss' };
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// ─── verification-gated registration ──────────────────────────────────────────

/**
 * Write source + test to the registry and register the tool ONLY if the generated
 * test exits 0. A tool that cannot pass its own test is rejected and leaves no
 * registry entry — no stubs, no half-registered capabilities.
 */
export function registerGeneratedTool(
  input: RegisterInput,
  dir = getRegistryDir(),
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
): RegisterResult {
  if (!NAME_RE.test(input.name)) {
    return { ok: false, reason: 'invalid-name', detail: input.name };
  }
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, reason: 'no-reason' };
  }
  ensureRegistry(dir);
  const tdir = toolDir(dir, input.name);
  const existing = readIndex(dir).tools[input.name];
  const nextVersion = existing ? existing.version + 1 : 1;
  const entryFile = path.join(tdir, 'tool.mjs');
  const testFile = path.join(tdir, 'tool.test.mjs');

  // Enhance/fix rollback: snapshot the previous good files so a failed regeneration
  // never leaves a soft-broken tool (files changed but index checksum stale).
  const backup = existing ? snapshotFiles(entryFile, testFile) : null;

  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(entryFile, input.source);
  fs.writeFileSync(testFile, input.test);

  const res = spawnSync(process.execPath, [testFile], {
    encoding: 'utf8',
    timeout: testTimeoutMs,
  });

  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    rollback(tdir, existing, entryFile, testFile, backup);
    return { ok: false, reason: 'test-timeout' };
  }
  if (res.status !== 0) {
    rollback(tdir, existing, entryFile, testFile, backup);
    return {
      ok: false,
      reason: 'test-failed',
      detail: (res.stderr || res.stdout || '').trim().slice(0, 500),
    };
  }

  const now = new Date().toISOString();
  const entry: ToolManifestEntry = {
    name: input.name,
    description: input.description,
    keywords: input.keywords,
    capabilities: input.capabilities,
    reason: input.reason.trim(),
    sandboxed: input.sandboxed !== false,
    deterministic: input.deterministic === true,
    entry: entryFile,
    version: nextVersion,
    checksum: sha256(input.source),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    stats: existing?.stats ?? { calls: 0, failures: 0, lastUsedAt: null },
  };
  withIndexLock(dir, () => {
    const idx = readIndex(dir);
    idx.tools[input.name] = entry;
    writeIndex(dir, idx);
  });
  return { ok: true, entry };
}

interface FileSnapshot {
  source: string | null;
  test: string | null;
}
function snapshotFiles(entryFile: string, testFile: string): FileSnapshot {
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return { source: read(entryFile), test: read(testFile) };
}

/**
 * Undo a failed (re)registration.
 *   - brand-new tool (no prior version): remove the directory entirely.
 *   - existing tool (enhance/fix): restore the previous good source + test so the tool
 *     keeps working and its index checksum stays valid — no soft-broken state.
 */
function rollback(
  tdir: string,
  existing: ToolManifestEntry | undefined,
  entryFile: string,
  testFile: string,
  backup: FileSnapshot | null,
): void {
  if (!existing) {
    fs.rmSync(tdir, { recursive: true, force: true });
    return;
  }
  if (backup?.source !== null && backup?.source !== undefined) fs.writeFileSync(entryFile, backup.source);
  if (backup?.test !== null && backup?.test !== undefined) fs.writeFileSync(testFile, backup.test);
}

// ─── isolated execution ────────────────────────────────────────────────────────

/**
 * Execute a registered tool in a fresh Node subprocess.
 *   - checksum guard: refuses to run if `tool.mjs` was edited out-of-band
 *   - capability gate: every declared capability must be in `allow`
 *   - hard timeout: a runaway tool is killed
 * The tool receives `metadata` as JSON on stdin and returns its result as JSON stdout.
 */
export function runDynamicTool(
  entry: ToolManifestEntry,
  metadata: unknown,
  opts: { allow?: Capability[]; timeoutMs?: number } = {},
): RunResult {
  const allow = opts.allow ?? [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  if (!fs.existsSync(entry.entry)) return { ok: false, reason: 'not-found' };
  const src = fs.readFileSync(entry.entry, 'utf8');
  if (sha256(src) !== entry.checksum) return { ok: false, reason: 'checksum-mismatch' };

  for (const cap of entry.capabilities) {
    if (!allow.includes(cap)) return { ok: false, reason: `capability-denied:${cap}` };
  }

  // Memoize pure tools: same (name, version, metadata) → skip the subprocess. Only when
  // the tool declares determinism AND no capabilities (a tool with net/fs/exec may have
  // side effects, so caching would be unsafe). Keyed by version so re-registration busts it.
  const cacheable = entry.deterministic && entry.capabilities.length === 0;
  const cacheKey = cacheable
    ? `${entry.name}@${entry.version}:${sha256(JSON.stringify(metadata ?? {}))}`
    : '';
  if (cacheable && resultCache.has(cacheKey)) {
    return { ok: true, result: resultCache.get(cacheKey), cached: true };
  }

  const runner = path.join(
    os.tmpdir(),
    `octocode-calltool-runner-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  // Import via the tool's realpath so the sandboxed permission check (which resolves
  // realpaths) matches the granted realpath subtree.
  const toolRealPath = safeRealpath(entry.entry);
  fs.writeFileSync(
    runner,
    [
      // Read metadata from stdin (not argv) so large inputs never hit the OS argv limit.
      `let _in = ''; for await (const c of process.stdin) _in += c;`,
      `const metadata = JSON.parse(_in || '{}');`,
      `const mod = await import(${JSON.stringify(pathToFileUrl(toolRealPath))});`,
      `if (typeof mod.default !== 'function') { console.error('tool has no default export function'); process.exit(3); }`,
      `const out = await mod.default(metadata);`,
      `process.stdout.write(JSON.stringify(out ?? null));`,
    ].join('\n'),
  );

  // Pass the runner's realpath as the entry so Node does not need to read the tmp
  // symlink chain (e.g. /var → /private/var) during main-entry realpath resolution.
  const runnerRealPath = safeRealpath(runner);
  const { args, env } = buildRunInvocation(runnerRealPath, toolRealPath, entry, allow);

  try {
    const res = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env,
      input: JSON.stringify(metadata ?? {}),
    });
    if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return { ok: false, reason: 'exec-timeout' };
    }
    if (res.status !== 0) {
      return { ok: false, reason: 'exec-failed', detail: (res.stderr || '').trim().slice(0, 500) };
    }
    try {
      const parsed = JSON.parse(res.stdout);
      if (cacheable) storeInCache(cacheKey, parsed);
      return { ok: true, result: parsed, cached: false };
    } catch {
      return { ok: false, reason: 'bad-output', detail: res.stdout.slice(0, 300) };
    }
  } finally {
    fs.rmSync(runner, { force: true });
  }
}

/** Resolve a path's realpath, falling back to the resolved absolute path. */
function safeRealpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** A realpath'd file into a Node permission subtree glob (`/real/dir/*`). */
function readSubtree(realFile: string): string {
  return `${path.dirname(realFile)}${path.sep}*`;
}

/**
 * Build the Node invocation + environment for a tool run.
 *
 * Sandboxed (default): enable the Node permission model so everything is denied by
 * default, then grant ONLY the capabilities the tool declared and the caller approved:
 *   - fs-read is scoped to the runner + tool directories (needed to import the module)
 *   - `net`  → --allow-net
 *   - `exec` → --allow-child-process
 *   - `fs`   → --allow-fs-read + --allow-fs-write (broad; the fs capability IS the approval)
 * Native addons, workers, FFI, and the inspector are never granted. The environment is
 * scrubbed to a minimal PATH so process secrets in process.env are not exposed.
 *
 * Non-sandboxed (opt-in, trusted tools only): run as an ordinary Node process with the
 * inherited environment — capabilities are advisory, used only for the approval gate.
 */
function buildRunInvocation(
  runnerRealPath: string,
  toolRealPath: string,
  entry: ToolManifestEntry,
  allow: Capability[],
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (entry.sandboxed === false) {
    return { args: [runnerRealPath], env: process.env };
  }

  const caps = new Set(entry.capabilities.filter((c) => allow.includes(c)));
  // --disallow-code-generation-from-strings blocks eval / new Function in the tool,
  // shrinking the attack surface of generated code beyond the capability grants.
  const flags = ['--permission', '--disallow-code-generation-from-strings'];

  if (caps.has('fs')) {
    flags.push('--allow-fs-read=*', '--allow-fs-write=*');
  } else {
    // Minimum needed to import the tool module + runner; nothing else is readable.
    flags.push(`--allow-fs-read=${readSubtree(runnerRealPath)}`, `--allow-fs-read=${readSubtree(toolRealPath)}`);
  }
  if (caps.has('net')) flags.push('--allow-net');
  if (caps.has('exec')) flags.push('--allow-child-process');

  // Scrub the environment: expose only PATH so the tool can locate binaries it is
  // explicitly allowed to spawn, but never inherits API keys / tokens from process.env.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  return { args: [...flags, runnerRealPath], env };
}

function pathToFileUrl(p: string): string {
  const resolved = path.resolve(p);
  const prefixed = resolved.startsWith('/') ? resolved : `/${resolved.replace(/\\/g, '/')}`;
  return `file://${encodeURI(prefixed)}`;
}

// ─── listing / stats ────────────────────────────────────────────────────────

export function listTools(dir = getRegistryDir()): ToolManifestEntry[] {
  return Object.values(readIndex(dir).tools);
}

/** Delete a dynamic tool: remove its directory and index entry (CRUD delete). */
export function deleteTool(name: string, dir = getRegistryDir()): boolean {
  return withIndexLock(dir, () => {
    const idx = readIndex(dir);
    if (!idx.tools[name]) return false;
    delete idx.tools[name];
    writeIndex(dir, idx);
    fs.rmSync(toolDir(dir, name), { recursive: true, force: true });
    return true;
  });
}

/** Record a call outcome for a tool (drives enhance/optimize + GC decisions). */
export function recordUsage(name: string, ok: boolean, dir = getRegistryDir()): void {
  withIndexLock(dir, () => {
    const idx = readIndex(dir);
    const entry = idx.tools[name];
    if (!entry) return;
    entry.stats.calls += 1;
    if (!ok) entry.stats.failures += 1;
    entry.stats.lastUsedAt = new Date().toISOString();
    writeIndex(dir, idx);
  });
}
