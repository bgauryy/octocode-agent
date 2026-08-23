/**
 * skill — the Octocode-owned model-facing skill flow (replaces Pi's read-based flow).
 *
 * Pi's own flow advertises skills in the prompt and tells the model to `read`
 * the SKILL.md — but Octocode removes the weak `read` builtin, and Pi's docs
 * themselves note models don't reliably follow that hop. This tool makes skill
 * loading first-class (the Claude Code / agentskills.io pattern): the model
 * calls `skill({action:"load", name})` and gets the full SKILL.md plus the
 * skill's directory and shipped scripts/assets in one observable step.
 *
 * Observability: every load is recorded in a per-session usage ledger (count +
 * last load), rendered as a branded tool row in the TUI, surfaced in the
 * /octocode-skills dashboard, and exported to the discovery file.
 *
 * Discovery merges Pi's live catalog (systemPromptOptions.skills — authority
 * when present) with a disk scan of the same roots Pi reads, so the tool works
 * before turn 1 and in headless runs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext, SkillInfo, TSchema } from '../types.js';
import { getAssetPaths } from '../assets.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { stringEnumSchema } from './schema-helpers.js';
import { paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Skill root directory (parent of SKILL.md) — relative paths resolve against it. */
  dir: string;
  /** Where it came from: bundled | user | project | pi. */
  source: string;
}

/** Cap on SKILL.md bytes returned to the model — a skill is instructions, not a data dump. */
const SKILL_CONTENT_CAP = 48_000;
/** Cap on listed sibling files per skill. */
const SKILL_FILE_LIST_CAP = 30;

const PROMPT_OWNED_SKILLS = new Set([
  // Awareness Lite coordination is embedded in <awareness>; exposing the old
  // SKILL.md makes the model load duplicate instructions and creates noisy UI rows.
  'octocode-awareness-lite',
]);

function isPromptOwnedSkill(name: string): boolean {
  return PROMPT_OWNED_SKILLS.has(name.toLowerCase());
}

// ─── Discovery ────────────────────────────────────────────────────────────────

function parseFrontmatterField(text: string, field: string): string {
  const match = text.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function scanSkillRoot(dir: string, source: string, out: Map<string, DiscoveredSkill>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Follow Pi's rule: a directory containing SKILL.md is a skill root.
    const skillDir = path.join(dir, entry.name);
    const md = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    let text = '';
    try {
      text = fs.readFileSync(md, 'utf8');
    } catch {
      continue;
    }
    const name = parseFrontmatterField(text, 'name') || entry.name;
    if (isPromptOwnedSkill(name)) continue;
    if (out.has(name)) continue; // earlier roots win (bundled < user < project ordering handled by caller)
    out.set(name, {
      name,
      description: parseFrontmatterField(text, 'description'),
      path: md,
      dir: skillDir,
      source,
    });
  }
}

/**
 * Common skill roots across agent ecosystems, most-authoritative first.
 * Project roots beat user roots; within a scope the vendor-neutral `.agents`
 * standard beats host-specific dirs. Dedupe is by skill NAME — the first root
 * that provides a name wins.
 */
export function skillDiscoveryRoots(cwd: string, home = os.homedir()): Array<{ dir: string; source: string }> {
  const project = (rel: string, host: string): { dir: string; source: string } =>
    ({ dir: path.join(cwd, ...rel.split('/')), source: host === 'agents' ? 'project' : `project:${host}` });
  const user = (rel: string, host: string): { dir: string; source: string } =>
    ({ dir: path.join(home, ...rel.split('/')), source: host === 'pi' ? 'user' : `user:${host}` });
  return [
    project('.agents/skills', 'agents'),
    project('.claude/skills', 'claude'),
    project('.cursor/skills', 'cursor'),
    project('.codex/skills', 'codex'),
    project('.octocode/skills', 'octocode'),
    project('.pi/agent/skills', 'pi'),
    project('.pi/skills', 'pi'),
    user('.pi/agent/skills', 'pi'),
    user('.pi/skills', 'pi'),
    user('.claude/skills', 'claude'),
    user('.cursor/skills', 'cursor'),
    user('.codex/skills', 'codex'),
    user('.octocode/skills', 'octocode'),
  ];
}

/**
 * Discover every skill visible to this session across the common ecosystem
 * roots (agents/claude/cursor/codex/octocode/pi — project and user scope) plus
 * the extension-bundled set, deduped by NAME. Pi-provided entries (when given)
 * take precedence — they are the live session authority and may include roots
 * configured via Pi settings that the scan cannot know about.
 */
export function discoverSkills(cwd: string, piSkills?: SkillInfo[], home = os.homedir()): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>();
  for (const skill of piSkills ?? []) {
    const name = skill.name?.trim();
    if (!name || isPromptOwnedSkill(name)) continue;
    const md = (skill as { path?: string; filePath?: string }).path
      ?? (skill as { path?: string; filePath?: string }).filePath ?? '';
    found.set(name, {
      name,
      description: skill.description ?? '',
      path: md,
      dir: md ? path.dirname(md) : '',
      source: [skill.source, skill.scope].filter(Boolean).join('/') || 'pi',
    });
  }
  for (const root of skillDiscoveryRoots(cwd, home)) scanSkillRoot(root.dir, root.source, found);
  try {
    scanSkillRoot(getAssetPaths().skillsDir, 'bundled', found);
  } catch {
    // Bundled assets unresolved (broken install) — discovery still works from disk roots.
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Usage ledger (session observability) ─────────────────────────────────────

export interface SkillUsageEntry {
  count: number;
  lastLoadedAt: number;
}

const usage = new Map<string, SkillUsageEntry>();

export function recordSkillLoad(name: string, now = Date.now()): void {
  const entry = usage.get(name) ?? { count: 0, lastLoadedAt: 0 };
  entry.count += 1;
  entry.lastLoadedAt = now;
  usage.set(name, entry);
}

export function getSkillUsage(): ReadonlyMap<string, SkillUsageEntry> {
  return usage;
}

export function resetSkillUsageForTests(): void {
  usage.clear();
}

/** Compact "recently loaded" lines for dashboards; empty array when nothing was loaded. */
export function formatSkillUsageLines(): string[] {
  return [...usage.entries()]
    .sort((a, b) => b[1].lastLoadedAt - a[1].lastLoadedAt)
    .slice(0, 10)
    .map(([name, entry]) => `- ${name}: loaded ${entry.count}×`);
}

// ─── Tool implementation ──────────────────────────────────────────────────────

function result(text: string, details?: unknown, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text }], details, isError };
}

function listSkillFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string, depth: number): void => {
    if (depth > 2 || files.length >= SKILL_FILE_LIST_CAP) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= SKILL_FILE_LIST_CAP) return;
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel, depth + 1);
      else if (entry.name !== 'SKILL.md') files.push(rel);
    }
  };
  walk(dir, '', 0);
  return files;
}

function loadSkill(skill: DiscoveredSkill): ToolCallResult {
  let text: string;
  try {
    text = fs.readFileSync(skill.path, 'utf8');
  } catch (error) {
    return result(`skill "${skill.name}": cannot read ${skill.path}: ${(error as Error).message}`, undefined, true);
  }
  const capped = text.length <= SKILL_CONTENT_CAP
    ? text
    : `${text.slice(0, SKILL_CONTENT_CAP)}\n…[truncated ${text.length - SKILL_CONTENT_CAP} chars — read the rest from ${skill.path} if needed]`;
  const files = listSkillFiles(skill.dir);
  recordSkillLoad(skill.name);
  const lines = [
    `skill: ${skill.name} [${skill.source}]`,
    `directory: ${skill.dir}`,
    'Resolve every relative path in the skill against this directory. Follow the skill now.',
    files.length > 0 ? `files: ${files.join(', ')}` : '',
    '---',
    capped,
  ].filter(Boolean);
  return result(lines.join('\n'), { name: skill.name, dir: skill.dir, files });
}

function formatSkillList(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return 'No skills discovered. Install with: npx octocode skill --name <skill> --platform pi';
  const lines = skills.map((skill) => {
    const used = usage.get(skill.name);
    const usedNote = used ? ` (loaded ${used.count}× this session)` : '';
    return `- ${skill.name} [${skill.source}]${usedNote}: ${skill.description || '(no description)'}`;
  });
  return [`${skills.length} skill(s) available — load one with skill({action:"load", name:"…", reason:"why it matches"}) when the task matches:`, ...lines].join('\n');
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerSkillTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
  getPiSkills: () => SkillInfo[] | undefined,
): void {
  const parameters = Type.Object({
    action: Type.Optional(stringEnumSchema(
      Type,
      ['load', 'list'],
      'load (default): return one skill\'s full SKILL.md + directory + files. list: catalog of every discovered skill.',
    ) as TSchema),
    name: Type.Optional(Type.String({ description: 'Skill name for action:load (exact name from <available_skills> or action:list).' })),
    reason: Type.Optional(Type.String({
      minLength: 1,
      description: 'Required for action:load. One concise, user-facing clause explaining why this skill matches the current task.',
    })),
  }, { additionalProperties: false }) as TSchema;

  const execute = async (_id: string, params: Record<string, unknown>, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: PiContext): Promise<ToolCallResult> => {
    const action = params['action'] === 'list' ? 'list' : 'load';
    const skills = discoverSkills(ctx?.cwd ?? process.cwd(), getPiSkills());
    if (action === 'list') return result(formatSkillList(skills), { skills });
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    if (!name) return result('skill load requires name. Use skill({action:"list"}) for the catalog.', undefined, true);
    const reason = typeof params['reason'] === 'string' ? params['reason'].trim() : '';
    if (!reason) return result('skill load requires reason explaining why it matches the current task.', undefined, true);
    const skill = skills.find((candidate) => candidate.name === name)
      ?? skills.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      return result(`Unknown skill: ${name}\nAvailable: ${skills.map((s) => s.name).join(', ') || 'none'}`, { skills: skills.map((s) => s.name) }, true);
    }
    if (!skill.path) return result(`skill "${skill.name}" has no resolvable SKILL.md path.`, undefined, true);
    return loadSkill(skill);
  };

  const renderCall = (args: unknown, theme?: PiTheme) => {
    const p = (args ?? {}) as Record<string, unknown>;
    const isList = p['action'] === 'list';
    const target = isList ? 'list' : String(p['name'] ?? '?');
    const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : '';
    const why = !isList && reason
      ? ` ${paint(theme, 'warning', 'why:')} ${paint(theme, 'bright', reason)}`
      : '';
    return makeRenderer((width) => [truncateToWidth(
      `${paint(theme, 'brand', '◆ skill')} ${paint(theme, 'dim', '·')} ${paint(theme, 'title', target)}${why}`, width)]);
  };

  const renderResult = (resultValue: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) => {
    // The call row already explains which skill was selected and why. Keep the
    // successful SKILL.md payload model-only; only actionable failures belong in
    // the terminal transcript.
    if (!resultValue.isError) return makeRenderer(() => []);

    const text = (resultValue.content[0] as { text?: string } | undefined)?.text ?? '';
    const head = text.split('\n')[0] ?? 'skill';
    return makeRenderer((width) => {
      const lines = [truncateToWidth(`${paint(theme, 'error', '✗')} ${paint(theme, 'title', 'skill')} ${paint(theme, 'dim', `· ${head}`)}`, width)];
      if (opts.expanded) {
        for (const line of text.split('\n').slice(1, 12)) lines.push(truncateToWidth(paint(theme, 'dim', line), width));
      }
      return lines;
    });
  };

  registerFn(pi, registeredToolNames, {
    name: 'skill',
    label: 'skill',
    description: 'Load an Agent Skill by name and explain why it matches the current task (returns its full SKILL.md, directory, and shipped files), or list every discovered skill. This is THE way to load a skill — do not hunt for SKILL.md paths manually.',
    promptSnippet: 'skill loads Agent Skills: skill({action:"load", name:"…", reason:"…"}) returns the full SKILL.md + skill directory; skill({action:"list"}) shows the catalog with session usage. Load the minimal matching skill BEFORE acting and state why it matches.',
    promptGuidelines: [
      'When loading a skill, pass reason as one concise, user-facing clause that explains why the skill matches the current task.',
    ],
    parameters,
    execute,
    renderCall,
    renderResult,
  });
}
