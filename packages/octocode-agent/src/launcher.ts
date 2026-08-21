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

import { getOctocodeHome, OCTOCODE_PROMPT_MODE, presentApiKeys } from './utils.js';
import { runAuthWizard } from './onboard.js';
import { AUTH_PROVIDERS } from './auth-providers.js';
import { selectOne } from './picker.js';
import {
  ensureOctocodeThemeSetting,
  getSetting,
  isAllowedConfigKey,
  listSettings,
  piAgentDir,
  setDefaultModelInSettings,
  setSetting,
} from './settings.js';
import { listSessions, newestProjectSession, type SessionFile } from './sessions.js';
import {
  AGENT_STATE_VERSION,
  markSetupDone,
  readAgentState,
  readBreadcrumb,
  terminalId,
  writeBreadcrumb,
} from './state.js';
import {
  buildSurfaceSpec,
  loadProfile,
  profileToPiArgs,
  type SurfaceVerb,
} from '@octocodeai/pi-extension';
import {
  checkLines,
  cmdRows,
  colorEnabled,
  ellipsizeEnd,
  diagLine,
  fitText,
  header,
  hint,
  kv,
  launchBanner,
  octopusArt,
  octopusFrame,
  octopusShimmerSpan,
  link,
  makePainter,
  section,
  terminalWidth,
  tildePath,
  wrapText,
} from './ui.js';
import type {
  PiBinInfo,
  SpawnFn,
  ParsedInvocation,
  UpdateCommandResult,
  LaunchDeps,
  SdkDeps,
} from './types.js';
import { parseServeArgs, runServeStdio as defaultRunServeStdio } from './serve.js';

const _require = createRequire(import.meta.url);

// ── Public constants ───────────────────────────────────────────────────────────

export const CORE_PACKAGE = '@octocodeai/pi-extension';
export const CORE_SPEC = `npm:${CORE_PACKAGE}`;
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Lean tool exclusions — drop OS builtins in favour of Octocode-native tools. */
export const LEAN_EXCLUDE_TOOLS = ['grep', 'find', 'ls'];

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** Normalize spawnSync-like results: null status means signal/failed child, never success. */
export function spawnExitStatus(result: { status?: number | null; error?: Error } | undefined): number {
  if (typeof result?.status === 'number') return result.status;
  return 1;
}

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
  if (!env.OCTOCODE_PROMPT_MODE) env.OCTOCODE_PROMPT_MODE = OCTOCODE_PROMPT_MODE;
  env.OCTOCODE_AGENT = '1';
  if (!env.PI_CACHE_RETENTION) env.PI_CACHE_RETENTION = 'long';
  // Octocode owns its update story (`octocode-agent update`) — Pi's own
  // "New version … Run pi update (pi.dev)" widget is the single most visible
  // Pi-branded surface in a branded session; suppress it by default.
  // An explicitly-set value (even empty) always wins.
  if (env.PI_SKIP_VERSION_CHECK === undefined) env.PI_SKIP_VERSION_CHECK = '1';
  // Brand mirroring (OMP's OMP_*→PI_* idea): OCTOCODE_PI_FOO feeds PI_FOO.
  // An explicit PI_FOO always wins — mirroring fills gaps only.
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || !key.startsWith('OCTOCODE_PI_')) continue;
    const alias = `PI_${key.slice('OCTOCODE_PI_'.length)}`;
    if (alias !== 'PI_' && env[alias] === undefined) env[alias] = value;
  }
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
  if (first === 'models') return { command: 'models', args: argv.slice(1), json };
  if (first === 'sessions') return { command: 'sessions', json };
  if (first === 'doctor') return { command: 'doctor', json };
  if (first === '--smoke-test' || first === 'smoke') return { command: 'smoke' };
  if (first === 'run') return { command: 'run', rest: argv.slice(1), json, profile };
  if (first === 'session') return { command: 'resume', rest: argv.slice(1) };
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
    kv(p, 'runtime', `${piVersion} ${p.dim(`(${effectivePkg})`)}`),
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
    ...wrapText('The self-working coding agent: the Octocode harness runtime.', terminalWidth()).map((l) => p.dim(l)),
    '',
    section(p, 'Get started'),
    ...cmdRows(p, [
      ['octocode-agent [args]', 'launch the agent (SDK embed by default)'],
      ['octocode-agent "<prompt>"', 'launch with an initial message'],
      ['run "<task>" [--json]', 'headless: run once, print result, exit'],
      ['serve [--stdio]', 'Octocode thin-client envelope over stdin/stdout for IDE/web embeds'],
      ['serve --raw-rpc', 'compat: raw runtime RPC stdin/stdout'],
      ['resume|session [<id>]', 'resume: pick, or fuzzy id; -c resumes THIS terminal'],
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
      ['doctor', 'one health pane: runtime, core, auth, awareness'],
      ['setup', 'first-run setup checks'],
      ['auth [login|logout|status]', 'credentials (env keys or /login)'],
      ['models [--set id]', 'pick or pin the default model'],
      ['config [get|set|list]', 'settings.json keys (writable: defaultProvider/Model)'],
      ['sessions', 'storage location + resume tips'],
      ['--smoke-test', 'self-check for installs/CI (exit 1 when unhealthy)'],
    ]),
    '',
    section(p, 'Maintenance'),
    ...cmdRows(p, [
      ['update', 'self-update the platform'],
      ['update core', 'refresh the bundled core in this install'],
      ['completion <bash|zsh|fish>', 'print a shell completion script'],
      ['--version [--json]', 'launcher, core, and runtime versions'],
    ]),
    '',
    section(p, 'Options'),
    ...cmdRows(p, [
      ['--profile <name>', 'preset from ~/.octocode/profiles.json (model+tools+approve)'],
      ['--json', 'machine-readable output for config/setup/auth/models/sessions/--version'],
    ]),
    '',
    section(p, 'Launch modes'),
    ...wrapText('SDK embed (default)   — in-process runtime session with direct API access', terminalWidth() - 2).map((l) => `  ${p.dim(l)}`),
    ...wrapText('Subprocess fallback   — spawns the runtime binary via the -e flag.', terminalWidth() - 2).map((l) => `  ${p.dim(l)}`),
    ...wrapText('Force with OCTOCODE_LAUNCHER_MODE=subprocess.', terminalWidth()).map((l) => `  ${p.dim(l)}`),
    '',
    section(p, 'Fork dev'),
    `  ${kv(p, 'OCTOCODE_PI_BIN', p.dim('absolute path to a locally-built Pi binary'))}`,
    `  ${kv(p, 'OCTOCODE_PI_PACKAGE', p.dim('npm package override (e.g. @octocodeai/pi-coding-agent)'))}`,
    '',
    section(p, 'Exit codes'),
    ...cmdRows(p, [
      ['0', 'success'],
      ['1', 'failure / unhealthy check'],
      ['2', 'usage (unknown input — with suggestion)'],
      ['3', 'needs an interactive terminal'],
    ]),
    '',
    p.dim(
      fitText(`The core (${CORE_PACKAGE}) carries the prompt, skills, tools, and memory.`, terminalWidth() - 2),
    ),
    ...wrapText('shell completions: eval "$(octocode-agent completion zsh)"', terminalWidth()).map((l) => hint(p, l)),
  ].join('\n');
}

export function configReport(env: NodeJS.ProcessEnv = process.env): string {
  const home = getOctocodeHome(env);
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const launchMode =
    env.OCTOCODE_LAUNCHER_MODE === 'subprocess'
      ? 'subprocess (forced via OCTOCODE_LAUNCHER_MODE)'
      : 'SDK embed (default)';
  const authInHome = fs.existsSync(path.join(home, 'auth.json'));
  const authInPi = fs.existsSync(path.join(piAgentDir, 'auth.json'));
  const keys = presentApiKeys(env);
  const coreSpec = resolveCoreSpec(env);
  const piInfo = resolvePiBin(env);

  const p = makePainter(colorEnabled(env));
  const envNames = [
    'OCTOCODE_HOME',
    'OCTOCODE_AGENT_DIR',
    'OCTOCODE_LAUNCHER_MODE',
    'OCTOCODE_PI_BIN',
    'OCTOCODE_PI_PACKAGE',
    'OCTOCODE_AGENT_EXTENSION_SPEC',
  ] as const;
  const setEnv = envNames.filter((n) => env[n] !== undefined);
  const envBudget = terminalWidth() - 4;
  const envRow = (name: string): string =>
    `  ${p.gray(name)}=${fitText(tildePath(String(env[name] ?? '')), envBudget - name.length - 3)}`;

  return [
    header(p, 'config'),
    '',
    section(p, 'Runtime'),
    kv(p, 'launch mode', launchMode),
    kv(p, 'octocode home', `${tildePath(home)}${authInHome ? p.dim(' (auth.json ✓)') : ''}`),
    kv(p, 'agent dir', `${tildePath(piAgentDir)}${authInPi ? p.dim(' (auth.json ✓)') : ''}`),
    '',
    section(p, 'Packages'),
    kv(
      p,
      'core',
      `${tildePath(coreSpec)} ${p.dim(readPackageVersion(CORE_PACKAGE) ?? 'not installed locally')}`,
    ),
    kv(
      p,
      'runtime',
      piInfo
        ? `${tildePath(piInfo.bin)} ${p.dim(`(${piInfo.source})`)}`
        : p.red('not found — run: octocode-agent update'),
    ),
    kv(p, 'runtime version', readPackageVersion(getEffectivePiPackage(env)) ?? 'unknown'),
    kv(p, 'launcher version', launcherVersion() ?? '?'),
    '',
    section(p, 'Keys'),
    kv(
      p,
      'api keys set',
      keys.length > 0 ? keys.join(', ') : p.red('(none detected — run: octocode-agent auth login)'),
    ),
    '',
    section(p, 'Env overrides'),
    ...(setEnv.length > 0 ? setEnv.map(envRow) : [p.dim('  none set')]),
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
      'runtime',
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
      ? wrapText('✓ All checks passed — run `octocode-agent` to start.', terminalWidth()).map((l) => p.green(l)).join('\n')
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
    ...cmdRows(
      p,
      AUTH_PROVIDERS.map((provider) => [
        provider.keyVar,
        `${provider.label} — ${link(p, provider.url, provider.host, Boolean(process.stdout.isTTY))}`,
      ]),
    ),
    ...wrapText('Or guided setup: octocode-agent auth login', terminalWidth() - 2).map((l) => `  ${p.dim(l)}`),
    '',
    section(p, 'Exit codes'),
    ...cmdRows(p, [
      ['0', 'success'],
      ['1', 'runtime failure (e.g. unhealthy doctor)'],
      ['2', 'usage / unknown input (did you mean?)'],
      ['3', 'needs an interactive terminal'],
    ]),
    '',
    section(p, '.env files (loaded at session start)'),
    `  ${kv(p, '~/.octocode/.env', p.dim('global keys'))}`,
    `  ${kv(p, '<project>/.env', p.dim('project-scoped keys (requires trust)'))}`,
    '',
    section(p, 'Persistent login (in-session)'),
    ...wrapText(`Type /login — keys are stored in ${tildePath(path.join(piAgentDir, 'auth.json'))}`, terminalWidth() - 2).map((l) => `  ${p.dim(l)}`),
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
      ? wrapText(`Currently detected: ${keys.join(', ')}`, terminalWidth()).map((l) => p.accent(l)).join('\n')
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
      ['octocode-agent models --set', 'persist your default model'],
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
    `  ${p.brand(ellipsizeEnd('--thinking off|minimal|low|medium|high|xhigh', terminalWidth() - 2))}`,
    ...wrapText('supported on claude-* and gemini-* models with reasoning=true', terminalWidth() - 2).map((l) => `  ${p.dim(l)}`),
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
      ['octocode-agent -c', 'resume THIS terminal\'s last session (breadcrumb)'],
      ['octocode-agent resume [<id>]', 'fuzzy id/name, or pick from all projects'],
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
  return spawnExitStatus(result);
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
    "    'doctor:One health pane: runtime, core, auth, awareness'",
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
    'complete -c octocode-agent -n "__fish_use_subcommand" -l version -d "Print launcher, core, and runtime versions"',
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
    doctor: 'One health pane: runtime, core, auth, awareness',
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

  // Octocode owns the agent theme. Preserve octocode-dark/light, but replace
  // plain Pi themes such as dark/light so Octocode sessions never look unbranded.
  ensureOctocodeThemeSetting(piAgentDir());

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
      : `Runtime (${effectivePkg}) is not installed. Run: octocode-agent update`;
    log(`octocode-agent: ${message}`);
    log(`octocode-agent: diagnose with: octocode-agent doctor`);
    return 1;
  }

  const spec = (deps.resolveCoreSpec ?? resolveCoreSpec)(env);
  const result = spawn(piInfo.bin, buildPiArgs(spec, argv, env), { stdio: 'inherit', env });
  return spawnExitStatus(result);
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
  const status = spawnExitStatus(result);
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
 * Resolve the model to show in the launch banner: explicit --model flag/env wins,
 * else the persisted defaultModel from ~/.pi/agent/settings.json.
 */
export function resolveLaunchModel(
  argv: string[] = [],
  piAgentDir: string = path.join(os.homedir(), '.pi', 'agent'),
): string | null {
  const eqArg = argv.find((a) => a.startsWith('--model='));
  if (eqArg) return eqArg.slice('--model='.length) || null;
  const flagIdx = argv.indexOf('--model');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(piAgentDir, 'settings.json'), 'utf8'));
    const model = settings?.defaultModel;
    return typeof model === 'string' && model ? model : null;
  } catch {
    return null;
  }
}

/**
 * Play the launch shimmer: print the purple octopus, then sweep a diagonal
 * gloss band across it (~350ms) by rewriting its lines in place, ending on the
 * resting gradient frame. Writes straight to `stream` (default stderr) so the
 * escape-code rewrites bypass any log decoration. Returns true when it ran —
 * callers then pass `skipArt` to printLaunchBanner so the art is not doubled.
 * Skipped (false) on non-TTY, CI, NO_BANNER, non-interactive flags, or when
 * color is disabled (a colorless shimmer is just flicker).
 */
export async function playOctopusShimmer(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stderr,
  frameMs = 32,
): Promise<boolean> {
  if (!stream.isTTY) return false;
  if (env.OCTOCODE_AGENT_NO_BANNER === '1') return false;
  if (env.CI) return false;
  if (argv.some((a) => NON_INTERACTIVE_FLAGS.has(a))) return false;
  const p = makePainter(colorEnabled(env, true));
  if (!p.enabled) return false;
  const height = octopusArt(p).length;
  const up = `\x1b[${height}A`;
  const writeFrame = (lines: string[], first = false): void => {
    stream.write((first ? '' : up) + lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
  };
  stream.write('\x1b[?25l');
  try {
    writeFrame(octopusFrame(p, 0, 0), true);
    const span = octopusShimmerSpan();
    let frame = 0;
    for (let phase = 2; phase <= span; phase += 2) {
      await new Promise((resolve) => setTimeout(resolve, frameMs));
      frame += 1;
      // The gloss band advances every frame; the body pose every 4th (~130ms),
      // so the tentacles visibly sway while the shine sweeps across.
      writeFrame(octopusFrame(p, phase, frame >> 2));
    }
    writeFrame(octopusArt(p));
  } finally {
    stream.write('\x1b[?25h');
  }
  return true;
}

/**
 * Print the one-line brand banner before an interactive launch.
 * TTY-stderr only; honors OCTOCODE_AGENT_NO_BANNER=1 and skips print/rpc runs.
 */
export function printLaunchBanner(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = (m) => console.error(m),
  isTTY: boolean = Boolean((process.stderr as { isTTY?: boolean }).isTTY),
  opts: { skipArt?: boolean } = {},
): boolean {
  if (!isTTY) return false;
  if (env.OCTOCODE_AGENT_NO_BANNER === '1') return false;
  if (argv.some((a) => NON_INTERACTIVE_FLAGS.has(a))) return false;
  const p = makePainter(colorEnabled(env, true));
  if (!opts.skipArt) for (const line of octopusArt(p)) log(line);
  log(
    launchBanner(p, {
      launcher: launcherVersion(),
      core: readPackageVersion(CORE_PACKAGE),
      model: resolveLaunchModel(argv),
    }),
  );
  if (presentApiKeys(env).length === 0) {
    log(p.gray('no API keys detected — run `octocode-agent auth login` to set up'));
  }
  // Versioned onboarding nudge: the setup flow changed since the user last
  // completed it — one muted refresh line, never blocking (OMP's setup-version idea).
  const state = readAgentState(getOctocodeHome(env));
  if (state.setupVersion !== undefined && state.setupVersion < AGENT_STATE_VERSION) {
    log(
      p.gray(
        `setup flow updated (v${state.setupVersion} → v${AGENT_STATE_VERSION}) — run \`octocode-agent setup --fix\` to refresh`,
      ),
    );
  }
  return true;
}

/**
 * Guided setup repair (interactive only): re-checks, then walks each failing
 * check through its fix path (wizard for keys, update for missing core).
 * Returns 0 when healthy afterwards, 1 when issues remain, 3 without a TTY.
 */
export async function runSetupFix(deps: LaunchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  if (!process.stdin.isTTY) {
    out(`${p.red('✗')} setup --fix needs an interactive terminal`);
    return 3;
  }
  const data = setupData(env);
  for (const check of data.checks) {
    if (check.ok) continue;
    if (check.name === 'api-keys') {
      await runAuthWizard({ env });
    } else if (check.name === 'core') {
      runUpdate('core', deps);
    }
  }
  out('');
  out(setupReport(env));
  const ok = setupData(env).allGood;
  if (ok) markSetupDone(getOctocodeHome(env));
  return ok ? 0 : 1;
}

/**
 * `models --set [model]` — persist the default model Pi will boot with.
 * No arg + TTY → arrow-key picker over the curated list. Writes
 * ~/.pi/agent/settings.json defaultProvider+defaultModel (Pi's own contract).
 */
export async function runModelsSet(
  modelArg: string | undefined,
  deps: LaunchDeps = {},
  piDir: string = piAgentDir(),
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  const list = modelsData().commonModels;
  let provider: string | undefined;
  let id: string | undefined;
  if (modelArg) {
    if (modelArg.includes('/')) [provider, id] = modelArg.split('/', 2);
    else {
      id = modelArg;
      provider = list.find((m) => m.id === id)?.provider;
    }
    if (!id || !provider) {
      out(`${p.red('✗')} unknown model "${modelArg}"`);
      out(hint(p, `known: ${list.map((m) => m.id).join(', ')} — or pass provider/id`));
      return 2;
    }
  } else {
    const picked = await selectOne(p, {
      title: 'default model',
      rows: list.map((m) => ({ id: `${m.provider}/${m.id}`, label: m.id, meta: m.note })),
    });
    if (!picked) {
      out(p.gray('cancelled'));
      return 0;
    }
    [provider, id] = picked.split('/', 2);
  }
  const file = setDefaultModelInSettings(piDir, provider, id);
  out(`${p.green('✓')} default model ${p.bold(p.brand(`${provider}/${id}`))}`);
  out(p.dim(`  saved → ${file}`));
  return 0;
}

/**
 * `resume` with no id: arrow-key picker over ALL projects' sessions (newest first).
 * Returns the full record — the caller passes `picked.file` to Pi's `--session`,
 * which resolves file paths natively (incl. cross-project re-root).
 */
export async function runResumePicker(
  deps: LaunchDeps = {},
  sessionsRoot: string = path.join(piAgentDir(), 'sessions'),
): Promise<SessionFile | null> {
  const env = deps.env ?? process.env;
  const p = makePainter(colorEnabled(env));
  const sessions = listSessions(sessionsRoot);
  if (sessions.length === 0) return null;
  const picked = await selectOne(p, {
    title: 'resume session',
    rows: sessions.map((s) => ({
      id: s.file,
      label: `${s.uuid.slice(0, 8)}…  ${p.dim(tildePath(s.cwd ?? '?'))}`,
      meta: formatAge(Date.now() - s.mtimeMs),
    })),
  });
  return sessions.find((s) => s.file === picked) ?? null;
}

/**
 * Per-terminal breadcrumbs (P0-3): rewrite a bare `-c`/`--continue` into
 * `--session <file>` for THIS terminal's last session. Pi's own -c continues
 * the cwd-global newest — wrong in multiplexed terminals (tabs/tmux panes).
 */
export function rewriteContinueFlag(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = getOctocodeHome(env),
): string[] {
  const idx = argv.findIndex((a) => a === '-c' || a === '--continue');
  if (idx === -1) return argv;
  const term = terminalId(env);
  if (!term) return argv;
  const crumb = readBreadcrumb(home, term);
  if (!crumb) return argv;
  const out = [...argv];
  out.splice(idx, 1, '--session', crumb.sessionFile);
  return out;
}

/**
 * After a launch finishes, remember THIS terminal's session: prefer the newest
 * session for the current project; fall back to the global newest (the resume
 * may have re-rooted into another project).
 */
export function recordTerminalBreadcrumb(env: NodeJS.ProcessEnv = process.env): void {
  const term = terminalId(env);
  if (!term) return;
  const session = newestProjectSession(process.cwd()) ?? listSessions()[0] ?? null;
  if (!session) return;
  writeBreadcrumb(getOctocodeHome(env), term, { sessionFile: session.file, cwd: session.cwd });
}

// ── config get | set | list (P0-2) ─────────────────────────────────────────────

/** `config get <key>` — read one key from Pi's settings.json. */
export function runConfigGet(
  key: string | undefined,
  deps: LaunchDeps = {},
  json = false,
  piDir: string = piAgentDir(),
): number {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  if (!key) {
    out(`${p.red('✗')} usage: octocode-agent config get <key>`);
    return 2;
  }
  const value = getSetting(piDir, key);
  if (value === undefined) {
    out(`${p.red('✗')} unknown key "${key}"`);
    out(hint(p, `writable keys: defaultProvider, defaultModel`));
    return 2;
  }
  out(json ? JSON.stringify({ key, value }, null, 2) : String(value));
  return 0;
}

/** `config set <key> <value>` — allowlisted writes into Pi's settings.json. */
export function runConfigSet(
  key: string | undefined,
  value: string | undefined,
  deps: LaunchDeps = {},
  piDir: string = piAgentDir(),
): number {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  if (!key || value === undefined) {
    out(`${p.red('✗')} usage: octocode-agent config set <key> <value>`);
    out(hint(p, `writable keys: defaultProvider, defaultModel`));
    return 2;
  }
  if (!isAllowedConfigKey(key)) {
    out(`${p.red('✗')} cannot write "${key}"`);
    out(hint(p, `writable keys: defaultProvider, defaultModel (runtime settings contract)`));
    return 2;
  }
  const file = setSetting(piDir, key, value);
  out(`${p.green('✓')} ${key} = ${value}`);
  out(p.dim(`  saved → ${file}`));
  return 0;
}

/** `config list` — dump Pi's settings.json (sorted keys). */
export function runConfigList(
  deps: LaunchDeps = {},
  json = false,
  piDir: string = piAgentDir(),
): number {
  const env = deps.env ?? process.env;
  const out = deps.out ?? console.log;
  const p = makePainter(colorEnabled(env));
  const settings = listSettings(piDir);
  if (json) {
    out(JSON.stringify(settings, null, 2));
    return 0;
  }
  const keys = Object.keys(settings).sort();
  if (keys.length === 0) {
    out(p.gray('settings.json is empty — nothing set yet'));
    return 0;
  }
  out(header(p, 'settings.json'));
  for (const k of keys) {
    const v = settings[k];
    out(kv(p, k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  return 0;
}

/** `--smoke-test` — self-check for installs/CI: launcher + core + Pi host resolve. */
export function runSmokeTest(deps: LaunchDeps = {}): number {
  const out = deps.out ?? console.log;
  const env = deps.env ?? process.env;
  const p = makePainter(colorEnabled(env));
  const launcher = launcherVersion();
  const core = readPackageVersion(CORE_PACKAGE);
  const pi = env.OCTOCODE_PI_BIN ?? readPackageVersion(getEffectivePiPackage(env));
  const ok = Boolean(launcher && core && pi);
  out(
    ok
      ? `smoke-test: ok ${p.dim(`(launcher ${launcher} · core ${core} · runtime ${pi})`)}`
      : `smoke-test: FAIL ${p.dim('run: octocode-agent doctor')}`,
  );
  return ok ? 0 : 1;
}

/** Small relative-age formatter (looking at sessions mtimes). */
export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const COMMAND_VERBS = [
  'help', 'config', 'doctor', 'setup', 'auth', 'models', 'sessions',
  'update', 'resume', 'session', 'run', 'serve', 'completion', 'version',
];

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/**
 * Near-verb guard: `octocode-agent confg` should never silently boot a session
 * with the prompt "confg". Fires only for a single bare token (real prompts
 * are quoted multi-word strings) within edit distance ≤ 2 of a real verb.
 */
export function suggestCommand(token: string | undefined): string | null {
  if (!token || token.includes('-') || token.includes(' ') || token.includes('"')) return null;
  const t = token.toLowerCase();
  if (COMMAND_VERBS.includes(t)) return null;
  let best: string | null = null;
  let bestD = 3;
  for (const verb of COMMAND_VERBS) {
    const d = editDistance(t, verb);
    if (d > 0 && d < bestD) {
      best = verb;
      bestD = d;
    }
  }
  return best;
}

export async function main(argv: string[] = [], deps: LaunchDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const env = deps.env ?? process.env;
  const { command, target, shell, json, rest, args, profile } = parseInvocation(argv);

  // Brand the process for `ps`/`top` (OMP does setProcessName; Node is free).
  try {
    process.title = 'octocode-agent';
  } catch {
    /* non-critical */
  }

  switch (command) {
    case 'version':
      out(json ? JSON.stringify(versionData(env), null, 2) : versionReport(env));
      return 0;
    case 'help':
      out(helpReport(env));
      return 0;
    case 'smoke':
      return runSmokeTest(deps);
    case 'config': {
      const sub = (args ?? [])[0];
      if (sub === 'get') return runConfigGet(args?.[1], deps, json);
      if (sub === 'set') return runConfigSet(args?.[1], args?.[2], deps);
      if (sub === 'list') return runConfigList(deps, json);
      out(json ? JSON.stringify(configData(env), null, 2) : configReport(env));
      return 0;
    }
    case 'setup': {
      if ((args ?? []).includes('--fix')) return runSetupFix(deps);
      out(json ? JSON.stringify(setupData(env), null, 2) : setupReport(env));
      return 0;
    }
    case 'auth': {
      const sub = args?.[0];
      if (sub === 'login') return runAuthWizard({ env });
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
    case 'models': {
      const r = args ?? rest ?? [];
      const setIdx = r.indexOf('--set');
      if (setIdx !== -1) return runModelsSet(r[setIdx + 1], deps);
      out(json ? JSON.stringify(modelsData(), null, 2) : modelsReport(env));
      return 0;
    }
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
    case 'serve': {
      const serve = parseServeArgs(rest ?? []);
      if (serve.mode === 'raw-rpc') return launchAgent(['--mode', 'rpc', ...serve.rpcArgs], deps);
      const runServe = deps.runServeStdio ?? ((argv, d) => defaultRunServeStdio({ argv, env: d.env }));
      return runServe(rest ?? [], deps);
    }
    case 'resume': {
      const r = rest ?? [];
      const id = r[0] && !r[0].startsWith('-') ? r[0] : undefined;
      if (!id && process.stdin.isTTY && process.stdout.isTTY) {
        const picked = await runResumePicker(deps);
        if (picked) {
          const term = terminalId(env);
          if (term)
            writeBreadcrumb(getOctocodeHome(env), term, {
              sessionFile: picked.file,
              cwd: picked.cwd,
            });
          return launchAgent(['--session', picked.file], deps);
        }
        const shimmered = await playOctopusShimmer(r, env);
        printLaunchBanner(r, env, deps.log, undefined, { skipArt: shimmered });
      }
      // Fuzzy/global/re-root resolution of `id` is Pi's (main.js resolveSessionPath).
      const rc = await launchAgent(id ? ['--session', id, ...r.slice(1)] : ['-r', ...r], deps);
      recordTerminalBreadcrumb(env);
      return rc;
    }
    case 'launch':
    default: {
      const suggestion = suggestCommand(argv.length <= 2 ? argv[0] : undefined);
      if (suggestion) {
        const p = makePainter(colorEnabled(env));
        out(`${p.red('✗')} unknown command "${argv[0]}"`);
        out(hint(p, `did you mean: octocode-agent ${suggestion}`));
        return 2;
      }
      const shimmered = await playOctopusShimmer(rest ?? [], env);
      printLaunchBanner(rest ?? [], env, deps.log, undefined, { skipArt: shimmered });
      const rc = await launchAgent(
        applyProfile(rewriteContinueFlag(rest ?? [], env), profile, env),
        deps,
      );
      recordTerminalBreadcrumb(env);
      return rc;
    }
  }
}
