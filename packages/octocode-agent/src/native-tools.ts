import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createEffectSet, jsonSchemaError, ToolRegistry, type EffectSet, type JsonSchema } from '@octocodeai/agent-core';
import { agentDbPath, closeOctocodeDb, ensurePrivateDirectory, getMcpEnablement, getSkillEnablement, listMcpOverrides, openOctocodeDb, setMcpServerEnabled, setMcpToolEnabled, setSkillEnabled } from '@octocodeai/octocode-awareness/mcp-state';
import { defaultAgentSkillRoots, discoverAgentSkills, parseAgentSkill } from '@octocodeai/octocode-shared/agent-skills';
import { agentHome, getOctocodeHome } from '@octocodeai/octocode-shared/paths';
import path from 'node:path';
import os from 'node:os';
import { registerNativeAwarenessTool, type NativeAwarenessOptions } from './native-awareness.js';
import type { NativeInteractionBroker } from './native-interactions.js';
import type { NativeHookMcpExecutor } from './native-hook-dispatcher.js';
import { loadNativeMcpServers, registerNativeMcpTool, type NativeMcpElicitationRequest, type NativeMcpElicitationResult, type NativeMcpOptions, type NativeMcpSessionManager } from './native-mcp.js';
import { registerNativePlanTool, type NativePlanOptions } from './native-plan.js';
import { listNativeSkillInventory, registerNativeSkillTool, type NativeSkillLifecycleResult, type NativeSkillMutationRequest, type NativeSkillOptions } from './native-skills.js';
import type { NativeSettingsCapabilityControl } from './native-settings-page.js';

export interface OctocodeCatalogTool {
  name: string;
  description: string;
  category?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface OctocodeCatalog {
  kind: 'octocode.toolCatalog.full';
  version: 1;
  toolCount: number;
  tools: readonly OctocodeCatalogTool[];
}

export type OctocodeFacadeErrorCode =
  | 'catalog-invalid'
  | 'execution-cancelled'
  | 'execution-failed'
  | 'execution-invalid'
  | 'output-invalid';

/** Stable, redacted failure exposed by the native Octocode facade. */
export class OctocodeFacadeError extends Error {
  constructor(readonly code: OctocodeFacadeErrorCode, message: string) {
    super(message);
    this.name = 'OctocodeFacadeError';
  }
}

export type OctocodeToolExecutor = (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
export type OctocodeCommandRunner = (
  args: readonly string[],
  options?: { signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

const CATALOG_CACHE_TTL_MS = 60_000;
const CATALOG_CACHE_MAX_ENTRIES = 32;
const catalogCache = new Map<string, { expiresAt: number; value: Promise<OctocodeCatalog> }>();
const catalogCacheCounters = { hits: 0, misses: 0, loads: 0, loadFailures: 0, expirations: 0, evictions: 0 };
const runnerIds = new WeakMap<OctocodeCommandRunner, number>();
const registryMcpManagers = new WeakMap<ToolRegistry, NativeMcpSessionManager>();
let nextRunnerId = 0;
const MAX_COMPOSED_SKILL_FILES = 128;
const MAX_COMPOSED_SKILL_BYTES = 2 * 1024 * 1024;
const SENSITIVE_ELICITATION_RE = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown failure';
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:api[-_]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function catalogError(message: string): OctocodeFacadeError {
  return new OctocodeFacadeError('catalog-invalid', `Octocode catalog ${message}`);
}

function assertOctocodeCatalog(value: unknown): asserts value is OctocodeCatalog {
  if (!isRecord(value) || value.kind !== 'octocode.toolCatalog.full') throw catalogError('protocol kind is unsupported');
  if (value.version !== 1) throw catalogError('protocol version is unsupported');
  if (!Array.isArray(value.tools) || !Number.isInteger(value.toolCount) || value.toolCount !== value.tools.length) {
    throw catalogError('tool count is invalid');
  }
  const names = new Set<string>();
  for (const candidate of value.tools) {
    if (!isRecord(candidate)
      || typeof candidate.name !== 'string' || candidate.name.length === 0
      || typeof candidate.description !== 'string' || candidate.description.length === 0
      || !isRecord(candidate.inputSchema)
      || (candidate.outputSchema !== undefined && !isRecord(candidate.outputSchema))
      || (candidate.category !== undefined && typeof candidate.category !== 'string')) {
      throw catalogError('contains an invalid schema');
    }
    if (names.has(candidate.name)) throw catalogError(`contains a duplicate tool: ${candidate.name}`);
    names.add(candidate.name);
  }
}

function assertValidToolOutput(name: string, value: unknown, schema: JsonSchema | undefined): void {
  try {
    if (JSON.stringify(value) === undefined) throw new TypeError('serialized to undefined');
  } catch {
    throw new OctocodeFacadeError('output-invalid', `Octocode tool ${name} returned non-JSON output`);
  }
  const schemaFailure = schema === undefined ? undefined : jsonSchemaError(value, schema, '$.content');
  if (schemaFailure) throw new OctocodeFacadeError('output-invalid', `Octocode tool ${name} returned invalid output: ${schemaFailure}`);
}

function canonicalLocalPath(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

export interface NativeCapabilityCompositionOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactions: NativeInteractionBroker;
  readonly workspaceTrust: 'trusted' | 'untrusted' | 'unknown';
}

export interface NativeCapabilityComposition {
  readonly mcp: Omit<NativeMcpOptions, 'cwd' | 'env' | 'homeDir' | 'isEnabled'>;
  readonly skills: Omit<NativeSkillOptions, 'cwd' | 'homeDir' | 'isEnabled'>;
}

function elicitationField(request: NativeMcpElicitationRequest): { key: string; schema: Record<string, unknown> } | undefined {
  if (request.mode !== 'form' || !request.requestedSchema) return undefined;
  const properties = request.requestedSchema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return undefined;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length !== 1 || SENSITIVE_ELICITATION_RE.test(entries[0]![0])) return undefined;
  const [key, value] = entries[0]!;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>;
  if (schema.writeOnly === true || schema.format === 'password') return undefined;
  return { key, schema };
}

async function brokerElicitation(
  broker: NativeInteractionBroker,
  trust: NativeCapabilityCompositionOptions['workspaceTrust'],
  request: NativeMcpElicitationRequest,
): Promise<NativeMcpElicitationResult> {
  if (trust !== 'trusted') return { action: 'decline' };
  const field = elicitationField(request);
  if (!field) return { action: 'decline' };
  const signal = request.signal ?? new AbortController().signal;
  const values = Array.isArray(field.schema.enum) && field.schema.enum.length >= 2 && field.schema.enum.length <= 100
    && field.schema.enum.every((value) => typeof value === 'string') ? field.schema.enum as string[] : undefined;
  const interaction = values
    ? { type: 'select' as const, message: request.message, options: values }
    : field.schema.type === 'boolean'
      ? { type: 'confirm' as const, message: request.message }
      : field.schema.type === 'string'
        ? { type: 'input' as const, message: request.message }
        : undefined;
  if (!interaction) return { action: 'decline' };
  const result = await broker.interact(interaction, signal);
  if (result.status === 'cancelled' || result.status === 'timeout') return { action: 'cancel' };
  if (result.status !== 'accepted') return { action: 'decline' };
  if (interaction.type === 'confirm') return result.value === true
    ? { action: 'accept', content: { [field.key]: true } }
    : { action: 'decline' };
  if (typeof result.value !== 'string' || (values && !values.includes(result.value))) return { action: 'decline' };
  return { action: 'accept', content: { [field.key]: result.value } };
}

function copyBoundedSkill(source: string, target: string, name: string): string {
  let files = 0;
  let bytes = 0;
  const visit = (from: string, to: string, depth: number): void => {
    if (depth > 4) throw new Error('Skill source exceeds the maximum depth');
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('Skill source must not contain symbolic links');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { mode: 0o700 });
      for (const entry of fs.readdirSync(from).sort()) visit(path.join(from, entry), path.join(to, entry), depth + 1);
      return;
    }
    if (!stat.isFile() || ++files > MAX_COMPOSED_SKILL_FILES || (bytes += stat.size) > MAX_COMPOSED_SKILL_BYTES) {
      throw new Error('Skill source exceeds its bounded file budget');
    }
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(to, stat.mode & 0o100 ? 0o700 : 0o600);
  };
  visit(source, target, 0);
  const manifest = path.join(target, 'SKILL.md');
  const parsed = parseAgentSkill(fs.readFileSync(manifest, 'utf8'), name);
  if (!parsed.ok) throw new Error(`Invalid installed skill: ${parsed.error}`);
  return createHash('sha256').update(parsed.skill.source).digest('hex');
}

function skillLifecycle(options: NativeCapabilityCompositionOptions, managedRoot: string) {
  const roots = defaultAgentSkillRoots(options.cwd, options.env.HOME ?? os.homedir(), options.env.OCTOCODE_HOME ?? getOctocodeHome(options.env));
  const known = (name: string, source?: string): boolean => listNativeSkillInventory({
    cwd: options.cwd,
    homeDir: options.env.HOME ?? os.homedir(),
    octocodeHome: options.env.OCTOCODE_HOME ?? getOctocodeHome(options.env),
    workspaceTrusted: options.workspaceTrust === 'trusted',
  }).entries.some((entry) => entry.name === name && (source === undefined || entry.source === source));
  return {
    managedRoot,
    async mutate(request: NativeSkillMutationRequest): Promise<NativeSkillLifecycleResult> {
      const name = request.name ?? 'catalog';
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new Error('Skill lifecycle name is invalid');
      if (request.action === 'refresh') {
        const discovery = discoverAgentSkills(roots);
        const revision = createHash('sha256').update(discovery.skills.map((skill) => `${skill.name}:${skill.path}`).join('\n')).digest('hex');
        return { name, provenance: { scope: 'workspace', operation: 'refresh', count: discovery.skills.length, errors: discovery.errors.length, revision } };
      }
      const target = path.join(managedRoot, name);
      if ((request.action === 'enable' || request.action === 'disable')) {
        if (!known(name, request.source)) throw new Error(`Unknown skill: ${name}`);
        const dbFile = agentDbPath(options.env);
        const db = openOctocodeDb(dbFile);
        try { setSkillEnabled(db, options.cwd, name, request.action === 'enable', request.source); }
        finally { closeOctocodeDb(dbFile); }
        return { name, enabled: request.action === 'enable', provenance: { scope: 'workspace', operation: request.action, source: 'settings', revision: `sqlite:${options.cwd}:${name}` } };
      }
      if (request.action === 'remove') {
        if (!fs.existsSync(target)) throw new Error(`Skill is not installed in the managed workspace root: ${name}`);
        fs.rmSync(target, { recursive: true, force: false });
        return { name, enabled: false, provenance: { scope: 'workspace', operation: 'remove', source: target, revision: 'removed' } };
      }
      if (!request.source) throw new Error(`Skill ${request.action} requires a source`);
      const workspace = fs.realpathSync(path.resolve(options.cwd));
      const source = fs.realpathSync(request.source);
      if (source !== workspace && !source.startsWith(`${workspace}${path.sep}`)) throw new Error('Skill source must stay within the workspace');
      const exists = fs.existsSync(target);
      if (request.action === 'install' && exists) throw new Error(`Skill is already installed: ${name}`);
      if (request.action === 'update' && !exists) throw new Error(`Skill is not installed: ${name}`);
      ensurePrivateDirectory(managedRoot);
      const stage = path.join(managedRoot, `.${name}.${process.pid}.${Date.now()}.tmp`);
      const backup = path.join(managedRoot, `.${name}.${process.pid}.${Date.now()}.bak`);
      try {
        const revision = copyBoundedSkill(source, stage, name);
        if (exists) fs.renameSync(target, backup);
        try { fs.renameSync(stage, target); }
        catch (error) { if (exists && fs.existsSync(backup)) fs.renameSync(backup, target); throw error; }
        if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
        return { name, enabled: true, provenance: { scope: 'workspace', operation: request.action, source, target, revision: `sha256:${revision}` } };
      } finally {
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      }
    },
  };
}

/** Compose production MCP/Skill policy from launcher-owned interaction and trust state. */
export function createNativeCapabilityComposition(options: NativeCapabilityCompositionOptions): NativeCapabilityComposition {
  const declaredAgentRoot = path.resolve(agentHome(options.env));
  if (fs.existsSync(declaredAgentRoot) && fs.lstatSync(declaredAgentRoot).isSymbolicLink()) {
    throw new Error('Managed skill root cannot redirect the global agent home');
  }
  fs.mkdirSync(declaredAgentRoot, { recursive: true, mode: 0o700 });
  const managedAgentRoot = canonicalLocalPath(declaredAgentRoot);
  const managedRoot = canonicalLocalPath(path.join(managedAgentRoot, 'skills'));
  if (managedRoot !== managedAgentRoot && !managedRoot.startsWith(`${managedAgentRoot}${path.sep}`)) {
    throw new Error('Managed skill root must stay within the global agent home');
  }
  const lifecycle = skillLifecycle(options, managedRoot);
  return {
    mcp: { elicit: (request) => brokerElicitation(options.interactions, options.workspaceTrust, request) },
    skills: {
      lifecycle,
      workspaceTrusted: options.workspaceTrust === 'trusted',
      authorizeMutation: async (request) => {
        if (options.workspaceTrust !== 'trusted') return false;
        if (request.action === 'refresh') return true;
        const result = await options.interactions.interact({
          type: 'confirm',
          message: `Allow skill ${request.action} for ${request.name ?? 'catalog'} in ${managedRoot}?`,
        }, new AbortController().signal);
        return result.status === 'accepted' && result.value === true;
      },
    },
  };
}

/** Compose the settings page onto the same SQLite and authorized Skill lifecycle used by native tools. */
export function createNativeSettingsCapabilityControl(options: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly skills: NativeCapabilityComposition['skills'];
}): NativeSettingsCapabilityControl {
  const scope = path.resolve(options.cwd);
  const snapshot = () => {
    const dbFile = agentDbPath(options.env);
    const db = openOctocodeDb(dbFile);
    try {
      const servers = loadNativeMcpServers({ cwd: scope, env: options.env });
      const overrides = [...listMcpOverrides(db, '*').tools, ...listMcpOverrides(db, scope).tools];
      const mcpServers = Object.keys(servers).sort().map((name) => ({
        name,
        enabled: getMcpEnablement(db, scope, name, undefined, servers[name]?.defaultEnabled ?? true),
        source: servers[name]?.discovered?.host ?? 'octocode',
        path: servers[name]?.provenance?.file,
        tools: [...new Set(overrides.filter(({ serverKey }) => serverKey === name).map(({ toolName }) => toolName))].sort().map((tool) => ({ tool, name: tool, enabled: getMcpEnablement(db, scope, name, tool, true) })).map(({ name, enabled }) => ({ name, enabled })),
      }));
      const skills = listNativeSkillInventory({
        cwd: scope,
        homeDir: options.env.HOME ?? os.homedir(),
        octocodeHome: getOctocodeHome(options.env),
        workspaceTrusted: options.skills.workspaceTrusted,
        isEnabled: (name, defaultEnabled, source) => getSkillEnablement(db, scope, name, defaultEnabled, source.id),
      }).entries.map((entry) => ({
        name: entry.name,
        enabled: entry.enabled,
        source: entry.source,
        vendor: entry.vendor,
        path: entry.path,
      }));
      const revision = createHash('sha256').update(JSON.stringify({ mcpServers, skills })).digest('hex');
      return { revision, mcpServers, skills };
    } finally { closeOctocodeDb(dbFile); }
  };
  return {
    snapshot,
    async mutate({ requestId: _requestId, expectedRevision, action }) {
      if (snapshot().revision !== expectedRevision) return { ok: false, revision: snapshot().revision, error: 'Capabilities changed; refresh and try again.' };
      if (action.op === 'refresh-skills' || action.op === 'set-skill-enabled') {
        const lifecycle = options.skills.lifecycle;
        const authorizeMutation = options.skills.authorizeMutation;
        if (!lifecycle || !authorizeMutation) return { ok: false, revision: expectedRevision, error: 'Skill mutation is unavailable.' };
        const request: NativeSkillMutationRequest = action.op === 'refresh-skills'
          ? { action: 'refresh', managedRoot: lifecycle.managedRoot }
          : { action: action.enabled ? 'enable' : 'disable', name: action.name, source: action.source, managedRoot: lifecycle.managedRoot };
        if (!await authorizeMutation(request)) return { ok: false, revision: expectedRevision, error: 'Skill mutation was not authorized.' };
        await lifecycle.mutate(request);
      } else {
        const current = snapshot();
        if (!current.mcpServers.some(({ name }) => name === action.server)) return { ok: false, revision: current.revision, error: 'Unknown MCP server.' };
        const dbFile = agentDbPath(options.env);
        const db = openOctocodeDb(dbFile);
        try {
          if (action.op === 'set-mcp-tool-enabled') setMcpToolEnabled(db, scope, action.server, action.tool, action.enabled);
          else setMcpServerEnabled(db, scope, action.server, action.enabled);
        } finally { closeOctocodeDb(dbFile); }
      }
      return { ok: true, revision: snapshot().revision };
    },
  };
}

function catalogCacheKey(run: OctocodeCommandRunner, cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): string {
  let runnerId = runnerIds.get(run);
  if (runnerId === undefined) { runnerId = ++nextRunnerId; runnerIds.set(run, runnerId); }
  const effectiveEnv = env ?? process.env;
  const catalogEnv = ['ENABLE_CLONE', 'ENABLE_DISCUSSIONS', 'ENABLE_LOCAL', 'ENABLE_RELEASES', 'OCTOCODE_HOME']
    .map((key) => [key, effectiveEnv[key] ?? null]);
  return JSON.stringify([runnerId, path.resolve(cwd ?? process.cwd()), catalogEnv]);
}

function effectsFor(tool: OctocodeCatalogTool): EffectSet {
  if (tool.name === 'ghCloneRepo') return createEffectSet('network', 'process', 'write');
  return tool.category === 'GitHub' || tool.category === 'npm' || tool.name.startsWith('gh') || tool.name === 'npmSearch'
    ? createEffectSet('network')
    : createEffectSet('read');
}

export function createOctocodeToolRegistry(catalog: OctocodeCatalog, execute: OctocodeToolExecutor, options: {
  plan?: NativePlanOptions;
  awareness?: NativeAwarenessOptions;
  allowedTools?: ReadonlySet<string>;
} = {}): ToolRegistry {
  assertOctocodeCatalog(catalog);
  const registry = new ToolRegistry();
  for (const tool of catalog.tools) {
    if (options.allowedTools !== undefined && !options.allowedTools.has(tool.name)) continue;
    const effects = effectsFor(tool);
    const gated = effects.some((effect) => effect !== 'read');
    registry.register({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      schemaVersion: 1,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? {},
      outputVersion: 1,
      policy: {
        effects,
        trust: gated ? 'workspace' : 'none',
        approval: gated ? 'on-request' : 'never',
        plan: 'allowed',
      },
      async execute(input) {
        await input.update({ version: 1, kind: 'status', message: `Running ${tool.name}` });
        try {
          const content = await execute(tool.name, input.input, input.signal);
          if (input.signal.aborted) throw new OctocodeFacadeError('execution-cancelled', `Cancelled Octocode tool ${tool.name}`);
          assertValidToolOutput(tool.name, content, tool.outputSchema);
          await input.update({ version: 1, kind: 'status', message: `Completed ${tool.name}` });
          return { ok: true, content, detailsVersion: 1 };
        } catch (error) {
          await input.update({
            version: 1,
            kind: 'status',
            message: `${input.signal.aborted ? 'Cancelled' : 'Failed'} ${tool.name}`,
          });
          if (input.signal.aborted) throw new OctocodeFacadeError('execution-cancelled', `Cancelled Octocode tool ${tool.name}`);
          if (error instanceof OctocodeFacadeError) throw error;
          throw new OctocodeFacadeError('execution-failed', `Octocode tool ${tool.name} failed: ${redactedErrorMessage(error)}`);
        }
      },
    }, 'octocode-catalog');
  }
  if (options.allowedTools === undefined || options.allowedTools.has('plan')) registerNativePlanTool(registry, options.plan);
  if (options.allowedTools === undefined || options.allowedTools.has('awareness')) {
    registerNativeAwarenessTool(registry, options.awareness ?? { cwd: process.cwd() });
  }
  return registry;
}

function execOctocode(
  args: readonly string[],
  options: { signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('npx', ['octocode', ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || error.message;
        reject(options.signal?.aborted
          ? new OctocodeFacadeError('execution-cancelled', 'Octocode command was cancelled')
          : new OctocodeFacadeError('execution-failed', `Octocode command failed: ${redactedErrorMessage(message)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function loadOctocodeCatalog(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: OctocodeCommandRunner;
  cacheKey?: string;
  now?: () => number;
} = {}): Promise<OctocodeCatalog> {
  const run = options.run ?? execOctocode;
  const now = options.now ?? Date.now;
  const key = options.cacheKey ?? catalogCacheKey(run, options.cwd, options.env);
  const currentTime = now();
  for (const [candidate, entry] of catalogCache) {
    if (entry.expiresAt <= currentTime) {
      catalogCache.delete(candidate);
      catalogCacheCounters.expirations += 1;
    }
  }
  const cached = catalogCache.get(key);
  if (cached) {
    catalogCacheCounters.hits += 1;
    catalogCache.delete(key);
    catalogCache.set(key, cached);
    return cached.value;
  }
  catalogCacheCounters.misses += 1;
  catalogCacheCounters.loads += 1;
  const load = (async (): Promise<OctocodeCatalog> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await run(['tools', '--json', '--full'], {
        cwd: options.cwd,
        env: options.env,
      }));
    } catch (error) {
      if (error instanceof OctocodeFacadeError) throw error;
      throw catalogError(`could not be decoded: ${redactedErrorMessage(error)}`);
    }
    // An exact empty legacy fixture grants no external capabilities and is therefore safe to normalize.
    if (isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length === 0
      && parsed.kind === undefined && parsed.version === undefined && parsed.toolCount === undefined) {
      parsed = { kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] };
    }
    assertOctocodeCatalog(parsed);
    return { ...parsed, tools: [...parsed.tools].sort((left, right) => left.name.localeCompare(right.name)) };
  })();
  while (catalogCache.size >= CATALOG_CACHE_MAX_ENTRIES) {
    const oldest = catalogCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    catalogCache.delete(oldest);
    catalogCacheCounters.evictions += 1;
  }
  catalogCache.set(key, { expiresAt: currentTime + CATALOG_CACHE_TTL_MS, value: load });
  void load.catch(() => {
    catalogCacheCounters.loadFailures += 1;
    if (catalogCache.get(key)?.value === load) catalogCache.delete(key);
  });
  return load;
}

export function octocodeCatalogCacheMetrics(): Readonly<typeof catalogCacheCounters & { entries: number; maxEntries: number; ttlMs: number }> {
  return { ...catalogCacheCounters, entries: catalogCache.size, maxEntries: CATALOG_CACHE_MAX_ENTRIES, ttlMs: CATALOG_CACHE_TTL_MS };
}

export function resetOctocodeCatalogCacheForTests(): void {
  catalogCache.clear();
  for (const key of Object.keys(catalogCacheCounters) as Array<keyof typeof catalogCacheCounters>) catalogCacheCounters[key] = 0;
}

export async function executeOctocodeTool(
  name: string,
  input: unknown,
  signal: AbortSignal,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; run?: OctocodeCommandRunner } = {},
): Promise<unknown> {
  if (signal.aborted) throw new OctocodeFacadeError('execution-cancelled', `Cancelled Octocode tool ${name}`);
  const query = typeof input === 'object' && input !== null && 'queries' in input
    ? (input as { queries: unknown }).queries
    : input;
  let encoded: string;
  try { encoded = JSON.stringify(query); }
  catch { throw new OctocodeFacadeError('execution-invalid', `Octocode tool ${name} input is not JSON-serializable`); }
  if (encoded === undefined) throw new OctocodeFacadeError('execution-invalid', `Octocode tool ${name} input is not JSON-serializable`);
  let stdout: string;
  try {
    stdout = await (options.run ?? execOctocode)(
      ['tools', name, '--queries', encoded, '--compact'],
      { signal, cwd: options.cwd, env: options.env },
    );
  } catch (error) {
    if (signal.aborted) throw new OctocodeFacadeError('execution-cancelled', `Cancelled Octocode tool ${name}`);
    if (error instanceof OctocodeFacadeError) throw error;
    throw new OctocodeFacadeError('execution-failed', `Octocode tool ${name} failed: ${redactedErrorMessage(error)}`);
  }
  if (signal.aborted) throw new OctocodeFacadeError('execution-cancelled', `Cancelled Octocode tool ${name}`);
  try { return JSON.parse(stdout) as unknown; }
  catch { throw new OctocodeFacadeError('execution-invalid', `Octocode tool ${name} returned invalid JSON`); }
}

export async function createDefaultOctocodeToolRegistry(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  plan?: NativePlanOptions;
  run?: OctocodeCommandRunner;
  allowedTools?: ReadonlySet<string>;
  mcp?: Omit<NativeMcpOptions, 'cwd' | 'env' | 'homeDir' | 'isEnabled'>;
  skills?: Omit<NativeSkillOptions, 'cwd' | 'homeDir' | 'isEnabled'>;
} = {}): Promise<ToolRegistry> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const registry = createOctocodeToolRegistry(
    await loadOctocodeCatalog({ cwd, env, ...(options.run ? { run: options.run } : {}) }),
    (name, input, signal) => executeOctocodeTool(name, input, signal, { cwd, env, ...(options.run ? { run: options.run } : {}) }),
    {
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      awareness: { cwd, env },
      ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    },
  );
  const stateDbPath = agentDbPath(env);
  const readState = <T>(read: (db: ReturnType<typeof openOctocodeDb>) => T): T => {
    const db = openOctocodeDb(stateDbPath);
    try { return read(db); }
    finally { closeOctocodeDb(stateDbPath); }
  };
  if (options.allowedTools === undefined || options.allowedTools.has('Skill')) {
    registerNativeSkillTool(registry, {
      cwd,
      homeDir: env.HOME ?? os.homedir(),
      ...options.skills,
      isEnabled: (name, defaultEnabled, source) => readState((db) => getSkillEnablement(db, cwd, name, defaultEnabled, source.id)),
    });
  }
  if (options.allowedTools === undefined || options.allowedTools.has('MCPTool')) {
    const mcpManager = registerNativeMcpTool(registry, {
      cwd,
      env,
      homeDir: env.HOME ?? os.homedir(),
      ...options.mcp,
      isEnabled: (server, tool, defaultEnabled) => readState((db) => getMcpEnablement(db, cwd, server, tool, defaultEnabled ?? true)),
    });
    registryMcpManagers.set(registry, mcpManager);
  }
  return registry;
}

export async function closeNativeToolRegistry(registry: ToolRegistry): Promise<void> {
  const manager = registryMcpManagers.get(registry);
  if (!manager) return;
  registryMcpManagers.delete(registry);
  await manager.close();
}

/** Resolve the hook executor owned by this registry's canonical MCP session manager. */
export function createNativeHookMcpExecutor(registry: ToolRegistry): NativeHookMcpExecutor | undefined {
  const manager = registryMcpManagers.get(registry);
  if (!manager) return undefined;
  return { execute: (handler, input, signal) => manager.executeHook(handler, input, signal) };
}
