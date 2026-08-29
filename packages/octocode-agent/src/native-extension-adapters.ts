import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeFailure,
  parseCodexHooks,
  pluginId,
  revision,
  type HookDecision,
  type HookHandlerDefinition,
  type PluginContributionKind,
  type PluginManifest,
  type PluginPermission,
} from '@octocodeai/agent-core';
import type {
  NativeDiscoveredHook,
  NativeDiscoveredPlugin,
  NativeExtensionsOptions,
} from './native-extensions.js';

const MAX_DEFINITION_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 1_048_576;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PERMISSIONS = new Set<PluginPermission>([
  'events.observe', 'events.decide', 'tools.register', 'commands.register', 'resources.register',
  'mcp.register', 'settings.register', 'prompts.register', 'ui.register', 'models.register',
  'process.execute', 'network.access', 'filesystem.read', 'filesystem.write', 'secrets.read',
]);
const CONTRIBUTION_KINDS: Readonly<Record<string, PluginContributionKind>> = Object.freeze({
  hooks: 'hook', tools: 'tool', commands: 'command', resources: 'resource', mcp: 'mcp',
  settings: 'setting', prompts: 'prompt', ui: 'ui', models: 'model',
});
const CONTRIBUTION_PERMISSION: Readonly<Partial<Record<PluginContributionKind, PluginPermission>>> = Object.freeze({
  tool: 'tools.register', command: 'commands.register', resource: 'resources.register', mcp: 'mcp.register',
  setting: 'settings.register', prompt: 'prompts.register', ui: 'ui.register', model: 'models.register',
  hook: 'events.observe',
});

export interface NativeFilesystemExtensionOptions {
  readonly home: string;
  readonly workspace: string;
  readonly pluginRoots?: readonly string[];
  readonly workspaceTrusted: boolean;
  readonly reviewedHashes?: Readonly<Record<string, string>>;
  /** Explicit grants keyed by plugin id. Omission grants nothing. */
  readonly pluginGrants?: Readonly<Record<string, readonly PluginPermission[]>>;
}

export interface NativeExtensionPolicy {
  readonly reviewedHashes: Readonly<Record<string, string>>;
  readonly pluginGrants: Readonly<Record<string, readonly PluginPermission[]>>;
}

/** Parses the persisted, explicit approval boundary. Missing values grant nothing. */
export function resolveNativeExtensionPolicy(settings: Readonly<Record<string, unknown>>): NativeExtensionPolicy {
  const configured = settings.nativeExtensions;
  if (configured === undefined) return { reviewedHashes: Object.freeze({}), pluginGrants: Object.freeze({}) };
  if (!record(configured)) throw new RuntimeFailure('validation', 'nativeExtensions settings must be an object');
  const reviewed = configured.reviewedHashes;
  const grants = configured.pluginGrants;
  if (reviewed !== undefined && !record(reviewed)) throw new RuntimeFailure('validation', 'nativeExtensions.reviewedHashes must be an object');
  if (grants !== undefined && !record(grants)) throw new RuntimeFailure('validation', 'nativeExtensions.pluginGrants must be an object');
  const reviewedHashes: Record<string, string> = {};
  for (const [id, hash] of Object.entries(record(reviewed) ? reviewed : {})) {
    if (!SAFE_ID.test(id) && !id.startsWith('codex:') && !id.startsWith('plugin:')) throw new RuntimeFailure('validation', `Invalid extension review id: ${id}`);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new RuntimeFailure('validation', `Invalid extension review hash: ${id}`);
    reviewedHashes[id] = hash;
  }
  const pluginGrants: Record<string, readonly PluginPermission[]> = {};
  for (const [id, value] of Object.entries(record(grants) ? grants : {})) {
    if (!SAFE_ID.test(id) || !Array.isArray(value)) throw new RuntimeFailure('validation', `Invalid plugin grant: ${id}`);
    const permissions = value.map((permission) => {
      if (typeof permission !== 'string' || !PERMISSIONS.has(permission as PluginPermission)) throw new RuntimeFailure('validation', `Invalid plugin permission grant: ${id}`);
      return permission as PluginPermission;
    });
    if (new Set(permissions).size !== permissions.length) throw new RuntimeFailure('validation', `Duplicate plugin permission grant: ${id}`);
    pluginGrants[id] = Object.freeze(permissions);
  }
  return { reviewedHashes: Object.freeze(reviewedHashes), pluginGrants: Object.freeze(pluginGrants) };
}

export async function discoverNativeFilesystemExtensions(options: NativeFilesystemExtensionOptions): Promise<{
  readonly hooks: readonly NativeDiscoveredHook[];
  readonly plugins: readonly NativeDiscoveredPlugin[];
}> {
  const hooks: NativeDiscoveredHook[] = [];
  const candidates = [
    { id: 'codex:user:hooks.json', root: path.join(options.home, '.codex'), file: 'hooks.json', scope: 'user' as const, trusted: true },
    { id: 'codex:workspace:hooks.json', root: path.join(options.workspace, '.codex'), file: 'hooks.json', scope: 'workspace' as const, trusted: options.workspaceTrusted },
  ];
  for (const [discoveryOrder, candidate] of candidates.entries()) {
    const loaded = await readOptionalContained(candidate.root, candidate.file);
    if (loaded === undefined) continue;
    const parsed = parseJson(loaded.bytes, loaded.realPath);
    const rawHash = sha256(loaded.bytes);
    const normalizedHash = sha256(Buffer.from(stableJson(parsed)));
    hooks.push({
      source: Object.freeze({
        id: candidate.id,
        scope: candidate.scope,
        provenance: loaded.realPath,
        managed: false,
        rawHash,
        normalizedHash,
        trust: candidate.trusted ? 'trusted' : 'denied',
        revision: revision(normalizedHash),
        discoveryOrder,
      }),
      configuration: parseCodexHooks(parsed),
      reviewedHash: options.reviewedHashes?.[candidate.id],
    });
  }

  const pluginCandidates = options.pluginRoots === undefined
    ? [
        ...(await defaultPluginRoots(path.join(options.home, '.codex', 'plugins'))).map((root) => ({ root, trusted: true })),
        ...(await defaultPluginRoots(path.join(options.workspace, '.codex', 'plugins'))).map((root) => ({ root, trusted: options.workspaceTrusted })),
      ]
    : [...options.pluginRoots].sort().map((root) => ({ root, trusted: options.workspaceTrusted }));
  const plugins: NativeDiscoveredPlugin[] = [];
  for (const [index, pluginCandidate] of pluginCandidates.entries()) {
    const requestedRoot = pluginCandidate.root;
    const root = await fs.realpath(path.resolve(requestedRoot));
    const loaded = await readRequiredContained(root, '.codex-plugin/plugin.json');
    const raw = parseJson(loaded.bytes, loaded.realPath);
    const manifest = parsePluginManifest(raw);
    const definitionParts: Buffer[] = [Buffer.from(stableJson(raw))];
    for (const contribution of manifest.contributions) {
      definitionParts.push((await readRequiredContained(root, contribution.path)).bytes);
    }
    if (record(raw) && raw.hooks !== undefined) {
      const hookPaths = typeof raw.hooks === 'string' ? [raw.hooks] : stringArray(raw.hooks, 'hooks');
      for (const hookPath of hookPaths) {
        if (!hookPath.startsWith('./') || hookPath.includes('..')) throw new RuntimeFailure('validation', `Unsafe plugin hook path: ${hookPath}`);
        const hook = await readRequiredContained(root, hookPath);
        const parsed = parseJson(hook.bytes, hook.realPath);
        const normalizedHash = sha256(Buffer.from(stableJson(parsed)));
        const id = `plugin:${manifest.id}:${hookPath}`;
        definitionParts.push(hook.bytes);
        hooks.push({
          source: Object.freeze({
            id, scope: 'plugin', provenance: hook.realPath, managed: false, pluginId: manifest.id,
            rawHash: sha256(hook.bytes), normalizedHash,
            trust: pluginCandidate.trusted ? 'trusted' : 'denied', revision: revision(normalizedHash),
            discoveryOrder: candidates.length + index,
          }),
          configuration: parseCodexHooks(parsed),
          reviewedHash: options.reviewedHashes?.[id],
        });
      }
    }
    const manifestHash = sha256(Buffer.concat(definitionParts));
    const explicitlyGranted = new Set(options.pluginGrants?.[manifest.id] ?? []);
    const granted = manifest.permissions.filter((permission) => explicitlyGranted.has(permission));
    const denied = manifest.permissions.filter((permission) => !explicitlyGranted.has(permission));
    plugins.push({
      manifest,
      grant: Object.freeze({
        requested: manifest.permissions,
        granted: Object.freeze(granted),
        denied: Object.freeze(denied),
        revision: revision(manifestHash),
      }),
      trust: pluginCandidate.trusted ? 'trusted' : 'denied',
      manifestHash,
      reviewedHash: options.reviewedHashes?.[manifest.id],
      root,
    });
    void index;
  }
  return { hooks: Object.freeze(hooks), plugins: Object.freeze(plugins) };
}

async function defaultPluginRoots(directory: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try { entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const canonicalDirectory = await fs.realpath(directory);
  const roots: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const root = await fs.realpath(path.join(canonicalDirectory, entry.name));
    if (!root.startsWith(`${canonicalDirectory}${path.sep}`)) throw new RuntimeFailure('trust', `Plugin directory escapes discovery root: ${entry.name}`);
    try { await fs.access(path.join(root, '.codex-plugin', 'plugin.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    roots.push(root);
  }
  return roots;
}

export function createNativeFilesystemExtensionsOptions(options: NativeFilesystemExtensionOptions): NativeExtensionsOptions {
  let discovery: ReturnType<typeof discoverNativeFilesystemExtensions> | undefined;
  const load = () => (discovery ??= discoverNativeFilesystemExtensions(options));
  return {
    discoverHooks: async () => (await load()).hooks,
    discoverPlugins: async () => (await load()).plugins,
    activatePlugin: async (candidate, writer) => {
      if (candidate.root === undefined) throw new RuntimeFailure('plugin', 'Filesystem plugin root is unavailable');
      for (const contribution of candidate.manifest.contributions) {
        const loaded = await readRequiredContained(candidate.root, contribution.path);
        const document = parseJson(loaded.bytes, loaded.realPath);
        const entries = Array.isArray(document) ? document : [document];
        for (const entry of entries) {
          if (!record(entry) || typeof entry.id !== 'string' || !SAFE_ID.test(entry.id)) {
            throw new RuntimeFailure('validation', `Plugin contribution requires a safe id: ${contribution.path}`);
          }
          writer.add({ kind: contribution.kind, id: `${candidate.manifest.id}:${entry.id}`, value: structuredClone(entry) });
        }
      }
    },
  };
}

export interface NativeHookCommandResult {
  readonly decision: HookDecision;
  readonly output: unknown;
  readonly stderr: string;
}

export class NativeHookCommandExecutor {
  readonly #cwd: string;
  readonly #allowShell: boolean;
  readonly #maxInputBytes: number;
  readonly #maxOutputBytes: number;
  readonly #timeoutGraceMs: number;

  constructor(options: {
    readonly cwd: string;
    readonly allowShell?: boolean;
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    readonly timeoutGraceMs?: number;
  }) {
    this.#cwd = path.resolve(options.cwd);
    this.#allowShell = options.allowShell === true;
    this.#maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
    this.#maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.#timeoutGraceMs = options.timeoutGraceMs ?? 250;
  }

  async execute(handler: Extract<HookHandlerDefinition, { type: 'command' }>, input: unknown, signal?: AbortSignal): Promise<NativeHookCommandResult> {
    if (!this.#allowShell) throw new RuntimeFailure('trust', 'Shell command hooks require explicit reviewed policy');
    if (signal?.aborted) throw new RuntimeFailure('cancelled', 'Hook command was cancelled');
    const stdin = Buffer.from(JSON.stringify(input));
    if (stdin.byteLength > this.#maxInputBytes) throw new RuntimeFailure('validation', 'Hook command input exceeds byte limit');
    const command = process.platform === 'win32' && handler.commandWindows !== undefined ? handler.commandWindows : handler.command;
    const child = spawn(command, {
      cwd: this.#cwd,
      env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), LANG: 'C.UTF-8' },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    const terminate = () => terminateTree(child, this.#timeoutGraceMs);
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > this.#maxOutputBytes) { overflow = true; terminate(); return current; }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    child.stdin.end(stdin);
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, handler.timeoutSeconds * 1_000));
    const abort = () => { cancelled = true; terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await exit;
      if (cancelled) throw new RuntimeFailure('cancelled', 'Hook command was cancelled');
      if (timedOut) throw new RuntimeFailure('tool-execution', 'Hook command timed out');
      if (overflow) throw new RuntimeFailure('tool-execution', 'Hook command output exceeds byte limit');
      if (result.code !== 0) throw new RuntimeFailure('tool-execution', `Hook command exited with code ${result.code ?? 'signal'}`);
      const text = stdout.toString('utf8').trim();
      const output = text.length === 0 ? {} : parseHookOutput(text);
      return { decision: parseDecision(output), output, stderr: stderr.toString('utf8') };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function terminateTree(child: ChildProcess, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, graceMs);
  escalation.unref();
}

function parseDecision(output: unknown): HookDecision {
  if (typeof output === 'string') return { kind: 'context', text: output };
  if (!record(output)) throw new RuntimeFailure('validation', 'Hook output must be an object');
  const specific = record(output.hookSpecificOutput) ? output.hookSpecificOutput : undefined;
  if (specific?.permissionDecision === 'deny') return { kind: 'deny', reason: typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : 'Denied by hook' };
  if (specific?.permissionDecision === 'allow') return { kind: 'allow' };
  if (output.continue === false) return { kind: 'stop', reason: typeof output.stopReason === 'string' ? output.stopReason : 'Stopped by hook' };
  if (typeof output.systemMessage === 'string') return { kind: 'context', text: output.systemMessage };
  if (output.suppressOutput === true) return { kind: 'suppress' };
  return { kind: 'continue' };
}

function parseHookOutput(text: string): unknown {
  try { return JSON.parse(text); }
  catch {
    if (/^[\[{]/.test(text)) throw new RuntimeFailure('validation', 'Malformed structured hook output');
    return text;
  }
}

async function readOptionalContained(root: string, relative: string): Promise<{ bytes: Buffer; realPath: string } | undefined> {
  try { return await readRequiredContained(root, relative); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readRequiredContained(root: string, relative: string): Promise<{ bytes: Buffer; realPath: string }> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const requested = path.resolve(canonicalRoot, relative);
  const realPath = await fs.realpath(requested);
  if (realPath !== canonicalRoot && !realPath.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new RuntimeFailure('trust', `Extension path is not contained in its root: ${relative}`);
  }
  const bytes = await fs.readFile(realPath);
  if (bytes.byteLength > MAX_DEFINITION_BYTES) throw new RuntimeFailure('validation', `Extension definition exceeds byte limit: ${relative}`);
  return { bytes, realPath };
}

function parsePluginManifest(input: unknown): PluginManifest {
  if (!record(input) || typeof input.name !== 'string' || !SAFE_ID.test(input.name) || typeof input.version !== 'string' || !input.version.trim()) {
    throw new RuntimeFailure('validation', 'Plugin manifest requires a safe name and version');
  }
  if (!record(input.octocode) || input.octocode.apiVersion !== '1') throw new RuntimeFailure('unsupported-version', 'Plugin manifest requires Octocode API 1');
  const permissions = stringArray(input.octocode.permissions, 'permissions').map((permission) => {
    if (!PERMISSIONS.has(permission as PluginPermission)) throw new RuntimeFailure('validation', `Unknown plugin permission: ${permission}`);
    return permission as PluginPermission;
  });
  const activationEvents = input.octocode.activationEvents === undefined ? [] : stringArray(input.octocode.activationEvents, 'activationEvents');
  for (const event of activationEvents) if (!/^(?:onSessionStart|onSessionEnd|onStartup|onTool:[A-Za-z0-9._-]+|onCommand:[A-Za-z0-9._-]+)$/.test(event)) {
    throw new RuntimeFailure('validation', `Unknown plugin activation event: ${event}`);
  }
  const contributions: { kind: PluginContributionKind; path: string }[] = [];
  if (input.octocode.contributes !== undefined && !record(input.octocode.contributes)) throw new RuntimeFailure('validation', 'Plugin contributes must be an object');
  for (const [key, value] of Object.entries(record(input.octocode.contributes) ? input.octocode.contributes : {})) {
    const kind = CONTRIBUTION_KINDS[key];
    if (kind === undefined) throw new RuntimeFailure('validation', `Unknown plugin contribution kind: ${key}`);
    for (const contributionPath of stringArray(value, `contributes.${key}`)) {
      if (!contributionPath.startsWith('./') || contributionPath.includes('..')) throw new RuntimeFailure('validation', `Unsafe contribution path: ${contributionPath}`);
      const required = CONTRIBUTION_PERMISSION[kind];
      if (required !== undefined && !permissions.includes(required)) throw new RuntimeFailure('trust', `Plugin contribution ${key} requires ${required}`);
      contributions.push({ kind, path: contributionPath });
    }
  }
  return Object.freeze({ schemaVersion: 1, id: pluginId(input.name), version: input.version, apiVersion: '1', activationEvents: Object.freeze(activationEvents), permissions: Object.freeze(permissions), contributions: Object.freeze(contributions) });
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new RuntimeFailure('validation', `Plugin ${field} must be a string array`);
  return value as string[];
}
function parseJson(bytes: Buffer, source: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new RuntimeFailure('validation', `Malformed JSON in ${source}`); }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
