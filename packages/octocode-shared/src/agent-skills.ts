import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { getOctocodeHome } from '@octocodeai/config';

const NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const MAX_DESCRIPTION = 1_024;
const MAX_COMPATIBILITY = 500;
const MAX_SKILL_BYTES = 512 * 1024;

export interface AgentSkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Experimental Agent Skills field. It is descriptive and never grants runtime permission. */
  allowedTools?: string;
}

export interface AgentSkill extends AgentSkillMetadata {
  dir: string;
  path: string;
  body: string;
  source: string;
}

export type AgentSkillParseResult =
  | { ok: true; skill: Omit<AgentSkill, 'dir' | 'path'> }
  | { ok: false; error: string };

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function parseAgentSkill(source: string, directoryName?: string): AgentSkillParseResult {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return { ok: false, error: 'SKILL.md must start with YAML frontmatter' };
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { ok: false, error: 'SKILL.md frontmatter is not closed' };
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0) return { ok: false, error: `Invalid YAML frontmatter: ${document.errors[0]!.message}` };
  const raw = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Skill frontmatter must be a mapping' };
  const record = raw as Record<string, unknown>;
  const name = stringField(record, 'name');
  const description = stringField(record, 'description');
  if (!name || !NAME_RE.test(name)) return { ok: false, error: 'Skill name must match the Agent Skills naming rules' };
  if (directoryName !== undefined && name !== directoryName) return { ok: false, error: `Skill name ${name} must match parent directory ${directoryName}` };
  if (!description || description.length > MAX_DESCRIPTION) return { ok: false, error: 'Skill description must contain 1-1024 characters' };
  const license = record.license === undefined ? undefined : stringField(record, 'license');
  if (record.license !== undefined && !license) return { ok: false, error: 'Skill license must be a non-empty string' };
  const compatibility = record.compatibility === undefined ? undefined : stringField(record, 'compatibility');
  if (record.compatibility !== undefined && (!compatibility || compatibility.length > MAX_COMPATIBILITY)) {
    return { ok: false, error: 'Skill compatibility must contain 1-500 characters' };
  }
  let metadata: Record<string, string> | undefined;
  if (record.metadata !== undefined) {
    if (typeof record.metadata !== 'object' || record.metadata === null || Array.isArray(record.metadata)) return { ok: false, error: 'Skill metadata must be a mapping' };
    const entries = Object.entries(record.metadata as Record<string, unknown>);
    if (entries.some(([key, value]) => !key || typeof value !== 'string')) return { ok: false, error: 'Skill metadata keys and values must be strings' };
    metadata = Object.fromEntries(entries) as Record<string, string>;
  }
  const allowedTools = record['allowed-tools'] === undefined ? undefined : stringField(record, 'allowed-tools');
  if (record['allowed-tools'] !== undefined && !allowedTools) return { ok: false, error: 'Skill allowed-tools must be a non-empty string' };
  const body = source.slice(match[0].length);
  return {
    ok: true,
    skill: {
      name,
      description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(metadata ? { metadata } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      body,
      source,
    },
  };
}

export interface AgentSkillDiscoveryResult {
  skills: AgentSkill[];
  errors: Array<{ path: string; error: string }>;
}

export function discoverAgentSkills(roots: readonly string[]): AgentSkillDiscoveryResult {
  const skills = new Map<string, AgentSkill>();
  const errors: AgentSkillDiscoveryResult['errors'] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(root, entry.name);
      const skillPath = path.join(dir, 'SKILL.md');
      try {
        const stat = fs.statSync(skillPath);
        if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`);
        const parsed = parseAgentSkill(fs.readFileSync(skillPath, 'utf8'), entry.name);
        if (!parsed.ok) throw new Error(parsed.error);
        skills.set(parsed.skill.name, { ...parsed.skill, dir, path: skillPath });
      } catch (error) {
        if (fs.existsSync(skillPath)) errors.push({ path: skillPath, error: error instanceof Error ? error.message : 'Invalid skill' });
      }
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function defaultAgentSkillRoots(cwd: string, homeDir = os.homedir(), octocodeHome = getOctocodeHome()): string[] {
  const relativeRoots = ['.pi/skills', '.claude/skills', '.cursor/skills', '.codex/skills', '.agents/skills', '.octocode/skills'];
  const projectDirectories = repositoryDirectories(cwd);
  return [
    ...relativeRoots.map((relative) => path.join(homeDir, relative)),
    path.join(homeDir, '.pi', 'agent', 'skills'),
    path.join(octocodeHome, 'skills'),
    ...projectDirectories.flatMap((directory) => relativeRoots.map((relative) => path.join(directory, relative))),
  ];
}

export function repositoryDirectories(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const descending = [resolved];
  let current = resolved;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return descending.reverse();
    const parent = path.dirname(current);
    if (parent === current) return [resolved];
    descending.push(parent);
    current = parent;
  }
}

export function listAgentSkillFiles(skillDir: string, maxDepth = 2, maxFiles = 30): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile() && absolute !== path.join(skillDir, 'SKILL.md')) files.push(path.relative(skillDir, absolute));
    }
  };
  visit(skillDir, 0);
  return files;
}
