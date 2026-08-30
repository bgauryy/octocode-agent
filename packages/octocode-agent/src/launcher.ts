import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime } from '@octocodeai/agent-core';

import { createDefaultNativeRuntime, launchNativeAgent, parseNativeArgs, resolveNativeWorkspaceTrust } from './native-launcher.js';
import { createAgentRuntimeAcpAdapter, serveNativeAcpStdio } from './native-acp.js';
import type { NativeWorkerTransportProjection } from './native-worker-projection.js';
import { createNativeInteractionBroker, type NativeInteractionBroker } from './native-interactions.js';
import { NATIVE_MODEL_PROTOCOL_SUPPORT, type NativeModelProtocolSupport } from './native-model.js';
import { resolveNativeModelConfiguration, type NativeProviderProtocol } from './native-provider-registry.js';
import { runNativeProviderSmoke, type NativeProviderSmokeOptions, type NativeProviderSmokeResult } from './native-provider-smoke.js';
import { runAuthWizard } from './onboard.js';
import { AUTH_PROVIDERS, type AuthProvider } from './auth-providers.js';
import { listSessions, nativeSessionsDir } from './sessions.js';
import { markSetupDone } from './state.js';
import { ALLOWED_CONFIG_KEYS, agentDir, getSetting, isAllowedConfigKey, listSettings, readDefaultModel, readSettings } from './settings.js';
import { createNativeSettingsService } from './native-settings-service.js';
import { FileSettingsStorage } from './native-settings.js';
import { buildNativeDiscoverySnapshot, type NativeDiscoverySnapshot } from './native-discovery.js';
import { getOctocodeHome, workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';
import { repositoryDirectories } from '@octocodeai/octocode-shared/agent-skills';
import type { LaunchDeps, SpawnFn } from './types.js';

const require = createRequire(import.meta.url);
export const CORE_PACKAGE = '@octocodeai/agent-core';
type Command = 'help' | 'version' | 'config' | 'models' | 'discover' | 'doctor' | 'setup' | 'auth' | 'sessions' | 'resume' | 'session' | 'update' | 'completion' | 'run' | 'serve' | 'acp' | 'launch' | 'tools' | 'skills' | 'memory' | 'awareness';
export interface ParsedInvocation { command: Command; args: string[]; json: boolean; }

export function launcherRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
export function launcherVersion(): string | null {
  try { return (require(path.join(launcherRoot(), 'package.json')) as { version?: string }).version ?? null; }
  catch { return null; }
}
export function parseInvocation(argv: readonly string[] = []): ParsedInvocation {
  let json = false;
  let separated = false;
  const filtered = argv.filter((value) => {
    if (value === '--') {
      separated = true;
      return true;
    }
    if (!separated && value === '--json') {
      json = true;
      return false;
    }
    return true;
  });
  if (filtered.length === 1 && (filtered[0] === '--help' || filtered[0] === '-h')) {
    return { command: 'help', args: [], json };
  }
  if (filtered.length === 1 && (filtered[0] === '--version' || filtered[0] === '-v')) {
    return { command: 'version', args: [], json };
  }
  const commands = new Set<Command>(['help', 'version', 'config', 'models', 'discover', 'doctor', 'setup', 'auth', 'sessions', 'resume', 'session', 'update', 'completion', 'run', 'serve', 'acp', 'tools', 'skills', 'memory', 'awareness']);
  const first = filtered[0];
  return first && commands.has(first as Command)
    ? { command: first as Command, args: filtered.slice(1), json }
    : { command: 'launch', args: filtered, json };
}
export function helpReport(): string {
  return ['Octocode Agent — native coding runtime', '', 'Usage: octocode-agent [command] [options] [prompt]', '', 'Commands:', '  run <prompt>             Run once in print mode', '  serve                    Run versioned JSONL RPC on stdio', '  acp                      Serve ACP v1 on stdio for editors', '  config get|set|list|sources Inspect native settings', '  setup [--fix] [--scope global|project|all]', '                           Inspect or initialize managed discovery files', '  auth                     Configure credentials', '  models [--set p/m|--check] Inspect, select, or verify the default model', '  discover [surface]       Inspect model, MCP, and Skill sources', '  sessions|resume|session  Inspect or resume native sessions', '  update [platform]        Update the installed native agent', '  doctor                   Check runtime, credentials, and managed discovery', '  tools|skills             Open the Octocode tool surface', '  memory|awareness         Open coordination diagnostics', '  completion <shell>       Print shell completion', '', 'Modes: --print, --mode json, --mode rpc', 'Models: --model provider/model; repeat --fallback-model provider/model for explicit health-checked fallback', 'Sessions: --no-session, -c|--continue, --session <id>, -n|--name <name>', 'Workers: --allow-workers explicitly authorizes bounded worker processes in a trusted workspace', 'Terminal: --accessible enables verbose linear semantics for assistive output'].join('\n');
}
export function fatalErrorReport(error: unknown, nodeVersion = process.version): string {
  const message = error instanceof Error ? error.message : 'Unknown fatal error';
  if (message.includes('OpenTUI native FFI is not available')) {
    return `octocode-agent: OpenTUI is unavailable on ${nodeVersion}. Re-run with NODE_OPTIONS=--experimental-ffi, or use --print for non-interactive output.`;
  }
  return `octocode-agent: ${message}`;
}
export interface VersionData { launcherVersion: string | null; runtime: { package: string; host: 'native' }; }
export function versionData(): VersionData { return { launcherVersion: launcherVersion(), runtime: { package: CORE_PACKAGE, host: 'native' } }; }
export function versionReport(): string { const value = versionData(); return `octocode-agent ${value.launcherVersion ?? 'unknown'}\nruntime: ${value.runtime.package} (${value.runtime.host})`; }
export interface ConfigData { host: 'native'; octocodeHome: string; agentDir: string; settings: Record<string, unknown>; }
export function configData(env: NodeJS.ProcessEnv = process.env): ConfigData { const dir = agentDir(env); return { host: 'native', octocodeHome: getOctocodeHome(env), agentDir: dir, settings: listSettings(dir) }; }
export function configReport(env: NodeJS.ProcessEnv = process.env): string { const data = configData(env); return `host: ${data.host}\nhome: ${data.octocodeHome}\nagent dir: ${data.agentDir}`; }
export function runConfigGet(key: string | undefined, deps: LaunchDeps = {}, json = false, dir = agentDir(deps.env)): number {
  const out = deps.out ?? console.log;
  if (!key || !isAllowedConfigKey(key)) { out(`Unknown setting. Allowed: ${ALLOWED_CONFIG_KEYS.join(', ')}`); return 2; }
  const value = getSetting(dir, key);
  out(json ? JSON.stringify({ key, value }) : `${key}=${value == null ? '' : String(value)}`);
  return value === undefined ? 1 : 0;
}
function mutationExitCode(category: 'validation' | 'conflict' | 'policy' | 'persistence'): number {
  return category === 'validation' || category === 'policy' ? 2 : 1;
}
export async function runConfigSet(key: string | undefined, value: string | undefined, deps: LaunchDeps = {}, dir = agentDir(deps.env)): Promise<number> {
  const out = deps.out ?? console.log;
  if (!key || !isAllowedConfigKey(key) || value == null) { out(`Usage: octocode-agent config set <${ALLOWED_CONFIG_KEYS.join('|')}> <value>`); return 2; }
  const file = path.join(dir, 'settings.json');
  const settings = await createNativeSettingsService(new FileSettingsStorage(file));
  const result = await settings.mutate({
    protocolVersion: 1,
    requestId: `config-set:${key}`,
    action: 'set',
    scope: 'global',
    expectedRevision: settings.snapshot().revision,
    payload: { key, value },
  });
  if (!result.ok) { out(`settings ${result.error.category}: ${result.error.message}`); return mutationExitCode(result.error.category); }
  out(`saved ${key} in ${file}`); return 0;
}
export function runConfigList(deps: LaunchDeps = {}, json = false, dir = agentDir(deps.env)): number {
  const out = deps.out ?? console.log; const settings = listSettings(dir);
  out(json ? JSON.stringify(settings, null, 2) : Object.entries(settings).map(([key, value]) => `${key}=${String(value)}`).join('\n')); return 0;
}
export async function runModelsSet(modelArg: string | undefined, deps: LaunchDeps = {}, dir = agentDir(deps.env)): Promise<number> {
  const out = deps.out ?? console.log; const slash = modelArg?.indexOf('/') ?? -1;
  if (!modelArg || slash < 1 || slash === modelArg.length - 1) { out('Usage: octocode-agent models --set <provider/model>'); return 2; }
  const provider = modelArg.slice(0, slash); const model = modelArg.slice(slash + 1);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stored = readSettings(dir);
  try {
    resolveNativeModelConfiguration({
      env,
      cwd,
      home: env.HOME ?? os.homedir(),
      octocodeHome: getOctocodeHome(env),
      configuredProvider: provider,
      configuredModel: model,
      configuredSelectionSource: 'cli.override',
      forceConfiguredSelection: true,
      workspaceTrusted: resolveNativeWorkspaceTrust(cwd, stored) === 'trusted',
    });
  } catch (error) {
    out(`settings validation: ${error instanceof Error ? error.message : 'Invalid model selection'}`);
    return 2;
  }
  const file = path.join(dir, 'settings.json');
  const settings = await createNativeSettingsService(new FileSettingsStorage(file));
  const result = await settings.setDefaultModel({
    requestId: 'models-set',
    expectedRevision: settings.snapshot().revision,
    providerId: provider,
    modelId: model,
  });
  if (!result.ok) { out(`settings ${result.error.category}: ${result.error.message}`); return mutationExitCode(result.error.category); }
  out(`saved ${provider}/${model} in ${file}`); return 0;
}
export interface ModelsData {
  defaultModel: string | null;
  persistedSelection: { readonly providerId: string; readonly modelId: string } | null;
  effectiveSelection: { readonly providerId: string; readonly modelId: string };
  selectionSource: ReturnType<typeof resolveNativeModelConfiguration>['selectionSource'];
  endpoint: string;
  protocol: NativeProviderProtocol;
  credential: ReturnType<typeof resolveNativeModelConfiguration>['credential'];
  protocolSupport: readonly NativeModelProtocolSupport[];
  catalog: ReturnType<typeof resolveNativeModelConfiguration>['catalog'];
}
export function modelsData(env: NodeJS.ProcessEnv = process.env, cwd?: string): ModelsData {
  const stored = readSettings(agentDir(env));
  const persistedSelection = typeof stored['defaultProvider'] === 'string' && typeof stored['defaultModel'] === 'string'
    ? { providerId: stored['defaultProvider'], modelId: stored['defaultModel'] }
    : null;
  const resolved = resolveNativeModelConfiguration({
    env,
    configuredProvider: typeof stored['defaultProvider'] === 'string' ? stored['defaultProvider'] : undefined,
    configuredModel: typeof stored['defaultModel'] === 'string' ? stored['defaultModel'] : undefined,
    ...(cwd === undefined ? {} : {
      cwd,
      home: env.HOME ?? os.homedir(),
      octocodeHome: getOctocodeHome(env),
      workspaceTrusted: resolveNativeWorkspaceTrust(cwd, stored) === 'trusted',
    }),
  });
  return {
    defaultModel: readDefaultModel(agentDir(env)),
    persistedSelection,
    effectiveSelection: resolved.selection,
    selectionSource: resolved.selectionSource,
    endpoint: resolved.endpoint,
    protocol: resolved.protocol,
    credential: resolved.credential,
    protocolSupport: NATIVE_MODEL_PROTOCOL_SUPPORT,
    catalog: resolved.catalog,
  };
}
export function modelsReport(env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  const data = modelsData(env, cwd);
  const unavailable = data.protocolSupport.filter((entry) => !entry.supported).map((entry) => `  - ${entry.protocol}: ${entry.reason}`).join('\n');
  const sources = data.catalog.sources.map((source) => `  - ${source.id} [${source.parseState}]${source.path ? ` ${source.path}` : ''}`).join('\n');
  const persisted = data.persistedSelection === null
    ? '(not set)'
    : `${data.persistedSelection.providerId}/${data.persistedSelection.modelId}`;
  return `effective: ${data.effectiveSelection.providerId}/${data.effectiveSelection.modelId} (${data.selectionSource})\npersisted: ${persisted}\ncredential: ${data.credential.configured ? `ready (${data.credential.source})` : `not ready (${data.credential.missingEnvironmentVariables.join(', ') || data.credential.source})`}\nendpoint: ${data.endpoint}\nprotocol: ${data.protocol}\nsources:\n${sources}\nunavailable protocols:\n${unavailable}`;
}

export interface ModelsCheckData {
  readonly status: 'verified' | 'unhealthy' | 'unconfigured';
  readonly configured: boolean;
  readonly verified: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: NativeProviderProtocol;
  readonly reason?: 'unauthorized' | 'not-found' | 'rate-limited' | 'timeout' | 'provider-error' | 'credentials-absent';
}
export type NativeProviderHealthProbe = (options: NativeProviderSmokeOptions) => Promise<NativeProviderSmokeResult>;

export async function runModelsCheck(
  deps: LaunchDeps = {},
  json = false,
  probe: NativeProviderHealthProbe = runNativeProviderSmoke,
): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stored = readSettings(agentDir(env));
  const resolved = resolveNativeModelConfiguration({
    env,
    cwd,
    home: env.HOME ?? os.homedir(),
    octocodeHome: getOctocodeHome(env),
    configuredProvider: typeof stored['defaultProvider'] === 'string' ? stored['defaultProvider'] : undefined,
    configuredModel: typeof stored['defaultModel'] === 'string' ? stored['defaultModel'] : undefined,
    workspaceTrusted: resolveNativeWorkspaceTrust(cwd, stored) === 'trusted',
  });
  const apiKey = (resolved.credentialEnv ? env[resolved.credentialEnv] : undefined)
    ?? env.OCTOCODE_MODEL_API_KEY
    ?? (resolved.protocol === 'anthropic-messages' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY)
    ?? '';
  const smoke = await probe({
    protocol: resolved.protocol,
    endpoint: resolved.endpoint,
    apiKey,
    model: resolved.selection.modelId,
    ...(resolved.resolveRuntimeAuth === undefined ? {} : { resolveAuth: resolved.resolveRuntimeAuth }),
    ...(resolved.protocol === 'anthropic-messages' ? {
      // Health probes are intentionally tiny and below provider cache minimums.
      promptCaching: false,
      ...(resolved.sendSessionAffinityHeaders ? { sessionAffinityId: 'native:model-check:00000000-0000-4000-8000-000000000000' } : {}),
    } : {}),
  });
  const common = {
    providerId: resolved.selection.providerId,
    modelId: resolved.selection.modelId,
    protocol: resolved.protocol,
  };
  const data: ModelsCheckData = smoke.status === 'PASS'
    ? { status: 'verified', configured: true, verified: true, ...common }
    : smoke.status === 'SKIP'
      ? { status: 'unconfigured', configured: false, verified: false, ...common, reason: 'credentials-absent' }
      : { status: 'unhealthy', configured: resolved.credential.configured, verified: false, ...common, reason: smoke.reason };
  const out = deps.out ?? console.log;
  out(json
    ? JSON.stringify(data, null, 2)
    : [`model health: ${data.status}`, `provider: ${data.providerId}`, `model: ${data.modelId}`, `protocol: ${data.protocol}`, ...(data.reason === undefined ? [] : [`reason: ${data.reason}`])].join('\n'));
  return data.verified ? 0 : 1;
}

export function discoveryData(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): NativeDiscoverySnapshot {
  const stored = readSettings(agentDir(env));
  return buildNativeDiscoverySnapshot({
    env,
    cwd,
    configuredProvider: typeof stored['defaultProvider'] === 'string' ? stored['defaultProvider'] : undefined,
    configuredModel: typeof stored['defaultModel'] === 'string' ? stored['defaultModel'] : undefined,
    workspaceTrusted: resolveNativeWorkspaceTrust(cwd, stored) === 'trusted',
  });
}

export function discoveryReport(data: NativeDiscoverySnapshot, surface?: string): string {
  const modelSources = data.models.sources.map((source) => `  - ${source.id}: ${source.parseState}${source.path ? ` · ${source.path}` : ''}`).join('\n');
  const mcpSources = data.mcp.sources.map((source) => `  - ${source.vendor}: ${source.status} · ${source.path}`).join('\n');
  const skillSources = data.skills.sources.map((source) => `  - ${source.name}: ${source.enabled ? 'enabled' : 'disabled'} · ${source.vendor} · ${source.path}`).join('\n');
  const sections = {
    models: `Models (${data.models.entries.length})\n  selected credential: ${data.models.credential.configured ? 'configured' : `missing ${data.models.credential.missingEnvironmentVariables.join(', ')}`}\n${modelSources || '  (none)'}`,
    mcp: `MCP servers (${data.mcp.servers.length})\n${mcpSources || '  (none)'}`,
    skills: `Skills (${data.skills.sources.length})\n${skillSources || '  (none)'}`,
  };
  return surface === 'models' || surface === 'mcp' || surface === 'skills'
    ? sections[surface]
    : `${sections.models}\n${sections.mcp}\n${sections.skills}`;
}
export interface DoctorData { healthy: boolean; checks: readonly { name: string; ok: boolean; detail: string }[]; }
function isWithin(candidate: string | undefined, directory: string): boolean {
  if (!candidate) return false;
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function managedDiscoveryCheck(env: NodeJS.ProcessEnv, cwd: string): DoctorData['checks'][number] {
  try {
    const snapshot = discoveryData(env, cwd);
    const managedDirectories = [path.join(getOctocodeHome(env), 'agent')];
    const managedPath = (candidate: string | undefined): boolean => managedDirectories.some((directory) => isWithin(candidate, directory));
    const failures = [
      ...snapshot.models.sources.filter((source) => source.kind === 'managed' && source.parseState === 'invalid').map((source) => `${source.path ?? source.id}: invalid model configuration`),
      ...snapshot.mcp.sources.filter((source) => managedPath(source.path) && source.status === 'invalid').map((source) => `${source.path}: invalid MCP configuration${source.diagnostic ? ` (${source.diagnostic})` : ''}`),
      ...snapshot.skills.sources.filter((source) => managedPath(source.path) && source.status === 'invalid').map((source) => `${source.path}: invalid Skill${source.diagnostic ? ` (${source.diagnostic})` : ''}`),
    ];
    return failures.length === 0
      ? { name: 'managed-discovery', ok: true, detail: 'managed model, MCP, and Skill sources are valid' }
      : { name: 'managed-discovery', ok: false, detail: failures.join('; ') };
  } catch (error) {
    return { name: 'managed-discovery', ok: false, detail: error instanceof Error ? error.message : 'managed discovery validation failed' };
  }
}
export function doctorData(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DoctorData {
  const credential = modelsData(env, cwd).credential;
  const detail = credential.configured
    ? credential.source === 'command'
      ? `${credential.providerId}: configured by discovered credential command (verified at model request time)`
      : credential.source === 'none'
        ? `${credential.providerId}: selected provider does not require configured credentials`
        : `${credential.providerId}: configured via discovered ${credential.source}`
    : `${credential.providerId}: set ${credential.missingEnvironmentVariables.join(', ')} for the selected model provider`;
  const checks = [{ name: 'runtime', ok: true, detail: CORE_PACKAGE }, { name: 'credentials', ok: credential.configured, detail }, managedDiscoveryCheck(env, cwd)];
  return { healthy: checks.every((check) => check.ok), checks };
}
export function doctorReport(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string { const data = doctorData(env, cwd); return data.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n'); }
export function completionScript(shell: string): string | null {
  const commands = 'run serve acp config setup auth models discover sessions resume session update doctor completion tools skills memory awareness version help';
  if (shell === 'bash') return `complete -W "${commands}" octocode-agent`;
  if (shell === 'zsh') return `compctl -k '(${commands})' octocode-agent`;
  if (shell === 'fish') return commands.split(' ').map((command) => `complete -c octocode-agent -f -a ${command}`).join('\n');
  return null;
}
export async function launchAgent(argv: readonly string[] = [], deps: LaunchDeps = {}): Promise<number> {
  return launchNativeAgent(argv, { env: deps.env, stdin: deps.stdin, stdout: deps.stdout, stderr: deps.stderr, cwd: deps.cwd, createRuntime: deps.createRuntime, createTerminal: deps.createTerminal });
}
export function createAcpRuntimeArgs(): ReturnType<typeof parseNativeArgs> {
  return { ...parseNativeArgs([]), mode: 'acp', outputFormat: 'json' };
}
export async function serveAcp(deps: LaunchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const workerProjections = new WeakMap<AgentRuntime, NativeWorkerTransportProjection>();
  const interactionsByRuntime = new WeakMap<AgentRuntime, NativeInteractionBroker>();
  const createRuntime = deps.createRuntime ?? (async ({ cwd, args }) => {
    let workerProjection: NativeWorkerTransportProjection | undefined;
    let runtimeRef: AgentRuntime | undefined;
    const interactions = createNativeInteractionBroker();
    const runtime = await createDefaultNativeRuntime({
      env,
      cwd,
      args,
      interactions,
      onWorkerProjection: (projection) => {
        workerProjection = projection;
        if (runtimeRef !== undefined) workerProjections.set(runtimeRef, projection);
      },
    });
    runtimeRef = runtime;
    interactionsByRuntime.set(runtime, interactions);
    if (workerProjection !== undefined) workerProjections.set(runtime, workerProjection);
    return runtime;
  });
  const adapter = createAgentRuntimeAcpAdapter({
    createRuntime: (cwd) => createRuntime({ env, cwd, args: createAcpRuntimeArgs() }),
    workerProjection: (runtime) => workerProjections.get(runtime),
    interactions: (runtime) => interactionsByRuntime.get(runtime),
  });
  const connection = serveNativeAcpStdio(adapter, {
    input: deps.stdin ?? process.stdin,
    output: deps.stdout ?? process.stdout,
  });
  return await connection.exitCode;
}
export function runSurface(command: 'tools' | 'skills' | 'memory' | 'awareness', args: readonly string[], deps: LaunchDeps = {}): number {
  const spawn: SpawnFn = deps.spawn ?? spawnSync;
  const packageName = command === 'memory' || command === 'awareness' ? '@octocodeai/octocode-awareness' : 'octocode';
  const downstreamArgs = command === 'awareness'
    ? [...args]
    : [command === 'skills' ? 'skill' : command, ...args];
  const result = spawn('npx', [packageName, ...downstreamArgs], { stdio: 'inherit', env: deps.env ?? process.env }); return result.status ?? 1;
}
export interface SessionsData { sessionsDir: string; sessions: ReturnType<typeof listSessions>; }
export function sessionsData(env: NodeJS.ProcessEnv = process.env): SessionsData { const sessionsDir = nativeSessionsDir(env); return { sessionsDir, sessions: listSessions(sessionsDir) }; }
export function sessionsReport(env: NodeJS.ProcessEnv = process.env): string { const data = sessionsData(env); return data.sessions.length ? data.sessions.map((item) => `${item.key}\t${item.cwd ?? ''}`).join('\n') : `No sessions in ${data.sessionsDir}`; }
export interface SetupData { allGood: boolean; octocodeHome: string; checks: DoctorData['checks']; }
function setupAgentDirectories(env: NodeJS.ProcessEnv, cwd: string, scope: SetupScope): string[] {
  const octocodeHome = getOctocodeHome(env);
  const repository = repositoryDirectories(cwd)[0] ?? path.resolve(cwd);
  return [
    ...(scope === 'global' || scope === 'all' ? [path.join(octocodeHome, 'agent')] : []),
    ...(scope === 'project' || scope === 'all' ? [workspaceAgentRoot(repository, octocodeHome)] : []),
  ];
}
export function setupData(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), scope: SetupScope = 'global'): SetupData {
  const octocodeHome = getOctocodeHome(env);
  const checks = setupAgentDirectories(env, cwd, scope).flatMap((managed) => [
    { name: `${managed}:models`, ok: fs.existsSync(path.join(managed, 'models.json')), detail: path.join(managed, 'models.json') },
    { name: `${managed}:mcp`, ok: fs.existsSync(path.join(managed, 'mcp', 'servers.json')), detail: path.join(managed, 'mcp', 'servers.json') },
    { name: `${managed}:skills`, ok: fs.existsSync(path.join(managed, 'skills')), detail: path.join(managed, 'skills') },
  ]);
  return { allGood: checks.every((check) => check.ok), octocodeHome, checks };
}
export function setupReport(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), scope: SetupScope = 'global'): string { const data = setupData(env, cwd, scope); return data.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n'); }
export function authData(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const credential = modelsData(env, cwd).credential;
  return {
    configured: credential.configured,
    providerId: credential.providerId,
    source: credential.source,
    verification: credential.verification,
    environmentVariables: credential.environmentVariables,
    missingEnvironmentVariables: credential.missingEnvironmentVariables,
  };
}
export function authProvidersData(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): readonly AuthProvider[] {
  const data = modelsData(env, cwd);
  const providers = [...AUTH_PROVIDERS];
  const known = new Set(providers.map(({ keyVar }) => keyVar));
  for (const keyVar of data.credential.environmentVariables) {
    if (known.has(keyVar)) continue;
    providers.push({
      keyVar,
      label: `Discovered credential for ${data.credential.providerId}`,
      protocol: data.protocol,
    });
    known.add(keyVar);
  }
  return providers;
}
export function authReport(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const data = authData(env, cwd);
  return data.configured
    ? `Model credentials configured for ${data.providerId}`
    : `Missing model configuration environment variables for ${data.providerId}: ${data.missingEnvironmentVariables.join(', ')}`;
}
export type SetupScope = 'global' | 'project' | 'all';
export async function runSetupFix(deps: LaunchDeps = {}, scope: SetupScope = 'global'): Promise<number> {
  const home = getOctocodeHome(deps.env);
  const cwd = deps.cwd ?? process.cwd();
  const agents = setupAgentDirectories(deps.env ?? process.env, cwd, scope);
  for (const agent of agents) {
    fs.mkdirSync(path.join(agent, 'skills'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(agent, 'mcp'), { recursive: true, mode: 0o700 });
    for (const [file, initial] of [
      [path.join(agent, 'models.json'), { providers: {} }],
      [path.join(agent, 'mcp', 'servers.json'), { mcpServers: {} }],
    ] as const) {
      try { fs.writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  markSetupDone(home);
  (deps.out ?? console.log)(`setup state saved in ${home}; discovery config: ${agents.join(', ')}`);
  return 0;
}
export function updateCommand(): { cmd: string; args: string[] } { return { cmd: 'npm', args: ['install', '-g', 'octocode-agent@latest'] }; }
export async function runUpdate(deps: LaunchDeps = {}): Promise<number> { const action = updateCommand(); const result = (deps.spawn ?? spawnSync)(action.cmd, action.args, { stdio: 'inherit', env: deps.env ?? process.env }); return result.status ?? 1; }
export async function main(argv: readonly string[] = [], deps: LaunchDeps = {}): Promise<number> {
  const out = deps.out ?? console.log; const env = deps.env ?? process.env; const invocation = parseInvocation(argv);
  switch (invocation.command) {
    case 'help': out(helpReport()); return 0;
    case 'version': out(invocation.json ? JSON.stringify(versionData(), null, 2) : versionReport()); return 0;
    case 'config': { const [action, key, value] = invocation.args; if (action === 'get') return runConfigGet(key, deps, invocation.json); if (action === 'set') return await runConfigSet(key, value, deps); if (action === 'list') return runConfigList(deps, invocation.json); if (action === 'sources') { const data = discoveryData(env, deps.cwd ?? process.cwd()); out(invocation.json ? JSON.stringify(data, null, 2) : discoveryReport(data)); return 0; } out(invocation.json ? JSON.stringify(configData(env), null, 2) : configReport(env)); return 0; }
    case 'models': { const index = invocation.args.indexOf('--set'); if (index >= 0) return runModelsSet(invocation.args[index + 1], deps); if (invocation.args.includes('--check')) return runModelsCheck(deps, invocation.json); out(invocation.json ? JSON.stringify(modelsData(env, deps.cwd ?? process.cwd()), null, 2) : modelsReport(env, deps.cwd ?? process.cwd())); return 0; }
    case 'discover': { const data = discoveryData(env, deps.cwd ?? process.cwd()); const surface = invocation.args[0]; const output = surface === 'models' || surface === 'mcp' || surface === 'skills' ? { schemaVersion: data.schemaVersion, generatedAt: data.generatedAt, workspace: data.workspace, [surface]: data[surface] } : data; out(invocation.json ? JSON.stringify(output, null, 2) : discoveryReport(data, surface)); return 0; }
    case 'setup': {
      const scopeIndex = invocation.args.indexOf('--scope');
      const scope = scopeIndex < 0 ? 'global' : invocation.args[scopeIndex + 1];
      if (scope !== 'global' && scope !== 'project' && scope !== 'all') {
        out('Usage: octocode-agent setup [--fix] [--scope global|project|all]');
        return 2;
      }
      if (invocation.args.includes('--fix')) {
        return runSetupFix(deps, scope);
      }
      const cwd = deps.cwd ?? process.cwd();
      const data = setupData(env, cwd, scope); out(invocation.json ? JSON.stringify(data, null, 2) : setupReport(env, cwd, scope)); return data.allGood ? 0 : 1;
    }
    case 'auth': {
      const cwd = deps.cwd ?? process.cwd();
      if (invocation.args[0] === 'login') return runAuthWizard({ env, providers: authProvidersData(env, cwd) });
      const data = authData(env, cwd);
      out(invocation.json ? JSON.stringify(data, null, 2) : authReport(env, cwd));
      return data.configured ? 0 : 1;
    }
    case 'sessions': out(invocation.json ? JSON.stringify(sessionsData(env), null, 2) : sessionsReport(env)); return 0;
    case 'resume': return launchAgent(invocation.args[0] ? ['--session', invocation.args[0], ...invocation.args.slice(1)] : ['--continue'], deps);
    case 'session': return launchAgent(invocation.args, deps);
    case 'update': {
      const target = invocation.args[0];
      if (invocation.args.length > 1 || (target !== undefined && target !== 'platform')) { out('Unsupported update target. Usage: octocode-agent update [platform]'); return 2; }
      return runUpdate(deps);
    }
    case 'doctor': { const cwd = deps.cwd ?? process.cwd(); const data = doctorData(env, cwd); out(invocation.json ? JSON.stringify(data, null, 2) : doctorReport(env, cwd)); return data.healthy ? 0 : 1; }
    case 'completion': { const script = completionScript(invocation.args[0] ?? ''); if (!script) return 2; out(script); return 0; }
    case 'run': return launchAgent(invocation.json ? ['--mode', 'json', ...invocation.args] : ['--print', ...invocation.args], deps);
    case 'serve': return launchAgent(['--mode', 'rpc', ...invocation.args], deps);
    case 'acp': return serveAcp(deps);
    case 'tools': case 'skills': case 'memory': case 'awareness': return runSurface(
      invocation.command,
      invocation.json ? [...invocation.args, '--json'] : invocation.args,
      deps,
    );
    case 'launch': default: return launchAgent(invocation.args, deps);
  }
}
