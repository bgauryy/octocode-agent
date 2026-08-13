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
import {
  buildSurfaceSpec,
  loadProfile,
  profileToPiArgs,
  type SurfaceVerb,
} from './surfaces.js';
import {
  checkLines,
  cmdRows,
  colorEnabled,
  diagLine,
  header,
  hint,
  kv,
  launchBanner,
  makePainter,
  section,
} from './ui.js';
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
  const json = argv.includes('--json');
  const profileIdx = argv.indexOf('--profile');
  const profile = profileIdx >= 0 ? argv[profileIdx + 1] : undefined;
  if (first === 'update' || first === '--update') {
    const target = argv[1] === 'core' ? 'core' : 'platform';
    return { command: 'update', target };
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { command: 'version', json };
  }
  if (first === '--agent-help' || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help' };
  }
  if (first === 'completion') {
    return { command: 'completion', shell: argv[1] };
  }
  if (first === 'config') return { command: 'config', args: argv.slice(1), json };
  if (first === 'setup') return { command: 'setup', args: argv.slice(1), json };
  if (first === 'auth') return { command: 'auth', args: argv.slice(1), json };
  if (first === 'models') return { command: 'models', json };
  if (first === 'sessions') return { command: 'sessions', json };
  if (first === 'doctor') return { command: 'doctor', json };
  if (first === 'run') return { command: 'run', rest: argv.slice(1), json, profile };
  if (first === 'serve') return { command: 'serve', rest: argv.slice(1) };
  if (first === 'resume') return { command: 'resume', rest: argv.slice(1) };
  if (first === 'research') return { command: 'research', rest: argv.slice(1), json };
  if (first === 'memory') return { command: 'memory', rest: argv.slice(1), json };
  if (first === 'awareness') return { command: 'awareness', rest: argv.slice(1), json };
  if (first === 'tools') return { command: 'tools', rest: argv.slice(1), json };
  if (first === 'skills') return { command: 'skills', rest: argv.slice(1), json };
  return { command: 'launch', rest: argv, profile };
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

  const p = makePainter(colorEnabled(env));
  return [
    header(p, ''),
    '',
    kv(p, 'launcher', launcherVersion() ?? '?'),
    kv(p, 'core', `${coreStatus} ${p.dim(`(${CORE_PACKAGE})`)}`),
    kv(p, 'pi host', `${piVersion} ${p.dim(`(${effectivePkg})`)}`),
    kv(p, 'launch mode', launchMode),
  ].join('\n');
}

export interface VersionData {
  launcherVersion: string | null;
  core: { package: string; version: string | null };
  pi: { package: string; version: string | null; localBinPath: string | null };
  launchMode: 'sdk-embed' | 'subprocess';
}

/** JSON-serializable companion to versionReport — same underlying facts, structured. */
export function versionData(env: NodeJS.ProcessEnv = process.env): VersionData {
  const effectivePkg = getEffectivePiPackage(env);
  return {
    launcherVersion: launcherVersion(),
    core: { package: CORE_PACKAGE, version: readPackageVersion(CORE_PACKAGE) },
    pi: {
      package: effectivePkg,
      version: env.OCTOCODE_PI_BIN ? null : readPackageVersion(effectivePkg),
      localBinPath: env.OCTOCODE_PI_BIN ?? null,
    },
    launchMode: env.OCTOCODE_LAUNCHER_MODE === 'subprocess' ? 'subprocess' : 'sdk-embed',
  };
}

export function helpReport(env: NodeJS.ProcessEnv = process.env): string {
  const p = makePainter(colorEnabled(env));
  return [
    header(p, ''),
    '',
    p.dim('The self-working coding agent: the Pi runtime driven by the Octocode harness.'),
    '',
    section(p, 'Get started'),
    ...cmdRows(p, [
      ['octocode-agent [args]', 'launch the agent (SDK embed by default)'],
      ['octocode-agent "<prompt>"', 'launch with an initial message'],
      ['run "<task>" [--json]', 'headless: run once, print result, exit'],
      ['serve', 'RPC over stdin/stdout for IDE/web embeds'],
      ['resume [<id>]', 'resume a session by id/name, or pick one'],
    ]),
    '',
    section(p, 'Surfaces'),
    ...cmdRows(p, [
      ['research "<q>"', 'one-shot research lane (no chat)'],
      ['memory ...', 'persistent memory (recall/record/forget)'],
      ['awareness ...', 'coordination dashboard (attend/status/verify)'],
      ['tools | skills', 'Octocode tools catalog / skills'],
    ]),
    '',
    section(p, 'Setup & health'),
    ...cmdRows(p, [
      ['doctor', 'one health pane: Pi host, core, auth, awareness'],
      ['setup', 'first-run setup checks'],
      ['auth [login|logout|status]', 'credentials (env keys or /login)'],
      ['models', 'model configuration guide'],
      ['config', 'configuration and diagnostics'],
      ['sessions', 'session storage location and tips'],
    ]),
    '',
    section(p, 'Maintenance'),
    ...cmdRows(p, [
      ['update', 'self-update the platform'],
      ['update core', 'refresh the bundled core in this install'],
      ['completion <bash|zsh|fish>', 'print a shell completion script'],
      ['--version [--json]', 'launcher, core, and Pi host versions'],
    ]),
    '',
    section(p, 'Options'),
    ...cmdRows(p, [
      ['--profile <name>', 'preset from ~/.octocode/profiles.json (model+tools+approve)'],
      ['--json', 'machine-readable output for config/setup/auth/models/sessions/--version'],
    ]),
    '',
    section(p, 'Launch modes'),
    `  SDK embed (default)   ${p.dim('— in-process Pi session with direct API access')}`,
    `  Subprocess fallback   ${p.dim('— spawns the Pi binary via the -e flag')}`,
    `  ${p.dim('Force with OCTOCODE_LAUNCHER_MODE=subprocess.')}`,
    '',
    section(p, 'Fork dev'),
    `  ${kv(p, 'OCTOCODE_PI_BIN', p.dim('absolute path to a locally-built Pi binary'))}`,
    `  ${kv(p, 'OCTOCODE_PI_PACKAGE', p.dim('npm package override (e.g. @octocodeai/pi-coding-agent)'))}`,
    '',
    p.dim(`The core (${CORE_PACKAGE}) carries the prompt, skills, tools, and memory.`),
    hint(p, 'shell completions: eval "$(octocode-agent completion zsh)"'),
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

  const p = makePainter(colorEnabled(env));
  const envRow = (name: string): string =>
    `  ${p.gray(name)}=${(env[name] as string | undefined) ?? p.dim('(not set)')}`;

  return [
    header(p, 'config'),
    '',
    section(p, 'Runtime'),
    kv(p, 'launch mode', launchMode),
    kv(p, 'octocode home', `${home}${authInHome ? p.dim(' (auth.json present)') : ''}`),
    kv(p, 'pi agent dir', `${piAgentDir}${authInPi ? p.dim(' (auth.json present)') : ''}`),
    '',
    section(p, 'Packages'),
    kv(
      p,
      'core',
      `${coreSpec} ${p.dim(readPackageVersion(CORE_PACKAGE) ?? 'not installed locally')}`,
    ),
    kv(
      p,
      'pi host',
      piInfo
        ? `${piInfo.bin} (${piInfo.source})`
        : p.red('not found — run: octocode-agent update'),
    ),
    kv(p, 'pi version', readPackageVersion(getEffectivePiPackage(env)) ?? 'unknown'),
    kv(p, 'launcher version', launcherVersion() ?? '?'),
    '',
    section(p, 'Keys'),
    kv(
      p,
      'api keys set',
      keys.length > 0 ? keys.join(', ') : p.red('(none detected — see: octocode-agent auth)'),
    ),
    '',
    section(p, 'Env overrides'),
    envRow('OCTOCODE_HOME'),
    envRow('OCTOCODE_AGENT_DIR'),
    envRow('OCTOCODE_LAUNCHER_MODE'),
    envRow('OCTOCODE_PI_BIN'),
    envRow('OCTOCODE_PI_PACKAGE'),
    envRow('OCTOCODE_AGENT_EXTENSION_SPEC'),
  ].join('\n');
}

export interface ConfigData {
  launchMode: 'sdk-embed' | 'subprocess';
  octocodeHome: string;
  octocodeHomeHasAuth: boolean;
  piAgentDir: string;
  piAgentDirHasAuth: boolean;
  core: { spec: string; version: string | null };
  pi: { bin: string | null; source: PiBinInfo['source'] | null; version: string | null };
  launcherVersion: string | null;
  apiKeysSet: string[];
  env: {
    OCTOCODE_HOME: string | null;
    OCTOCODE_AGENT_DIR: string | null;
    OCTOCODE_LAUNCHER_MODE: string | null;
    OCTOCODE_PI_BIN: string | null;
    OCTOCODE_PI_PACKAGE: string | null;
    OCTOCODE_AGENT_EXTENSION_SPEC: string | null;
  };
}

/** JSON-serializable companion to configReport — same underlying facts, structured. */
export function configData(env: NodeJS.ProcessEnv = process.env): ConfigData {
  const home = getOctocodeHome(env);
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const piInfo = resolvePiBin(env);
  return {
    launchMode: env.OCTOCODE_LAUNCHER_MODE === 'subprocess' ? 'subprocess' : 'sdk-embed',
    octocodeHome: home,
    octocodeHomeHasAuth: fs.existsSync(path.join(home, 'auth.json')),
    piAgentDir,
    piAgentDirHasAuth: fs.existsSync(path.join(piAgentDir, 'auth.json')),
    core: { spec: resolveCoreSpec(env), version: readPackageVersion(CORE_PACKAGE) },
    pi: {
      bin: piInfo?.bin ?? null,
      source: piInfo?.source ?? null,
      version: readPackageVersion(getEffectivePiPackage(env)),
    },
    launcherVersion: launcherVersion(),
    apiKeysSet: presentApiKeys(env),
    env: {
      OCTOCODE_HOME: env.OCTOCODE_HOME ?? null,
      OCTOCODE_AGENT_DIR: env.OCTOCODE_AGENT_DIR ?? null,
      OCTOCODE_LAUNCHER_MODE: env.OCTOCODE_LAUNCHER_MODE ?? null,
      OCTOCODE_PI_BIN: env.OCTOCODE_PI_BIN ?? null,
      OCTOCODE_PI_PACKAGE: env.OCTOCODE_PI_PACKAGE ?? null,
      OCTOCODE_AGENT_EXTENSION_SPEC: env.OCTOCODE_AGENT_EXTENSION_SPEC ?? null,
    },
  };
}

export function setupReport(env: NodeJS.ProcessEnv = process.env): string {
  const p = makePainter(colorEnabled(env));
  const home = getOctocodeHome(env);
  const keys = presentApiKeys(env);
  const coreVersion = readPackageVersion(CORE_PACKAGE);
  const piVersion = readPackageVersion(getEffectivePiPackage(env));
  const checks: string[] = [];

  const piOk = Boolean(piVersion);
  const coreOk = Boolean(coreVersion);
  const keysOk = keys.length > 0;

  checks.push(
    ...checkLines(
      p,
      piOk ? 'ok' : 'fail',
      'Pi host',
      piVersion ? `installed (${piVersion})` : 'not found',
      piOk ? undefined : 'octocode-agent update',
    ),
  );
  checks.push(
    ...checkLines(
      p,
      coreOk ? 'ok' : 'fail',
      'Core',
      coreVersion ? `installed (${coreVersion})` : 'not found',
      coreOk ? undefined : 'octocode-agent update core',
    ),
  );
  checks.push(
    ...checkLines(
      p,
      keysOk ? 'ok' : 'fail',
      'API keys',
      keysOk ? `set: ${keys.join(', ')}` : 'none detected',
      keysOk ? undefined : 'octocode-agent auth',
    ),
  );

  const allGood = piOk && coreOk && keysOk;

  return [
    header(p, 'setup'),
    '',
    ...checks,
    '',
    allGood
      ? p.green('✓ All checks passed — run `octocode-agent` to start.')
      : p.red('✗ Fix the issues above, then run `octocode-agent` to start.'),
    '',
    kv(p, 'config dir', home),
    kv(p, 'sessions dir', path.join(os.homedir(), '.pi', 'agent', 'sessions')),
    '',
    section(p, 'Next'),
    ...cmdRows(p, [
      ['octocode-agent', 'start the interactive agent'],
      ['octocode-agent doctor', 'full health pane'],
      ['octocode-agent config', 'inspect configuration'],
      ['octocode-agent update', 'self-update the platform'],
    ]),
  ].join('\n');
}

export interface SetupCheck {
  name: 'pi-host' | 'core' | 'api-keys';
  ok: boolean;
  detail: string;
}

export interface SetupData {
  checks: SetupCheck[];
  allGood: boolean;
  octocodeHome: string;
  sessionsDir: string;
}

/** JSON-serializable companion to setupReport — same checks, structured. */
export function setupData(env: NodeJS.ProcessEnv = process.env): SetupData {
  const keys = presentApiKeys(env);
  const coreVersion = readPackageVersion(CORE_PACKAGE);
  const piVersion = readPackageVersion(getEffectivePiPackage(env));
  const checks: SetupCheck[] = [
    { name: 'pi-host', ok: Boolean(piVersion), detail: piVersion ?? 'not found' },
    { name: 'core', ok: Boolean(coreVersion), detail: coreVersion ?? 'not found' },
    {
      name: 'api-keys',
      ok: keys.length > 0,
      detail: keys.length > 0 ? keys.join(', ') : 'none detected',
    },
  ];
  return {
    checks,
    allGood: checks.every((c) => c.ok),
    octocodeHome: getOctocodeHome(env),
    sessionsDir: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  };
}

export function authReport(env: NodeJS.ProcessEnv = process.env): string {
  const keys = presentApiKeys(env);
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');

  const p = makePainter(colorEnabled(env));
  return [
    header(p, 'auth'),
    '',
    section(p, 'Providers (env keys — recommended)'),
    ...cmdRows(p, [
      ['ANTHROPIC_API_KEY', 'Claude (Anthropic) — https://console.anthropic.com'],
      ['OPENAI_API_KEY', 'GPT-4 (OpenAI) — https://platform.openai.com/api-keys'],
      ['GEMINI_API_KEY', 'Gemini (Google) — https://aistudio.google.com/app/apikey'],
      ['MISTRAL_API_KEY', 'Mistral — https://console.mistral.ai'],
      ['GROQ_API_KEY', 'Groq — https://console.groq.com'],
    ]),
    '',
    section(p, '.env files (loaded at session start)'),
    `  ${kv(p, '~/.octocode/.env', p.dim('global keys'))}`,
    `  ${kv(p, '<project>/.env', p.dim('project-scoped keys (requires trust)'))}`,
    '',
    section(p, 'Persistent login (inside a running session)'),
    `  Type ${p.brand('/login')} ${p.dim(`— keys are stored in ${path.join(piAgentDir, 'auth.json')}`)}`,
    '',
    section(p, 'Octocode tools (search providers)'),
    ...cmdRows(p, [
      ['GITHUB_TOKEN', 'GitHub access for Octocode tools'],
      ['TAVILY_API_KEY', 'Tavily (best web search quality)'],
      ['SERPER_API_KEY', 'Serper (Google SERP)'],
      ['EXA_API_KEY', 'Exa (AI-native search)'],
    ]),
    '',
    keys.length > 0
      ? `${p.accent('Currently detected:')} ${keys.join(', ')}`
      : `${p.accent('Currently detected:')} ${p.red('(none)')}`,
  ].join('\n');
}

export interface AuthData {
  detectedKeys: string[];
  authJsonPath: string;
}

/** JSON-serializable companion to authReport — the dynamic facts only (not the static option list). */
export function authData(env: NodeJS.ProcessEnv = process.env): AuthData {
  return {
    detectedKeys: presentApiKeys(env),
    authJsonPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
  };
}

export function modelsReport(env: NodeJS.ProcessEnv = process.env): string {
  const p = makePainter(colorEnabled(env));
  return [
    header(p, 'models'),
    '',
    section(p, 'Pick a model'),
    ...cmdRows(p, [
      ['octocode-agent --model <id>', 'launch with a model'],
      ['/model <id>', 'switch inside a session'],
      ['--models a,b,c', 'cycle through configured models'],
      ['~/.pi/agent/models.json', 'persist a default'],
    ]),
    '',
    section(p, 'Common models'),
    ...cmdRows(p, [
      ['claude-opus-4-5', 'Anthropic — strongest; requires ANTHROPIC_API_KEY'],
      ['claude-sonnet-4-5', 'Anthropic — balanced'],
      ['gpt-4o', 'OpenAI — requires OPENAI_API_KEY'],
      ['gemini-2.5-pro', 'Google — requires GEMINI_API_KEY'],
    ]),
    '',
    section(p, 'Thinking'),
    `  ${p.brand('--thinking off|minimal|low|medium|high|xhigh')}`,
    p.dim('  supported on claude-* and gemini-* models with reasoning=true'),
  ].join('\n');
}

export interface ModelData {
  id: string;
  provider: string;
  note: string;
}

export interface ModelsData {
  commonModels: ModelData[];
}

/** JSON-serializable companion to modelsReport — the reference model list. */
export function modelsData(): ModelsData {
  return {
    commonModels: [
      { id: 'claude-opus-4-5', provider: 'anthropic', note: 'strongest; requires ANTHROPIC_API_KEY' },
      { id: 'claude-sonnet-4-5', provider: 'anthropic', note: 'balanced' },
      { id: 'gpt-4o', provider: 'openai', note: 'requires OPENAI_API_KEY' },
      { id: 'gemini-2.5-pro', provider: 'google', note: 'requires GEMINI_API_KEY' },
    ],
  };
}

export interface SessionsData {
  sessionsDir: string;
}

/** JSON-serializable companion to sessionsReport — the dynamic fact (sessions dir). */
export function sessionsData(): SessionsData {
  return { sessionsDir: path.join(os.homedir(), '.pi', 'agent', 'sessions') };
}

export function sessionsReport(env: NodeJS.ProcessEnv = process.env): string {
  const p = makePainter(colorEnabled(env));
  const piSessions = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  return [
    header(p, 'sessions'),
    '',
    kv(p, 'stored in', piSessions),
    '',
    section(p, 'From the CLI'),
    ...cmdRows(p, [
      ['octocode-agent --continue', 'continue the most recent session (or -c)'],
      ['octocode-agent resume [<id>]', 'resume by id/name, or pick one'],
      ['octocode-agent --session <path>', 'resume a specific session file'],
      ['octocode-agent --no-session', 'start fresh; nothing saved'],
      ['octocode-agent --name "my feature"', 'name the new session'],
    ]),
    '',
    section(p, 'Inside a session'),
    ...cmdRows(p, [
      ['/new', 'start a new conversation (saves current)'],
      ['/resume', 'resume a previous session'],
      ['/compact', 'compact long conversation history'],
      ['/fork', 'fork the conversation at a specific point'],
    ]),
  ].join('\n');
}

// ── Doctor (health pane) ─────────────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Command to run when this check fails. */
  fix?: string;
}

export interface DoctorData {
  healthy: boolean;
  checks: DoctorCheck[];
}

/**
 * Aggregate one health pane: launcher, core, Pi host, auth, and Awareness CLI.
 * `healthy` is false when any critical check (core or Pi host) fails.
 */
export function doctorData(env: NodeJS.ProcessEnv = process.env): DoctorData {
  const effectivePkg = getEffectivePiPackage(env);
  const coreVersion = readPackageVersion(CORE_PACKAGE);
  const piVersion = env.OCTOCODE_PI_BIN ? env.OCTOCODE_PI_BIN : readPackageVersion(effectivePkg);
  const awarenessCli = env.OCTOCODE_AWARENESS_CLI;
  const awarenessOk = Boolean(awarenessCli && fs.existsSync(awarenessCli));
  const keys = presentApiKeys(env);

  const checks: DoctorCheck[] = [
    {
      name: 'launcher',
      ok: true,
      detail: launcherVersion() ?? 'unknown',
    },
    {
      name: 'core',
      ok: Boolean(coreVersion),
      detail: coreVersion ?? `not installed — will fetch ${CORE_SPEC} on run`,
      fix: coreVersion ? undefined : 'octocode-agent update core',
    },
    {
      name: 'pi-host',
      ok: Boolean(piVersion),
      detail: piVersion ?? 'not found',
      fix: piVersion ? undefined : 'octocode-agent update',
    },
    {
      name: 'auth',
      ok: keys.length > 0,
      detail: keys.length > 0 ? keys.join(', ') : 'no API keys detected',
      fix: keys.length > 0 ? undefined : 'octocode-agent auth',
    },
    {
      name: 'awareness',
      ok: awarenessOk,
      detail: awarenessOk
        ? (awarenessCli as string)
        : 'CLI not resolved (set at core load; run inside the agent)',
    },
  ];

  const healthy = checks.every((c) => c.ok || (c.name !== 'core' && c.name !== 'pi-host'));
  return { healthy, checks };
}

/** Human-readable health pane; ✓/✗ per subsystem plus the fix command on failure. */
export function doctorReport(env: NodeJS.ProcessEnv = process.env): string {
  const { healthy, checks } = doctorData(env);
  const p = makePainter(colorEnabled(env));
  const isCritical = (name: string): boolean => name === 'core' || name === 'pi-host';
  const lines: string[] = [header(p, 'doctor'), ''];
  for (const c of checks) {
    const status = c.ok ? 'ok' : isCritical(c.name) ? 'fail' : 'warn';
    lines.push(...checkLines(p, status, c.name, c.detail, c.fix));
  }
  lines.push(
    '',
    healthy ? p.green('✓ Healthy.') : p.red('✗ Unhealthy — fix the failures above.'),
  );
  return lines.join('\n');
}

// ── Surface + profile runtime helpers ───────────────────────────────────────────────

/**
 * Run a surface verb by spawning the resolved CLI with inherited stdio.
 * Returns the child exit code, 2 when the CLI could not be resolved.
 */
export function runSurface(
  verb: SurfaceVerb,
  rest: string[],
  deps: LaunchDeps = {},
): number {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  const spec = buildSurfaceSpec(verb, rest, env);
  if ('error' in spec) {
    out(`${p.red('✗')} ${spec.error}`);
    return 2;
  }
  const spawn = deps.spawn ?? (spawnSync as unknown as SpawnFn);
  const result = spawn(spec.cmd, spec.args, { stdio: 'inherit', env });
  if (result.error) {
    out(`${p.red('✗')} Failed to run ${verb}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 0;
}

/**
 * Apply a named --profile to launch args: prepend its Pi flags and strip the
 * `--profile <name>` tokens so they never reach Pi. No-op when the profile is
 * absent or unresolved.
 */
export function applyProfile(
  rest: string[],
  profileName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--profile') {
      i++; // skip the value too
      continue;
    }
    stripped.push(rest[i]);
  }
  if (!profileName) return stripped;
  const profile = loadProfile(profileName, getOctocodeHome(env));
  if (!profile) return stripped;
  return [...profileToPiArgs(profile), ...stripped];
}

// ── Shell completion ────────────────────────────────────────────────────────────

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Reserved subcommands, kept in sync with parseInvocation — single source for completion generation. */
const SUBCOMMANDS = ['run', 'serve', 'resume', 'research', 'memory', 'awareness', 'tools', 'skills', 'update', 'config', 'setup', 'auth', 'models', 'sessions', 'doctor', 'completion'] as const;
const UPDATE_TARGETS = ['core', 'platform'] as const;

function bashCompletionScript(): string {
  return [
    '_octocode_agent_completions() {',
    '  local cur prev',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  if [[ "$prev" == "update" ]]; then',
    `    COMPREPLY=($(compgen -W "${UPDATE_TARGETS.join(' ')}" -- "$cur"))`,
    '    return',
    '  fi',
    '  if [[ "$prev" == "completion" ]]; then',
    `    COMPREPLY=($(compgen -W "${COMPLETION_SHELLS.join(' ')}" -- "$cur"))`,
    '    return',
    '  fi',
    `  COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(' ')} --version --help --json" -- "$cur"))`,
    '}',
    'complete -F _octocode_agent_completions octocode-agent',
    '',
  ].join('\n');
}

function zshCompletionScript(): string {
  return [
    '#compdef octocode-agent',
    '_octocode_agent() {',
    '  local -a subcommands',
    '  subcommands=(',
    "    'run:Headless: run one task, print result, exit'",
    "    'serve:RPC over stdin/stdout for IDE/web embeds'",
    "    'resume:Resume a session by id/name or pick one'",
    "    'research:One-shot research lane (octocode search)'",
    "    'memory:Persistent memory (recall/record/forget)'",
    "    'awareness:Coordination dashboard (attend/status/verify)'",
    "    'tools:Octocode tools catalog'",
    "    'skills:List/add Octocode skills'",
    "    'update:Self-update the platform (or \\`update core\\` to refresh the core extension)'",
    "    'config:Show current configuration and diagnostics'",
    "    'setup:First-run setup guide'",
    "    'auth:Show API key configuration instructions'",
    "    'models:Show model configuration instructions'",
    "    'sessions:Show session storage location and tips'",
    "    'doctor:One health pane: Pi host, core, auth, awareness'",
    "    'completion:Print a shell completion script'",
    '  )',
    '  if (( CURRENT == 3 )); then',
    '    case ${words[2]} in',
    `      update) _values 'target' ${UPDATE_TARGETS.join(' ')}; return ;;`,
    `      completion) _values 'shell' ${COMPLETION_SHELLS.join(' ')}; return ;;`,
    '    esac',
    '  fi',
    "  _describe 'command' subcommands",
    "  _arguments '--json[machine-readable output]' '--version[print version info]' '--help[show help]'",
    '}',
    '_octocode_agent',
    '',
  ].join('\n');
}

function fishCompletionScript(): string {
  const lines = [
    'complete -c octocode-agent -f',
    'complete -c octocode-agent -n "__fish_use_subcommand" -l version -d "Print launcher, core, and Pi host versions"',
    'complete -c octocode-agent -n "__fish_use_subcommand" -l help -d "Show help"',
  ];
  const descriptions: Record<(typeof SUBCOMMANDS)[number], string> = {
    run: 'Headless: run one task, print result, exit',
    serve: 'RPC over stdin/stdout for IDE/web embeds',
    resume: 'Resume a session by id/name or pick one',
    research: 'One-shot research lane (octocode search)',
    memory: 'Persistent memory (recall/record/forget)',
    awareness: 'Coordination dashboard (attend/status/verify)',
    tools: 'Octocode tools catalog',
    skills: 'List/add Octocode skills',
    update: 'Self-update the platform or core',
    config: 'Show current configuration and diagnostics',
    setup: 'First-run setup guide',
    auth: 'Show API key configuration instructions',
    models: 'Show model configuration instructions',
    sessions: 'Show session storage location and tips',
    doctor: 'One health pane: Pi host, core, auth, awareness',
    completion: 'Print a shell completion script',
  };
  for (const name of SUBCOMMANDS) {
    lines.push(
      `complete -c octocode-agent -n "__fish_use_subcommand" -a ${name} -d "${descriptions[name]}"`,
    );
  }
  lines.push(
    `complete -c octocode-agent -n "__fish_seen_subcommand_from update" -a "${UPDATE_TARGETS.join(' ')}"`,
    `complete -c octocode-agent -n "__fish_seen_subcommand_from completion" -a "${COMPLETION_SHELLS.join(' ')}"`,
    'complete -c octocode-agent -n "__fish_seen_subcommand_from config setup auth models sessions" -l json -d "Machine-readable output"',
    '',
  );
  return lines.join('\n');
}

/** Generates a shell completion script for the given shell name, or null when unsupported. */
export function completionScript(shell: string): string | null {
  switch (shell) {
    case 'bash':
      return bashCompletionScript();
    case 'zsh':
      return zshCompletionScript();
    case 'fish':
      return fishCompletionScript();
    default:
      return null;
  }
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
  const p = makePainter(colorEnabled(deps.env ?? process.env));
  const log = deps.log ?? ((msg: string) => console.error(diagLine(p, msg)));
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
    const message = env.OCTOCODE_PI_BIN
      ? `OCTOCODE_PI_BIN path not found: ${env.OCTOCODE_PI_BIN}`
      : `Pi host (${effectivePkg}) is not installed. Run: octocode-agent update`;
    log(`octocode-agent: ${message}`);
    log(`octocode-agent: diagnose with: octocode-agent doctor`);
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
  const env = deps.env ?? process.env;
  const p = makePainter(colorEnabled(env));
  const log = deps.log ?? ((msg: string) => console.error(diagLine(p, msg)));
  const { cmd, args } = updateCommand(target, deps);
  log(
    `octocode-agent: ${target === 'core' ? 'updating core' : 'self-updating platform'} → ${p.dim(`${cmd} ${args.join(' ')}`)}`,
  );
  const result = spawn(cmd, args, { stdio: 'inherit' });
  const status = typeof result?.status === 'number' ? result.status : result?.error ? 1 : 0;
  if (status === 0) {
    const refreshed = target === 'core' ? readPackageVersion(CORE_PACKAGE) : null;
    log(
      target === 'core'
        ? `octocode-agent: ${p.green('✓')} core updated${refreshed ? ` → ${refreshed}` : ''}`
        : `octocode-agent: ${p.green('✓')} platform updated — restart to pick it up`,
    );
  } else {
    log(`octocode-agent: ${p.red('✗')} update failed (exit ${status}) — see npm output above`);
  }
  return status;
}

/** Flags that make a launch non-interactive — they suppress the brand banner. */
const NON_INTERACTIVE_FLAGS = new Set(['-p', '--print', '--mode', '--json']);

/**
 * Print the one-line brand banner before an interactive launch.
 * TTY-stderr only; honors OCTOCODE_AGENT_NO_BANNER=1 and skips print/rpc runs.
 */
export function printLaunchBanner(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = (m) => console.error(m),
  isTTY: boolean = Boolean((process.stderr as { isTTY?: boolean }).isTTY),
): boolean {
  if (!isTTY) return false;
  if (env.OCTOCODE_AGENT_NO_BANNER === '1') return false;
  if (argv.some((a) => NON_INTERACTIVE_FLAGS.has(a))) return false;
  const p = makePainter(colorEnabled(env, true));
  log(
    launchBanner(p, {
      launcher: launcherVersion(),
      core: readPackageVersion(CORE_PACKAGE),
      pi: env.OCTOCODE_PI_BIN ? null : readPackageVersion(getEffectivePiPackage(env)),
    }),
  );
  return true;
}

export async function main(argv: string[] = [], deps: LaunchDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const env = deps.env ?? process.env;
  const { command, target, shell, json, rest, args, profile } = parseInvocation(argv);

  switch (command) {
    case 'version':
      out(json ? JSON.stringify(versionData(env), null, 2) : versionReport(env));
      return 0;
    case 'help':
      out(helpReport(env));
      return 0;
    case 'config':
      out(json ? JSON.stringify(configData(env), null, 2) : configReport(env));
      return 0;
    case 'setup':
      out(json ? JSON.stringify(setupData(env), null, 2) : setupReport(env));
      return 0;
    case 'auth': {
      const sub = args?.[0];
      if (sub === 'login') return launchAgent([], deps);
      if (sub === 'logout') {
        const p = makePainter(colorEnabled(env));
        out(
          [
            hint(p, `remove stored credentials: rm ${authData(env).authJsonPath}`),
            hint(p, 'or unset the provider API-key environment variables'),
          ].join('\n'),
        );
        return 0;
      }
      if (sub === 'status') {
        const data = authData(env);
        const p = makePainter(colorEnabled(env));
        out(
          json
            ? JSON.stringify(data, null, 2)
            : data.detectedKeys.length > 0
              ? `${p.green('✓')} Authenticated: ${data.detectedKeys.join(', ')}`
              : `${p.red('✗')} Not authenticated (no API keys detected)`,
        );
        return data.detectedKeys.length > 0 ? 0 : 2;
      }
      out(json ? JSON.stringify(authData(env), null, 2) : authReport(env));
      return 0;
    }
    case 'doctor': {
      const data = doctorData(env);
      out(json ? JSON.stringify(data, null, 2) : doctorReport(env));
      return data.healthy ? 0 : 1;
    }
    case 'models':
      out(json ? JSON.stringify(modelsData(), null, 2) : modelsReport(env));
      return 0;
    case 'sessions':
      out(json ? JSON.stringify(sessionsData(), null, 2) : sessionsReport(env));
      return 0;
    case 'completion': {
      const script = completionScript(shell ?? '');
      if (!script) {
        const p = makePainter(colorEnabled(env));
        out(
          `${p.red('✗')} Unknown shell "${shell ?? ''}". Supported: ${COMPLETION_SHELLS.join(', ')}.\n` +
            hint(p, `usage: octocode-agent completion <${COMPLETION_SHELLS.join('|')}>`),
        );
        return 1;
      }
      out(script);
      return 0;
    }
    case 'update':
      return runUpdate((target ?? 'platform') as 'core' | 'platform', deps);
    case 'research':
    case 'memory':
    case 'awareness':
    case 'tools':
    case 'skills':
      return runSurface(command, rest ?? [], deps);
    case 'run': {
      const passthrough = applyProfile(
        (rest ?? []).filter((a) => a !== '--json'),
        profile,
        env,
      );
      const mode = json ? ['--mode', 'json'] : ['--print'];
      return launchAgent([...mode, ...passthrough], deps);
    }
    case 'serve':
      return launchAgent(['--mode', 'rpc', ...(rest ?? [])], deps);
    case 'resume': {
      const r = rest ?? [];
      const id = r[0] && !r[0].startsWith('-') ? r[0] : undefined;
      printLaunchBanner(r, env, deps.log);
      return launchAgent(id ? ['--session', id, ...r.slice(1)] : ['-r', ...r], deps);
    }
    case 'launch':
    default: {
      printLaunchBanner(rest ?? [], env, deps.log);
      return launchAgent(applyProfile(rest ?? [], profile, env), deps);
    }
  }
}
