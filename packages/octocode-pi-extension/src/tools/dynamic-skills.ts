/**
 * dynamic-skills — the deterministic core of the `callSkill` meta-tool.
 *
 * A "dynamic skill" is an approved, reusable **workflow** the agent follows: a directory
 * with a `SKILL.md` (Agent Skills frontmatter + markdown steps) and optional `scripts/`.
 * Unlike a dynamic tool (deterministic code the harness runs), a skill is guidance the
 * model reads and follows via `read` / `/skill:<name>`. Any executable `scripts/` a skill
 * ships should be run through the callTool sandbox — skills orchestrate, tools execute.
 *
 * Skills are written to the user's Pi skill directory so Pi discovers them:
 *   - `~/.pi/agent/skills/<name>/` (default) — surfaced to spawned subagents immediately
 *     (their skill dirs are re-scanned per spawn); the main process needs a restart or a
 *     direct `read` of the returned SKILL.md path to surface it in its own prompt.
 *
 * This module owns everything deterministic and unit-testable: registry read/write,
 * O(1) resolve, frontmatter+structure validation (the skill verification gate, weaker
 * than a tool's test gate), CRUD delete, and a junk sweep. Authoring (writing SKILL.md
 * content) needs an LLM and lives in the `callSkill` tool via a skill-smith subagent.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── types ────────────────────────────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  /** Absolute path to SKILL.md (what the agent `read`s to follow the workflow). */
  skillMd: string;
  /** Why this workflow deserves a persisted, reusable skill. */
  reason: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  stats: { uses: number; lastUsedAt: string | null };
}

interface SkillIndex {
  version: 1;
  skills: Record<string, SkillManifestEntry>;
}

export type SkillResolveResult =
  | { hit: 'exact'; entry: SkillManifestEntry }
  | { hit: 'keyword'; entry: SkillManifestEntry; score: number }
  | { hit: 'miss' };

export interface SkillInput {
  name: string;
  description: string;
  reason: string;
  /** Full SKILL.md content (including frontmatter). */
  skillMd: string;
  /** Optional helper files, written relative to the skill dir (e.g. `scripts/run.mjs`). */
  files?: Array<{ relPath: string; content: string }>;
}

export type SkillRegisterResult =
  | { ok: true; entry: SkillManifestEntry }
  | { ok: false; reason: 'invalid-name' | 'no-reason' | 'invalid-frontmatter' | 'invalid-structure'; detail?: string };

const KEYWORD_MATCH_THRESHOLD = 2;
// Agent Skills spec: 1-64 chars, lowercase a-z/0-9/hyphen, no leading/trailing/double hyphen.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

// ─── paths ──────────────────────────────────────────────────────────────────

/**
 * Skills registry root. Defaults to `~/.pi/agent/skills` so Pi discovers created skills.
 * Overridable via env for tests / non-default homes.
 */
export function getSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OCTOCODE_DYNAMIC_SKILLS_DIR;
  if (override) return override;
  const home = env.HOME || env.USERPROFILE || process.cwd();
  return path.join(home, '.pi', 'agent', 'skills');
}

/** The registry index lives beside the skill dirs but is ignored by Pi's SKILL.md scan. */
function indexPath(dir: string): string {
  return path.join(dir, '.octocode-skills-index.json');
}

function skillDir(dir: string, name: string): string {
  return path.join(dir, name);
}

// ─── registry io (atomic) ─────────────────────────────────────────────────────

function ensureRegistry(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(indexPath(dir))) writeIndex(dir, { version: 1, skills: {} });
}

export function readIndex(dir = getSkillsDir()): SkillIndex {
  ensureRegistry(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')) as SkillIndex;
    if (!raw || typeof raw !== 'object' || !raw.skills) return { version: 1, skills: {} };
    return raw;
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeIndex(dir: string, idx: SkillIndex): void {
  const tmp = `${indexPath(dir)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath(dir));
}

/**
 * Cross-process mutex around read-modify-write of the shared skills index (see the
 * dynamic-tools equivalent). Atomic `mkdirSync`; stale locks (crashed holder) are
 * reclaimed. Not reentrant — callers must not nest.
 */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
function withIndexLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.skills-index.lock');
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
        // lock vanished → retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('dynamic-skills registry lock timeout');
      const until = Date.now() + 15;
      while (Date.now() < until) {
        /* brief spin */
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

// ─── validation (the skill verification gate) ─────────────────────────────────

export interface Frontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** Parse the leading `--- ... ---` YAML-ish frontmatter (name/description only needed). */
export function parseFrontmatter(skillMd: string): Frontmatter | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(skillMd);
  if (!m) return null;
  const fm: Frontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

/**
 * Validate a candidate skill. Skills have no runnable "test passes" gate like tools, so
 * this enforces the Agent Skills contract deterministically: valid frontmatter (name +
 * description within limits) and a minimal structure (a heading and some body). Quality
 * (rubric) and user approval are layered on top in the tool.
 */
export type SkillValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid-name' | 'no-reason' | 'invalid-frontmatter' | 'invalid-structure'; detail?: string };

export function validateSkill(input: SkillInput): SkillValidation {
  if (!input.name || input.name.length > MAX_NAME || !SKILL_NAME_RE.test(input.name)) {
    return { ok: false, reason: 'invalid-name', detail: input.name };
  }
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, reason: 'no-reason' };
  }
  const fm = parseFrontmatter(input.skillMd);
  if (!fm || !fm.name || !fm.description) {
    return { ok: false, reason: 'invalid-frontmatter', detail: 'missing name/description frontmatter' };
  }
  if (String(fm.description).length > MAX_DESCRIPTION) {
    return { ok: false, reason: 'invalid-frontmatter', detail: 'description exceeds 1024 chars' };
  }
  // Structure: a body after the frontmatter with at least one heading and real content.
  const body = input.skillMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  if (!/^#\s+\S/m.test(body) || body.length < 40) {
    return { ok: false, reason: 'invalid-structure', detail: 'SKILL.md needs a heading and substantive steps' };
  }
  return { ok: true };
}

// ─── resolve (O(1) exact + keyword fallback) ──────────────────────────────────

export function resolveSkill(
  skillType: string,
  intent = '',
  dir = getSkillsDir(),
): SkillResolveResult {
  const idx = readIndex(dir);
  const exact = idx.skills[skillType];
  if (exact) return { hit: 'exact', entry: exact };

  const tokens = tokenize(`${skillType} ${intent}`);
  let best: { entry: SkillManifestEntry; score: number } | null = null;
  for (const entry of Object.values(idx.skills)) {
    const words = tokenize(`${entry.name} ${entry.description}`);
    let score = 0;
    for (const t of tokens) if (words.has(t)) score++;
    if (!best || score > best.score) best = { entry, score };
  }
  if (best && best.score >= KEYWORD_MATCH_THRESHOLD) return { hit: 'keyword', entry: best.entry, score: best.score };
  return { hit: 'miss' };
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

// ─── registration (validation-gated) ──────────────────────────────────────────

export function registerSkill(input: SkillInput, dir = getSkillsDir()): SkillRegisterResult {
  const valid = validateSkill(input);
  if (!valid.ok) return valid as SkillRegisterResult;

  ensureRegistry(dir);
  const sdir = skillDir(dir, input.name);
  const existing = readIndex(dir).skills[input.name];
  fs.mkdirSync(sdir, { recursive: true });
  const skillMdPath = path.join(sdir, 'SKILL.md');
  fs.writeFileSync(skillMdPath, input.skillMd);
  for (const f of input.files ?? []) {
    const target = path.join(sdir, f.relPath);
    if (!path.resolve(target).startsWith(path.resolve(sdir) + path.sep)) continue; // no escapes
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }

  const now = new Date().toISOString();
  const entry: SkillManifestEntry = {
    name: input.name,
    description: input.description,
    dir: sdir,
    skillMd: skillMdPath,
    reason: input.reason.trim(),
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    stats: existing?.stats ?? { uses: 0, lastUsedAt: null },
  };
  withIndexLock(dir, () => {
    const idx = readIndex(dir);
    idx.skills[input.name] = entry;
    writeIndex(dir, idx);
  });
  return { ok: true, entry };
}

// ─── CRUD + maintenance ────────────────────────────────────────────────────────

export function listSkills(dir = getSkillsDir()): SkillManifestEntry[] {
  return Object.values(readIndex(dir).skills);
}

export function deleteSkill(name: string, dir = getSkillsDir()): boolean {
  return withIndexLock(dir, () => {
    const idx = readIndex(dir);
    if (!idx.skills[name]) return false;
    delete idx.skills[name];
    writeIndex(dir, idx);
    fs.rmSync(skillDir(dir, name), { recursive: true, force: true });
    return true;
  });
}

export function recordSkillUse(name: string, dir = getSkillsDir()): void {
  withIndexLock(dir, () => {
    const idx = readIndex(dir);
    const entry = idx.skills[name];
    if (!entry) return;
    entry.stats.uses += 1;
    entry.stats.lastUsedAt = new Date().toISOString();
    writeIndex(dir, idx);
  });
}

/** Prune junk: an index entry whose SKILL.md is missing/unreadable, or invalid frontmatter. */
export function sweepJunkSkills(dir = getSkillsDir()): string[] {
  const pruned: string[] = [];
  for (const entry of listSkills(dir)) {
    let broken = !fs.existsSync(entry.skillMd);
    if (!broken) {
      try {
        const fm = parseFrontmatter(fs.readFileSync(entry.skillMd, 'utf8'));
        broken = !fm || !fm.name || !fm.description;
      } catch {
        broken = true;
      }
    }
    if (broken && deleteSkill(entry.name, dir)) pruned.push(entry.name);
  }
  return pruned;
}
