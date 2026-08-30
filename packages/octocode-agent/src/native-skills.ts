import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEffectSet, RuntimeFailure, type ToolRegistry } from '@octocodeai/agent-core';
import {
  defaultAgentSkillSources,
  discoverAgentSkillInventory,
  effectiveAgentSkills,
  listAgentSkillFiles,
  repositoryDirectories,
  type AgentSkill,
  type AgentSkillInventoryEntry,
  type AgentSkillInventoryResult,
  type AgentSkillSourceDescriptor,
} from '@octocodeai/octocode-shared/agent-skills';

export interface NativeSkillOptions {
  cwd: string;
  homeDir?: string;
  octocodeHome?: string;
  workspaceTrusted?: boolean;
  roots?: readonly string[];
  isEnabled?: (name: string, defaultEnabled: boolean, source: AgentSkillSourceDescriptor) => boolean;
  lifecycle?: NativeSkillLifecycle;
  authorizeMutation?: (request: NativeSkillMutationRequest) => Promise<boolean>;
}

export type NativeSkillMutationAction = 'refresh' | 'enable' | 'disable' | 'install' | 'update' | 'remove';

export interface NativeSkillMutationRequest {
  readonly action: NativeSkillMutationAction;
  readonly name?: string;
  readonly source?: string;
  readonly managedRoot: string;
}

export interface NativeSkillLifecycleResult {
  readonly name: string;
  readonly enabled?: boolean;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface NativeSkillLifecycle {
  readonly managedRoot: string;
  mutate(request: NativeSkillMutationRequest): Promise<NativeSkillLifecycleResult>;
}

export interface NativeSkillSummary {
  readonly name: string;
  readonly description: string;
}

const MAX_SUPPORT_FILE_BYTES = 512 * 1024;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function skillSources(options: NativeSkillOptions): AgentSkillSourceDescriptor[] {
  if (!options.roots) return defaultAgentSkillSources(options.cwd, options.homeDir, options.octocodeHome).map((source) => (
    source.scope === 'workspace' && options.workspaceTrusted === false
      ? { ...source, defaultEnabled: false }
      : source
  ));
  const repositoryRoot = repositoryDirectories(options.cwd)[0] ?? path.resolve(options.cwd);
  return options.roots.map((root, precedence) => {
    const resolvedRoot = path.resolve(root);
    const scope = resolvedRoot === repositoryRoot || resolvedRoot.startsWith(`${repositoryRoot}${path.sep}`) ? 'workspace' : 'user';
    return {
      id: `custom:${scope}:${resolvedRoot}`,
      vendor: 'custom',
      scope,
      root: resolvedRoot,
      precedence,
      defaultEnabled: true,
    };
  });
}

function validatedSkillSources(sources: readonly AgentSkillSourceDescriptor[]): { sources: AgentSkillSourceDescriptor[]; errors: Array<{ path: string; error: string }> } {
  const valid: AgentSkillSourceDescriptor[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const source of sources) {
    try {
      const stat = fs.lstatSync(source.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        errors.push({ path: source.root, error: 'Skill root must be a real directory' });
        continue;
      }
      valid.push({ ...source, root: path.resolve(source.root) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ path: source.root, error: error instanceof Error ? error.message : 'Unreadable skill root' });
    }
  }
  return { sources: valid, errors };
}

export function listNativeSkillInventory(options: NativeSkillOptions): AgentSkillInventoryResult {
  const validation = validatedSkillSources(skillSources(options));
  const inventory = discoverAgentSkillInventory(
    validation.sources,
    options.isEnabled ? (name, source) => options.isEnabled!(name, source.defaultEnabled, source) : undefined,
  );
  return { entries: inventory.entries, errors: [...validation.errors, ...inventory.errors] };
}

export function listNativeSkillSummaries(options: NativeSkillOptions): readonly NativeSkillSummary[] {
  return effectiveAgentSkills(listNativeSkillInventory(options).entries)
    .map(({ name, description }) => Object.freeze({ name, description }));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('skill input must be an object');
  return value as Record<string, unknown>;
}

function publicMetadata(skill: AgentSkill, entries: readonly AgentSkillInventoryEntry[], repositoryRoot: string): Record<string, unknown> {
  const inventory = entries.find((entry) => entry.parseStatus === 'valid' && entry.path === skill.path);
  const resolvedRoot = inventory?.root ?? path.resolve(path.dirname(skill.dir));
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.license ? { license: skill.license } : {}),
    ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
    ...(skill.metadata ? { metadata: skill.metadata } : {}),
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools, allowedToolsPolicy: 'requested-only' } : {}),
    path: skill.path,
    provenance: {
      source: inventory?.source ?? `custom:user:${resolvedRoot}`,
      vendor: inventory?.vendor ?? 'custom',
      scope: inventory?.scope ?? (resolvedRoot === repositoryRoot || resolvedRoot.startsWith(`${repositoryRoot}${path.sep}`) ? 'workspace' : 'user'),
      root: resolvedRoot,
      file: skill.path,
      discoveryOrder: inventory?.precedence ?? 0,
      revision: inventory?.revision ?? `sha256:${createHash('sha256').update(skill.source).digest('hex')}`,
    },
  };
}

function containedPath(root: string, candidate: string, label: string): string {
  const canonical = (value: string): string => {
    const missing: string[] = [];
    let current = path.resolve(value);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
    return path.join(fs.realpathSync(current), ...missing);
  };
  const resolvedRoot = canonical(root);
  const resolved = canonical(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must stay within the workspace`);
  }
  return resolved;
}

export function registerNativeSkillTool(registry: ToolRegistry, options: NativeSkillOptions): void {
  let sourceValidation = validatedSkillSources(skillSources(options));
  let discovery = discoverAgentSkillInventory(
    sourceValidation.sources,
    options.isEnabled ? (name, source) => options.isEnabled!(name, source.defaultEnabled, source) : undefined,
  );
  let skills = effectiveAgentSkills(discovery.entries);
  let byName = new Map(skills.map((skill) => [skill.name, skill]));
  const refreshCatalog = (): void => {
    sourceValidation = validatedSkillSources(skillSources(options));
    discovery = discoverAgentSkillInventory(
      sourceValidation.sources,
      options.isEnabled ? (name, source) => options.isEnabled!(name, source.defaultEnabled, source) : undefined,
    );
    skills = effectiveAgentSkills(discovery.entries);
    byName = new Map(skills.map((skill) => [skill.name, skill]));
  };
  const repositoryRoot = repositoryDirectories(options.cwd)[0] ?? path.resolve(options.cwd);
  const catalog = skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n');
  const lifecycle = options.lifecycle;
  registry.register({
    name: 'skill',
    label: 'Agent Skill',
    description: `List or progressively load Agent Skills and their supporting files${lifecycle ? ', or perform explicitly authorized lifecycle mutations' : ''}. Loading instructions never grants permissions declared by allowed-tools.${catalog ? `\nAvailable:\n${catalog}` : ''}`,
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'load', 'read', 'refresh', 'enable', 'disable', 'install', 'update', 'remove'] },
        name: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    outputVersion: 1,
    policy: lifecycle
      ? { effects: createEffectSet('read', 'write'), trust: 'workspace', approval: 'on-request', plan: 'allowed' }
      : { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan: 'allowed' },
    async execute({ input, context }) {
      // The settings/control plane persists enablement independently of this registry.
      // Re-read it so an already-running agent observes capability changes immediately.
      refreshCatalog();
      const params = requireRecord(input);
      if (params.action === 'list') {
        return { ok: true, content: { skills: skills.map((skill) => publicMetadata(skill, discovery.entries, repositoryRoot)), errors: [...sourceValidation.errors, ...discovery.errors] }, detailsVersion: 1 };
      }
      const mutationActions = new Set<NativeSkillMutationAction>(['refresh', 'enable', 'disable', 'install', 'update', 'remove']);
      if (typeof params.action === 'string' && mutationActions.has(params.action as NativeSkillMutationAction)) {
        if (context.trust.workspace !== 'trusted') throw new RuntimeFailure('trust', 'Skill lifecycle mutations require a trusted workspace');
        if (!lifecycle || !options.authorizeMutation) throw new RuntimeFailure('unsupported-capability', 'Skill lifecycle management is not configured');
        const action = params.action as NativeSkillMutationAction;
        const name = typeof params.name === 'string' ? params.name : undefined;
        if (action !== 'refresh' && (!name || !SKILL_NAME_RE.test(name))) throw new Error(`skill ${action} requires a valid name`);
        const managedRoot = containedPath(repositoryRoot, lifecycle.managedRoot, 'Managed skill root');
        const source = typeof params.source === 'string' ? containedPath(repositoryRoot, params.source, 'Skill source') : undefined;
        if ((action === 'install' || action === 'update') && !source) throw new Error(`skill ${action} requires a source`);
        const request: NativeSkillMutationRequest = { action, ...(name ? { name } : {}), ...(source ? { source } : {}), managedRoot };
        if (!await options.authorizeMutation(request)) throw new RuntimeFailure('trust', 'Skill lifecycle mutation was not authorized');
        const result = await lifecycle.mutate(Object.freeze(request));
        if (!result || typeof result.name !== 'string') throw new Error('Skill lifecycle manager returned invalid result');
        requireRecord(result.provenance);
        refreshCatalog();
        return { ok: true, content: result, detailsVersion: 1 };
      }
      if ((params.action !== 'load' && params.action !== 'read') || typeof params.name !== 'string') throw new Error('skill load/read requires a name');
      const skill = byName.get(params.name);
      if (!skill) throw new Error(`Unknown or disabled skill: ${params.name}`);
      const skillPath = path.resolve(skill.path);
      const workspaceSkill = skillPath === repositoryRoot || skillPath.startsWith(`${repositoryRoot}${path.sep}`);
      if (workspaceSkill && context.trust.workspace !== 'trusted') {
        throw new RuntimeFailure('trust', 'Loading workspace skill instructions requires a trusted workspace');
      }
      if (params.action === 'read') {
        if (typeof params.file !== 'string' || !params.file.trim()) throw new Error('skill read requires a file');
        const root = fs.realpathSync(skill.dir);
        const requested = path.resolve(root, params.file);
        let resolved: string;
        try { resolved = fs.realpathSync(requested); }
        catch { throw new Error(`Unknown skill file: ${params.file}`); }
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Skill file must stay within the skill directory');
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size > MAX_SUPPORT_FILE_BYTES) throw new Error('Skill file is not a readable bounded file');
        const content = fs.readFileSync(resolved, 'utf8');
        if (content.includes('\0')) throw new Error('Skill file must be text');
        return { ok: true, content: { name: skill.name, file: path.relative(root, resolved), content }, detailsVersion: 1 };
      }
      return {
        ok: true,
        content: {
          ...publicMetadata(skill, discovery.entries, repositoryRoot),
          instructions: skill.body,
          files: listAgentSkillFiles(skill.dir),
        },
        detailsVersion: 1,
      };
    },
  }, 'agent-skills');
}
