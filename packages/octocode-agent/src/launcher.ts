import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { launchNativeAgent } from './native-launcher.js';
import { runAuthWizard } from './onboard.js';
import { listSessions, nativeSessionsDir } from './sessions.js';
import { markSetupDone } from './state.js';
import { ALLOWED_CONFIG_KEYS, agentDir, getSetting, isAllowedConfigKey, listSettings, readDefaultModel, setDefaultModelInSettings, setSetting } from './settings.js';
import { getOctocodeHome } from './utils.js';
import type { LaunchDeps, SpawnFn } from './types.js';

const require = createRequire(import.meta.url);
export const CORE_PACKAGE = '@octocodeai/agent-core';
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
type Command = 'help' | 'version' | 'config' | 'models' | 'doctor' | 'setup' | 'auth' | 'sessions' | 'resume' | 'session' | 'update' | 'completion' | 'run' | 'serve' | 'launch' | 'tools' | 'skills' | 'memory' | 'awareness';
export interface ParsedInvocation { command: Command; args: string[]; json: boolean; }

export function launcherRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
export function launcherVersion(): string | null {
  try { return (require(path.join(launcherRoot(), 'package.json')) as { version?: string }).version ?? null; }
  catch { return null; }
}
export function parseInvocation(argv: readonly string[] = []): ParsedInvocation {
  const json = argv.includes('--json');
  const filtered = argv.filter((value) => value !== '--json');
  if (filtered.length === 1 && (filtered[0] === '--help' || filtered[0] === '-h')) {
    return { command: 'help', args: [], json };
  }
  if (filtered.length === 1 && (filtered[0] === '--version' || filtered[0] === '-v')) {
    return { command: 'version', args: [], json };
  }
  const commands = new Set<Command>(['help', 'version', 'config', 'models', 'doctor', 'setup', 'auth', 'sessions', 'resume', 'session', 'update', 'completion', 'run', 'serve', 'tools', 'skills', 'memory', 'awareness']);
  const first = filtered[0];
  return first && commands.has(first as Command)
    ? { command: first as Command, args: filtered.slice(1), json }
    : { command: 'launch', args: filtered, json };
}
export function helpReport(): string {
  return ['Octocode Agent — native coding runtime', '', 'Usage: octocode-agent [command] [options] [prompt]', '', 'Commands:', '  run <prompt>             Run once in print mode', '  serve                    Run versioned JSONL RPC on stdio', '  config get|set|list      Inspect native settings', '  setup|auth               Configure credentials and runtime', '  models [--set p/m]       Inspect or select the default model', '  sessions|resume|session  Inspect or resume native sessions', '  update [platform|core]   Update installed packages', '  doctor                   Validate native runtime configuration', '  tools|skills             Open the Octocode tool surface', '  memory|awareness         Open coordination diagnostics', '  completion <shell>       Print shell completion', '', 'Modes: --print, --mode json, --mode rpc'].join('\n');
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
export function runConfigSet(key: string | undefined, value: string | undefined, deps: LaunchDeps = {}, dir = agentDir(deps.env)): number {
  const out = deps.out ?? console.log;
  if (!key || !isAllowedConfigKey(key) || value == null) { out(`Usage: octocode-agent config set <${ALLOWED_CONFIG_KEYS.join('|')}> <value>`); return 2; }
  out(`saved ${key} in ${setSetting(dir, key, value)}`); return 0;
}
export function runConfigList(deps: LaunchDeps = {}, json = false, dir = agentDir(deps.env)): number {
  const out = deps.out ?? console.log; const settings = listSettings(dir);
  out(json ? JSON.stringify(settings, null, 2) : Object.entries(settings).map(([key, value]) => `${key}=${String(value)}`).join('\n')); return 0;
}
export async function runModelsSet(modelArg: string | undefined, deps: LaunchDeps = {}, dir = agentDir(deps.env)): Promise<number> {
  const out = deps.out ?? console.log; const slash = modelArg?.indexOf('/') ?? -1;
  if (!modelArg || slash < 1 || slash === modelArg.length - 1) { out('Usage: octocode-agent models --set <provider/model>'); return 2; }
  const provider = modelArg.slice(0, slash); const model = modelArg.slice(slash + 1);
  out(`saved ${provider}/${model} in ${setDefaultModelInSettings(dir, provider, model)}`); return 0;
}
export function modelsData(env: NodeJS.ProcessEnv = process.env): { defaultModel: string | null; endpoint: string } { return { defaultModel: readDefaultModel(agentDir(env)), endpoint: env.OCTOCODE_MODEL_ENDPOINT ?? 'https://api.openai.com/v1' }; }
export function modelsReport(env: NodeJS.ProcessEnv = process.env): string { const data = modelsData(env); return `default: ${data.defaultModel ?? '(not set)'}\nendpoint: ${data.endpoint}`; }
export interface DoctorData { healthy: boolean; checks: readonly { name: string; ok: boolean; detail: string }[]; }
export function doctorData(env: NodeJS.ProcessEnv = process.env): DoctorData {
  const hasCredential = Boolean(env.OCTOCODE_MODEL_API_KEY ?? env.OPENAI_API_KEY);
  const checks = [{ name: 'runtime', ok: true, detail: CORE_PACKAGE }, { name: 'credentials', ok: hasCredential, detail: hasCredential ? 'configured' : 'set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY' }];
  return { healthy: checks.every((check) => check.ok), checks };
}
export function doctorReport(env: NodeJS.ProcessEnv = process.env): string { const data = doctorData(env); return data.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n'); }
export function completionScript(shell: string): string | null {
  const commands = 'run serve config setup auth models sessions resume session update doctor tools skills memory awareness version help';
  if (shell === 'bash') return `complete -W "${commands}" octocode-agent`;
  if (shell === 'zsh') return `compctl -k '(${commands})' octocode-agent`;
  if (shell === 'fish') return commands.split(' ').map((command) => `complete -c octocode-agent -f -a ${command}`).join('\n');
  return null;
}
export function formatAge(ms: number): string { if (ms < 60_000) return 'just now'; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`; if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`; return `${Math.floor(ms / 86_400_000)}d ago`; }
function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) { let previous = row[0]!; row[0] = i; for (let j = 1; j <= right.length; j++) { const old = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1)); previous = old; } }
  return row[right.length]!;
}
export function suggestCommand(token: string | undefined): string | null {
  if (!token || token.startsWith('-')) return null;
  const match = ['help', 'config', 'doctor', 'setup', 'auth', 'models', 'sessions', 'resume', 'update', 'run', 'serve', 'version'].map((command) => ({ command, score: editDistance(token, command) })).sort((a, b) => a.score - b.score)[0];
  return match && match.score <= 2 ? match.command : null;
}
export async function launchAgent(argv: readonly string[] = [], deps: LaunchDeps = {}): Promise<number> {
  return launchNativeAgent(argv, { env: deps.env, stdin: deps.stdin, stdout: deps.stdout, stderr: deps.stderr, cwd: deps.cwd, createRuntime: deps.createRuntime, createTerminal: deps.createTerminal });
}
export function runSurface(command: 'tools' | 'skills' | 'memory' | 'awareness', args: readonly string[], deps: LaunchDeps = {}): number {
  const spawn: SpawnFn = deps.spawn ?? spawnSync;
  const packageName = command === 'memory' || command === 'awareness' ? '@octocodeai/octocode-awareness' : 'octocode';
  const result = spawn('npx', [packageName, command, ...args], { stdio: 'inherit', env: deps.env ?? process.env }); return result.status ?? 1;
}
export interface SessionsData { sessionsDir: string; sessions: ReturnType<typeof listSessions>; }
export function sessionsData(env: NodeJS.ProcessEnv = process.env): SessionsData { const sessionsDir = nativeSessionsDir(env); return { sessionsDir, sessions: listSessions(sessionsDir) }; }
export function sessionsReport(env: NodeJS.ProcessEnv = process.env): string { const data = sessionsData(env); return data.sessions.length ? data.sessions.map((item) => `${item.key}\t${item.cwd ?? ''}`).join('\n') : `No sessions in ${data.sessionsDir}`; }
export interface SetupData { allGood: boolean; octocodeHome: string; checks: DoctorData['checks']; }
export function setupData(env: NodeJS.ProcessEnv = process.env): SetupData { const doctor = doctorData(env); return { allGood: doctor.healthy, octocodeHome: getOctocodeHome(env), checks: doctor.checks }; }
export function setupReport(env: NodeJS.ProcessEnv = process.env): string { return doctorReport(env); }
export function authData(env: NodeJS.ProcessEnv = process.env): { configured: boolean } { return { configured: Boolean(env.OCTOCODE_MODEL_API_KEY ?? env.OPENAI_API_KEY) }; }
export function authReport(env: NodeJS.ProcessEnv = process.env): string { return authData(env).configured ? 'Model credentials configured' : 'No model credentials configured'; }
export async function runSetupFix(deps: LaunchDeps = {}): Promise<number> { const home = getOctocodeHome(deps.env); markSetupDone(home); (deps.out ?? console.log)(`setup state saved in ${home}`); return 0; }
export function updateCommand(target: 'core' | 'platform' = 'platform'): { cmd: string; args: string[] } { return target === 'core' ? { cmd: 'npm', args: ['install', '-g', `${CORE_PACKAGE}@latest`] } : { cmd: 'npm', args: ['install', '-g', 'octocode-agent@latest'] }; }
export async function runUpdate(target: 'core' | 'platform' = 'platform', deps: LaunchDeps = {}): Promise<number> { const action = updateCommand(target); const result = (deps.spawn ?? spawnSync)(action.cmd, action.args, { stdio: 'inherit', env: deps.env ?? process.env }); return result.status ?? 1; }
export async function main(argv: readonly string[] = [], deps: LaunchDeps = {}): Promise<number> {
  const out = deps.out ?? console.log; const env = deps.env ?? process.env; const invocation = parseInvocation(argv);
  switch (invocation.command) {
    case 'help': out(helpReport()); return 0;
    case 'version': out(invocation.json ? JSON.stringify(versionData(), null, 2) : versionReport()); return 0;
    case 'config': { const [action, key, value] = invocation.args; if (action === 'get') return runConfigGet(key, deps, invocation.json); if (action === 'set') return runConfigSet(key, value, deps); if (action === 'list') return runConfigList(deps, invocation.json); out(invocation.json ? JSON.stringify(configData(env), null, 2) : configReport(env)); return 0; }
    case 'models': { const index = invocation.args.indexOf('--set'); if (index >= 0) return runModelsSet(invocation.args[index + 1], deps); out(invocation.json ? JSON.stringify(modelsData(env), null, 2) : modelsReport(env)); return 0; }
    case 'setup': { if (invocation.args.includes('--fix')) return runSetupFix(deps); const data = setupData(env); out(invocation.json ? JSON.stringify(data, null, 2) : setupReport(env)); return data.allGood ? 0 : 1; }
    case 'auth': { if (invocation.args[0] === 'login') return runAuthWizard({ env }); out(invocation.json ? JSON.stringify(authData(env), null, 2) : authReport(env)); return authData(env).configured ? 0 : 1; }
    case 'sessions': out(invocation.json ? JSON.stringify(sessionsData(env), null, 2) : sessionsReport(env)); return 0;
    case 'resume': return launchAgent(invocation.args[0] ? ['--session', invocation.args[0], ...invocation.args.slice(1)] : ['--continue'], deps);
    case 'session': return launchAgent(invocation.args, deps);
    case 'update': return runUpdate(invocation.args[0] === 'core' ? 'core' : 'platform', deps);
    case 'doctor': { const data = doctorData(env); out(invocation.json ? JSON.stringify(data, null, 2) : doctorReport(env)); return data.healthy ? 0 : 1; }
    case 'completion': { const script = completionScript(invocation.args[0] ?? ''); if (!script) return 2; out(script); return 0; }
    case 'run': return launchAgent(invocation.json ? ['--mode', 'json', ...invocation.args] : ['--print', ...invocation.args], deps);
    case 'serve': return launchAgent(['--mode', 'rpc', ...invocation.args], deps);
    case 'tools': case 'skills': case 'memory': case 'awareness': return runSurface(invocation.command, invocation.args, deps);
    case 'launch': default: { const suggestion = suggestCommand(invocation.args[0]); if (suggestion) { out(`unknown command "${invocation.args[0]}"; did you mean "${suggestion}"?`); return 2; } return launchAgent(invocation.args, deps); }
  }
}
