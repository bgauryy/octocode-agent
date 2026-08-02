/**
 * octocode-agent launcher core.
 *
 * Architecture:
 *   @octocodeai/pi-extension is THE CORE (system prompt, skills, tools, awareness).
 *   octocode-agent is the PLATFORM: bundles the Pi binary, loads the core in-process
 *   via the Pi SDK (preferred) or as a subprocess via pi's -e flag (fallback).
 *
 * Launch modes:
 *   SDK embed (default)   — loads @octocodeai/pi-extension in-process via
 *                           extensionFactories; direct access to InteractiveMode,
 *                           runPrintMode, runRpcMode, SettingsManager.applyOverrides.
 *   Subprocess fallback   — original spawnSync path; used when the Pi SDK is
 *                           unavailable or OCTOCODE_LAUNCHER_MODE=subprocess is set.
 *
 * Core resolution (resolveCoreSpec) — subprocess path only:
 *   1. OCTOCODE_AGENT_EXTENSION_SPEC env (explicit override)
 *   2. Installed @octocodeai/pi-extension dependency (local workspace / global / npx fast path)
 *   3. npm:@octocodeai/pi-extension — pi fetches from npm (recovery fallback)
 *
 * Fork wiring — env overrides (no code change required when switching to a fork):
 *   OCTOCODE_PI_BIN      Absolute path to a locally-built Pi binary.
 *   OCTOCODE_PI_PACKAGE  npm package name override (e.g. @octocodeai/pi-coding-agent).
 *   OCTOCODE_LAUNCHER_MODE=subprocess  Force the subprocess path (skips SDK embed).
 *
 * Bundling @octocodeai/pi-extension:
 *   Local/workspace — resolved via workspace:* (dev monorepo).
 *   Production — published npm dep; pinned by yarn sync:version:publish before release.
 *   Guard: scripts/check-no-workspace-protocol.mjs blocks publish when workspace: leaks.
 *
 * This module has NO side effects at import time (safe to unit-test).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { getOctocodeHome, presentApiKeys } from './utils.js';
import type {
  PiBinInfo,
  SpawnFn,
  ParsedInvocation,
  UpdateCommandResult,
  LaunchDeps,
  SdkDeps,
} from './types.js';

const _require = createRequire(import.meta.url);

// ── Public constants ───────────────────────────────────────────────────────────

export const CORE_PACKAGE = '@octocodeai/pi-extension';
export const CORE_SPEC = `npm:${CORE_PACKAGE}`;
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Lean tool exclusions — drop OS builtins in favour of Octocode-native tools. */
export const LEAN_EXCLUDE_TOOLS = ['grep', 'find', 'ls'];

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** The effective Pi package name — reads OCTOCODE_PI_PACKAGE override first. */
export function getEffectivePiPackage(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOCODE_PI_PACKAGE ?? PI_PACKAGE;
}

/** Read this launcher package's own version. */
export function launcherVersion(): string | null {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    return (pkg['version'] as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an installed dependency's package.json path (or null).
 *
 * Packages with an `exports` field block `require.resolve('<pkg>/package.json')`
 * unless they export it. We fall back to scanning the node_modules search chain.
 * The cleanest fix on the dep side is adding `"./package.json": "./package.json"`
 * to the exports field (see @octocodeai/pi-extension package.json).
 */
export function resolvePackageJson(pkgName: string): string | null {
  try {
    return _require.resolve(`${pkgName}/package.json`);
  } catch {
    /* exports-gated — fall through */
  }
  const segments = pkgName.split('/');
  for (const base of _require.resolve.paths(pkgName) ?? []) {
    const pj = path.join(base, ...segments, 'package.json');
    if (fs.existsSync(pj)) return pj;
  }
  return null;
}

/** Read an installed dependency's version string (or null). */
export function readPackageVersion(pkgName: string): string | null {
  const pkgJson = resolvePackageJson(pkgName);
  if (!pkgJson) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as Record<string, unknown>;
    return (pkg['version'] as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the spec to pass to pi's -e flag (subprocess path only).
 * Resolution order:
 *   1. OCTOCODE_AGENT_EXTENSION_SPEC env var
 *   2. Local path from resolvePackageJson
 *   3. CORE_SPEC (npm:@octocodeai/pi-extension) — pi downloads for this run
 */
export function resolveCoreSpec(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OCTOCODE_AGENT_EXTENSION_SPEC) return env.OCTOCODE_AGENT_EXTENSION_SPEC;
  const pkgJson = resolvePackageJson(CORE_PACKAGE);
  if (pkgJson) return path.dirname(pkgJson);
  return CORE_SPEC;
}

/**
 * Resolve the Pi host executable.
 * Resolution order:
 *   1. OCTOCODE_PI_BIN env var — absolute path to a locally-built Pi binary
 *   2. OCTOCODE_PI_PACKAGE env var — resolve from an alternate npm package
 *   3. Default PI_PACKAGE — the bundled upstream release
 */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): PiBinInfo | null {
  if (env.OCTOCODE_PI_BIN) {
    const bin = env.OCTOCODE_PI_BIN;
    if (!fs.existsSync(bin)) return null;
    return { bin, pkgRoot: path.dirname(bin), source: 'env-bin' };
  }

  const pkgName = getEffectivePiPackage(env);
  const source: PiBinInfo['source'] = env.OCTOCODE_PI_PACKAGE ? 'env-package' : 'bundled';
  const pkgJson = resolvePackageJson(pkgName);
  if (!pkgJson) return null;
  const pkgRoot = path.dirname(pkgJson);

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const binField = manifest['bin'];
  let binRel: string | null = null;
  if (typeof binField === 'string') {
    binRel = binField;
  } else if (binField && typeof binField === 'object') {
    const obj = binField as Record<string, string>;
    binRel = obj['pi'] ?? Object.values(obj)[0] ?? null;
  }
  if (!binRel) return null;

  const bin = path.resolve(pkgRoot, binRel);
  return fs.existsSync(bin) ? { bin, pkgRoot, source } : null;
}

/**
 * Build the environment Pi launches with.
 * Sets OCTOCODE_PROMPT_MODE=octocode-first and OCTOCODE_AGENT=1.
 * Defaults PI_CACHE_RETENTION=long (never clobbers an explicit user value).
 */
export function buildLaunchEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (!env.OCTOCODE_PROMPT_MODE) env.OCTOCODE_PROMPT_MODE = 'octocode-first';
  env.OCTOCODE_AGENT = '1';
  if (!env.PI_CACHE_RETENTION) env.PI_CACHE_RETENTION = 'long';
  return env;
}

/**
 * Parse argv into a launcher invocation.
 * Reserved subcommands win; everything else is forwarded to Pi.
 */
export function parseInvocation(argv: string[] = []): ParsedInvocation {
  const first = argv[0];
  if (first === 'update' || first === '--update') {
    const target = argv[1] === 'core' ? 'core' : 'platform';
    return { command: 'update', target };
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { command: 'version' };
  }
  if (first === '--agent-help' || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help' };
  }
  if (first === 'config') return { command: 'config', args: argv.slice(1) };
  if (first === 'setup') return { command: 'setup', args: argv.slice(1) };
  if (first === 'auth') return { command: 'auth', args: argv.slice(1) };
  if (first === 'models') return { command: 'models' };
  if (first === 'sessions') return { command: 'sessions' };
  return { command: 'run', rest: argv };
}

/**
 * Build Pi argv for the subprocess path.
 * Fixed:  --no-extensions (prevents global extension conflicts)
 * Opt-in: OCTOCODE_AGENT_CLEAN=1 → --no-skills --no-context-files
 * Opt-out: OCTOCODE_AGENT_FULL_TOOLS=1 keeps grep/find/ls
 */
export function buildPiArgs(
  spec: string,
  argv: string[] = [],
  env: NodeJS.ProcessEnv = {},
): string[] {
  const args: string[] = ['--no-extensions'];
  const clean = env.OCTOCODE_AGENT_CLEAN === '1';
  if (clean) args.push('--no-skills');
  if (env.OCTOCODE_AGENT_FULL_TOOLS !== '1')
    args.push('--exclude-tools', LEAN_EXCLUDE_TOOLS.join(','));
  if (clean || env.OCTOCODE_AGENT_NO_CONTEXT_FILES === '1') args.push('--no-context-files');
  args.push('-e', spec);
  return [...args, ...argv];
}

// ── Report helpers ─────────────────────────────────────────────────────────────

export function versionReport(env: NodeJS.ProcessEnv = process.env): string {
  const effectivePkg = getEffectivePiPackage(env);
  const piVersion = env.OCTOCODE_PI_BIN
    ? `(local binary: ${env.OCTOCODE_PI_BIN})`
    : (readPackageVersion(effectivePkg) ?? 'not installed');

  const coreVersion = readPackageVersion(CORE_PACKAGE);
  const coreStatus = coreVersion ?? `not installed locally — will use ${CORE_SPEC} on run`;

  const launchMode =
    env.OCTOCODE_LAUNCHER_MODE === 'subprocess'
      ? 'subprocess (forced)'
      : 'SDK embed (default)';

  return [
    `octocode-agent   ${launcherVersion() ?? '?'}`,
    `core (${CORE_PACKAGE})   ${coreStatus}`,
    `pi host (${effectivePkg})   ${piVersion}`,
    `launch mode   ${launchMode}`,
  ].join('\n');
}

export function helpReport(): string {
  return [
    'octocode-agent — self-working coding agent (Pi + Octocode harness core)',
    '',
    'Usage:',
    '  octocode-agent [agent args...] Launch the agent (SDK embed by default)',
    '  octocode-agent update         Self-update the platform',
    '  octocode-agent update core    Update the bundled core extension in this install',
    '  octocode-agent config         Show current configuration and diagnostics',
    '  octocode-agent setup          First-run setup guide',
    '  octocode-agent auth           Show API key configuration instructions',
    '  octocode-agent models         Show model configuration instructions',
    '  octocode-agent sessions       Show session storage location and tips',
    '  octocode-agent --version      Print launcher, core, and Pi host versions',
    '',
    `The core (${CORE_PACKAGE}) carries the prompt, skills, tools, and memory.`,
    'The core is installed as a platform dependency. Refresh it without reinstalling:',
    '  octocode-agent update core',
    '',
    'Launch modes:',
    '  SDK embed (default)  — in-process Pi session with direct API access',
    '  Subprocess fallback  — spawns the Pi binary via -e flag',
    '  OCTOCODE_LAUNCHER_MODE=subprocess  — force subprocess mode',
    '',
    'Fork dev env vars (no code change required):',
    '  OCTOCODE_PI_BIN      Absolute path to a locally-built Pi binary',
    '  OCTOCODE_PI_PACKAGE  npm package name override (e.g. @octocodeai/pi-coding-agent)',
  ].join('\n');
}

export function configReport(env: NodeJS.ProcessEnv = process.env): string {
  const home = getOctocodeHome(env);
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const launchMode =
    env.OCTOCODE_LAUNCHER_MODE === 'subprocess'
      ? 'subprocess (forced via OCTOCODE_LAUNCHER_MODE)'
      : 'SDK embed (default; set OCTOCODE_LAUNCHER_MODE=subprocess to force subprocess)';
  const authInHome = fs.existsSync(path.join(home, 'auth.json'));
  const authInPi = fs.existsSync(path.join(piAgentDir, 'auth.json'));
  const keys = presentApiKeys(env);
  const coreSpec = resolveCoreSpec(env);
  const piInfo = resolvePiBin(env);

  return [
    'octocode-agent configuration',
    '',
    `launch mode:       ${launchMode}`,
    `octocode home:     ${home}${authInHome ? ' (auth.json present)' : ''}`,
    `pi agent dir:      ${piAgentDir}${authInPi ? ' (auth.json present)' : ''}`,
    '',
    `core:              ${coreSpec}`,
    `core version:      ${readPackageVersion(CORE_PACKAGE) ?? 'not installed locally'}`,
    `pi host:           ${piInfo ? `${piInfo.bin} (${piInfo.source})` : 'not found — run: octocode-agent update'}`,
    `pi version:        ${readPackageVersion(getEffectivePiPackage(env)) ?? 'unknown'}`,
    `launcher version:  ${launcherVersion() ?? '?'}`,
    '',
    keys.length > 0
      ? `api keys set:      ${keys.join(', ')}`
      : 'api keys set:      (none detected — see: octocode-agent auth)',
    '',
    'env overrides:',
    `  OCTOCODE_HOME=${env.OCTOCODE_HOME ?? '(not set)'}`,
    `  OCTOCODE_AGENT_DIR=${env.OCTOCODE_AGENT_DIR ?? '(not set)'}`,
    `  OCTOCODE_LAUNCHER_MODE=${env.OCTOCODE_LAUNCHER_MODE ?? '(not set)'}`,
    `  OCTOCODE_PI_BIN=${env.OCTOCODE_PI_BIN ?? '(not set)'}`,
    `  OCTOCODE_PI_PACKAGE=${env.OCTOCODE_PI_PACKAGE ?? '(not set)'}`,
    `  OCTOCODE_AGENT_EXTENSION_SPEC=${env.OCTOCODE_AGENT_EXTENSION_SPEC ?? '(not set)'}`,
  ].join('\n');
}

export function setupReport(env: NodeJS.ProcessEnv = process.env): string {
  const home = getOctocodeHome(env);
  const keys = presentApiKeys(env);
  const coreVersion = readPackageVersion(CORE_PACKAGE);
  const piVersion = readPackageVersion(getEffectivePiPackage(env));
  const checks: string[] = [];

  checks.push(
    piVersion
      ? `✓ Pi host installed (${piVersion})`
      : '✗ Pi host not found — run: octocode-agent update',
  );
  checks.push(
    coreVersion
      ? `✓ Core extension installed (${coreVersion})`
      : '✗ Core not found — run: octocode-agent update core',
  );
  checks.push(
    keys.length > 0
      ? `✓ API keys set: ${keys.join(', ')}`
      : '✗ No API keys found — see: octocode-agent auth',
  );

  const allGood = !checks.some((c) => c.startsWith('✗'));

  return [
    'octocode-agent setup',
    '',
    ...checks,
    '',
    allGood
      ? '✓ All checks passed. Run `octocode-agent` to start.'
      : 'Fix the issues above, then run `octocode-agent` to start.',
    '',
    `Configuration directory: ${home}`,
    `Sessions directory:      ${path.join(os.homedir(), '.pi', 'agent', 'sessions')}`,
    '',
    'Useful commands:',
    '  octocode-agent           Start interactive agent',
    '  octocode-agent config    Inspect full configuration',
    '  octocode-agent auth      API key setup guide',
    '  octocode-agent models    Model configuration guide',
    '  octocode-agent update    Self-update the platform',
  ].join('\n');
}

export function authReport(env: NodeJS.ProcessEnv = process.env): string {
  const keys = presentApiKeys(env);
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');

  return [
    'octocode-agent — API key configuration',
    '',
    'Option 1 — Environment variables (recommended):',
    '  ANTHROPIC_API_KEY     Claude (Anthropic) — https://console.anthropic.com',
    '  OPENAI_API_KEY        GPT-4 (OpenAI)     — https://platform.openai.com/api-keys',
    '  GEMINI_API_KEY        Gemini (Google)    — https://aistudio.google.com/app/apikey',
    '  MISTRAL_API_KEY       Mistral            — https://console.mistral.ai',
    '  GROQ_API_KEY          Groq               — https://console.groq.com',
    '',
    'Option 2 — .env files (loaded by Octocode at session start):',
    '  ~/.octocode/.env       global keys (writable when trusted: no)',
    '  <project>/.env         project-scoped keys (requires project trust)',
    '',
    'Option 3 — Persistent login (inside a running session):',
    '  Type: /login',
    `  Keys are stored in: ${path.join(piAgentDir, 'auth.json')}`,
    '',
    'Option 4 — Octocode tools (search providers):',
    '  GITHUB_TOKEN          GitHub access for Octocode tools',
    '  TAVILY_API_KEY        Tavily (best web search quality)',
    '  SERPER_API_KEY        Serper (Google SERP)',
    '  EXA_API_KEY           Exa (AI-native search)',
    '',
    keys.length > 0
      ? `Currently detected: ${keys.join(', ')}`
      : 'Currently detected: (none)',
  ].join('\n');
}

export function modelsReport(): string {
  return [
    'octocode-agent — model configuration',
    '',
    'Select a model at startup:',
    '  octocode-agent --model claude-opus-4-5',
    '  octocode-agent --model gpt-4o',
    '  octocode-agent --model gemini-2.5-pro',
    '',
    'Switch models inside a session:',
    '  /model <model-id>',
    '',
    'Set a default model:',
    '  Add to ~/.pi/agent/models.json or pass --model on every invocation.',
    '',
    'Cycle through configured models:',
    '  --models <model1>,<model2>,...',
    '',
    'Common models:',
    '  claude-opus-4-5     (Anthropic — strongest; requires ANTHROPIC_API_KEY)',
    '  claude-sonnet-4-5   (Anthropic — balanced)',
    '  gpt-4o              (OpenAI — requires OPENAI_API_KEY)',
    '  gemini-2.5-pro      (Google — requires GEMINI_API_KEY)',
    '',
    'Thinking/reasoning levels: --thinking off|minimal|low|medium|high|xhigh',
    '  (supported on claude-* and gemini-* models with reasoning=true)',
  ].join('\n');
}

export function sessionsReport(): string {
  const piSessions = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  return [
    'octocode-agent — session management',
    '',
    `Sessions are stored in: ${piSessions}`,
    '',
    'Continue the most recent session:',
    '  octocode-agent --continue   (or -c)',
    '',
    'Resume a specific session:',
    '  octocode-agent --session <path-to-session-file>',
    '',
    'Start a fresh session (no history saved):',
    '  octocode-agent --no-session',
    '',
    'Name the current session:',
    '  octocode-agent --name "my feature"',
    '',
    'Inside a session:',
    '  /new          Start a new conversation (saves current)',
    '  /resume       Resume a previous session',
    '  /compact      Compact long conversation history',
    '  /fork         Fork the conversation at a specific point',
  ].join('\n');
}

// ── Side-effecting runners ────────────────────────────────────────────────────

export function updateCommand(
  target: 'core' | 'platform',
  options: { prefix?: string } = {},
): UpdateCommandResult {
  if (target === 'core') {
    const prefix = options.prefix ?? launcherRoot();
    return { cmd: 'npm', args: ['install', '--prefix', prefix, '--omit=dev', `${CORE_PACKAGE}@latest`] };
  }
  return { cmd: 'npm', args: ['install', '-g', 'octocode-agent@latest'] };
}

export function launcherRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Default SDK launch — imports sdk-launcher dynamically so tests can stub it. */
async function defaultLaunchWithSdk(
  argv: string[],
  deps: SdkDeps,
): Promise<number | null> {
  try {
    const { launchWithSdk } = await import('./sdk-launcher.js');
    return launchWithSdk(argv, deps);
  } catch {
    return null;
  }
}

/**
 * Launch the agent. Tries the in-process SDK path first; falls back to the
 * subprocess (spawnSync) path when the SDK is unavailable or init fails.
 *
 * Force subprocess mode: OCTOCODE_LAUNCHER_MODE=subprocess
 * Inject `deps.launchWithSdk = async () => null` in tests to skip SDK.
 */
export async function launchAgent(
  argv: string[] = [],
  deps: LaunchDeps = {},
): Promise<number> {
  const log = deps.log ?? console.error;
  const env = buildLaunchEnv(deps.env ?? process.env);

  // SDK embed path (default)
  if (env.OCTOCODE_LAUNCHER_MODE !== 'subprocess') {
    const sdkFn = deps.launchWithSdk ?? defaultLaunchWithSdk;
    const sdkResult = await sdkFn(argv, { ...deps, log, env });
    if (sdkResult !== null) return sdkResult;
    // null → SDK unavailable; fall through to subprocess
  }

  // Subprocess fallback
  const spawn: SpawnFn = (deps.spawn as SpawnFn | undefined) ?? spawnSync;
  const piInfo = (deps.resolvePiBin ?? resolvePiBin)(env);

  if (!piInfo) {
    const effectivePkg = getEffectivePiPackage(env);
    const hint = env.OCTOCODE_PI_BIN
      ? `OCTOCODE_PI_BIN path not found: ${env.OCTOCODE_PI_BIN}`
      : `Pi host (${effectivePkg}) is not installed. Run: octocode-agent update`;
    log(`octocode-agent: ${hint}`);
    return 1;
  }

  const spec = (deps.resolveCoreSpec ?? resolveCoreSpec)(env);
  const result = spawn(piInfo.bin, buildPiArgs(spec, argv, env), { stdio: 'inherit', env });
  return typeof result?.status === 'number' ? result.status : result?.error ? 1 : 0;
}

export async function runUpdate(
  target: 'core' | 'platform',
  deps: LaunchDeps = {},
): Promise<number> {
  const spawn: SpawnFn = (deps.spawn as SpawnFn | undefined) ?? spawnSync;
  const log = deps.log ?? console.error;
  const { cmd, args } = updateCommand(target, deps);
  log(
    `octocode-agent: ${target === 'core' ? 'updating core' : 'self-updating platform'} → ${cmd} ${args.join(' ')}`,
  );
  const result = spawn(cmd, args, { stdio: 'inherit' });
  return typeof result?.status === 'number' ? result.status : result?.error ? 1 : 0;
}

export async function main(argv: string[] = [], deps: LaunchDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const env = deps.env ?? process.env;
  const { command, target, rest } = parseInvocation(argv);

  switch (command) {
    case 'version':
      out(versionReport(env));
      return 0;
    case 'help':
      out(helpReport());
      return 0;
    case 'config':
      out(configReport(env));
      return 0;
    case 'setup':
      out(setupReport(env));
      return 0;
    case 'auth':
      out(authReport(env));
      return 0;
    case 'models':
      out(modelsReport());
      return 0;
    case 'sessions':
      out(sessionsReport());
      return 0;
    case 'update':
      return runUpdate((target ?? 'platform') as 'core' | 'platform', deps);
    case 'run':
    default:
      return launchAgent(rest ?? [], deps);
  }
}
