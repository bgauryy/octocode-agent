/**
 * sdk-launcher.ts — in-process Pi SDK embed for octocode-agent.
 *
 * Replaces the subprocess spawnSync path with a fully in-process Pi session that
 * loads @octocodeai/pi-extension via extensionFactories rather than a file-based
 * `-e` flag. Improvements over the subprocess path:
 *   - Direct Pi API: InteractiveMode, runPrintMode, runRpcMode
 *   - SettingsManager.applyOverrides for octocode-specific defaults
 *   - In-process startup errors surface cleanly (no raw subprocess stderr)
 *   - Auth credential backup to ~/.octocode on first SDK run
 *   - Proper --continue, --no-session, --name, --session flag handling
 *
 * Bundling note:
 *   @octocodeai/pi-extension is imported dynamically (importExtensionFactory).
 *   In workspace (dev): resolved via workspace:* link.
 *   In production: resolved from the installed npm dep shipped alongside octocode-agent.
 *   The dynamic import means no bundling of pi-extension into this package — it is
 *   always loaded from its own installation path at runtime.
 *
 * Returns `null` when the Pi SDK or the extension factory are unavailable so
 * the caller (launcher.ts) can fall back to the subprocess path.
 *
 * THIS MODULE HAS NO SIDE EFFECTS AT IMPORT TIME (safe to unit-test).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getOctocodeHome } from './utils.js';
import type { ParsedSdkArgs, SdkDeps, PiSdkModule, ExtensionFactory } from './types.js';

// Re-export so callers that previously imported resolveOctocodeHome from this
// module keep working (e.g. downstream code, tests).
export { getOctocodeHome as resolveOctocodeHome };

// ── Auth migration ─────────────────────────────────────────────────────────────

/**
 * Copy auth.json from Pi's default agent dir to the Octocode home as a backup,
 * only when the destination doesn't already exist. Silent: errors never block startup.
 *
 * @param home      - destination directory (auth.json written here)
 * @param log       - optional logger for the migration message
 * @param srcPath   - override source path; default: ~/.pi/agent/auth.json
 */
export function migrateAuthIfNeeded(
  home: string,
  log?: (msg: string) => void,
  srcPath?: string,
): boolean {
  const dest = path.join(home, 'auth.json');
  if (fs.existsSync(dest)) return false;

  const src = srcPath ?? path.join(os.homedir(), '.pi', 'agent', 'auth.json');
  if (!fs.existsSync(src)) return false;

  try {
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(src, dest);
    log?.(`octocode-agent: backed up auth credentials to ${dest}`);
    return true;
  } catch {
    return false;
  }
}

// ── Arg parser ─────────────────────────────────────────────────────────────────

/**
 * Parse CLI argv for SDK-layer flags.
 * Unrecognized flags and positional args land in `rest[]`.
 */
export function parseSdkArgs(argv: string[] = []): ParsedSdkArgs {
  const result: ParsedSdkArgs = {
    mode: 'interactive',
    outputFormat: 'text',
    continue: false,
    noSession: false,
    name: undefined,
    sessionPath: undefined,
    initialMessage: undefined,
    rest: [],
  };

  // -p/--print and --mode are resolved independently while parsing (mirroring
  // upstream pi's own resolveAppMode/toPrintOutputMode contract), then combined
  // once at the end. Treating them as the same field let `--mode json` silently
  // overwrite an earlier `-p`, dropping the print request and falling through to
  // full interactive mode — which blocks on stdin and never exits when the
  // caller has no real terminal attached (e.g. `-p --mode json "prompt"`).
  let printFlag = false;
  let explicitMode: 'text' | 'json' | 'rpc' | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '-p':
      case '--print':
        printFlag = true;
        i++;
        break;
      case '--mode':
        if (i + 1 < argv.length) {
          const m = argv[i + 1]!;
          if (m === 'rpc' || m === 'json' || m === 'text') {
            explicitMode = m;
            i += 2;
            break;
          }
        }
        result.rest.push(arg);
        i++;
        break;
      case '-c':
      case '--continue':
        result.continue = true;
        i++;
        break;
      case '--no-session':
        result.noSession = true;
        i++;
        break;
      case '--name':
      case '-n':
        if (i + 1 < argv.length) result.name = argv[++i];
        i++;
        break;
      case '--session':
        if (i + 1 < argv.length) result.sessionPath = argv[++i];
        i++;
        break;
      default:
        // First bare non-flag arg becomes the initial prompt, unless something
        // already seen forces a non-interactive mode (print-mode reconstructs
        // the message from `rest` regardless, so this is a best-effort capture).
        if (!arg.startsWith('-') && result.initialMessage == null && !printFlag && explicitMode === undefined) {
          result.initialMessage = arg;
        } else {
          result.rest.push(arg);
        }
        i++;
    }
  }

  // Resolve run mode + output format together, matching upstream pi's
  // resolveAppMode: --mode rpc always wins; --mode json forces print+json
  // even without -p; -p forces print+text; otherwise interactive.
  if (explicitMode === 'json') result.outputFormat = 'json';
  if (explicitMode === 'rpc') {
    result.mode = 'rpc';
  } else if (explicitMode === 'json' || printFlag) {
    result.mode = 'print';
  }

  return result;
}

// ── Import helpers (injectable for tests) ──────────────────────────────────────

/**
 * Dynamically import the Pi SDK.
 * Returns the module object, or null if the package is not installed.
 */
export async function importPiSdk(): Promise<PiSdkModule | null> {
  try {
    return (await import('@earendil-works/pi-coding-agent')) as PiSdkModule;
  } catch {
    return null;
  }
}

/**
 * Dynamically import `createOctocodePiExtension` from the core extension package.
 *
 * Production: resolves from the installed @octocodeai/pi-extension npm dep.
 * Workspace: resolves from the workspace:* symlink (local dev).
 *
 * Returns the factory function, or null if unavailable.
 */
export async function importExtensionFactory(): Promise<ExtensionFactory | null> {
  try {
    const mod = (await import('@octocodeai/pi-extension')) as {
      createOctocodePiExtension?: ExtensionFactory;
    };
    return mod.createOctocodePiExtension ?? null;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

/**
 * Launch Pi using the in-process SDK (no subprocess).
 *
 * All `deps` are optional; defaults work for production use.
 * Inject mocks in tests to avoid real Pi/SDK imports.
 *
 * @returns
 *   - number: process exit code (0 = success, ≥1 = error)
 *   - null: SDK unavailable — caller should fall back to subprocess
 */
export async function launchWithSdk(
  argv: string[] = [],
  deps: SdkDeps = {},
): Promise<number | null> {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const home = (deps.resolveHome ?? getOctocodeHome)(env);

  // Mirror PI_CACHE_RETENTION into process.env — the in-process Pi SDK reads it directly.
  if (env.PI_CACHE_RETENTION && !process.env.PI_CACHE_RETENTION) {
    process.env.PI_CACHE_RETENTION = env.PI_CACHE_RETENTION;
  }

  const sdk = await (deps.importPiSdk ?? importPiSdk)();
  if (!sdk) {
    log('octocode-agent: Pi SDK not available; using subprocess mode');
    return null;
  }

  const createExtension = await (deps.importExtensionFactory ?? importExtensionFactory)();
  if (!createExtension) {
    log('octocode-agent: Octocode extension factory not available; using subprocess mode');
    return null;
  }

  const {
    createAgentSessionRuntime,
    createAgentSessionFromServices,
    createAgentSessionServices,
    getAgentDir,
    InteractiveMode,
    runPrintMode,
    runRpcMode,
    SessionManager,
    SettingsManager,
  } = sdk as Record<string, unknown>;

  // Ensure home dir exists; back up auth credentials if this is the first SDK run
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch {
    /* non-critical */
  }
  migrateAuthIfNeeded(home, log);

  const parsed = parseSdkArgs(argv);
  const cwd = process.cwd();

  const agentDir =
    typeof getAgentDir === 'function'
      ? (getAgentDir as () => string)()
      : path.join(os.homedir(), '.pi', 'agent');

  // Settings: read from Pi's default dir, then apply octocode-specific defaults
  let settingsManager: unknown;
  try {
    const SM = SettingsManager as {
      create: (cwd: string, agentDir: string) => { applyOverrides?: (o: unknown) => void };
    };
    settingsManager = SM.create(cwd, agentDir);
    (settingsManager as { applyOverrides?: (o: unknown) => void }).applyOverrides?.({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    });
  } catch {
    settingsManager = undefined; // non-critical; DefaultResourceLoader handles it
  }

  // Session manager
  let sessionManager: unknown;
  try {
    const SM = SessionManager as Record<string, ((arg: string) => unknown) | undefined>;
    if (parsed.noSession) {
      sessionManager = SM['inMemory']?.(cwd) ?? (SM['create'] as (c: string) => unknown)(cwd);
    } else if (parsed.continue) {
      sessionManager =
        SM['continueRecent']?.(cwd) ?? (SM['create'] as (c: string) => unknown)(cwd);
    } else if (parsed.sessionPath) {
      sessionManager =
        SM['open']?.(parsed.sessionPath) ?? (SM['create'] as (c: string) => unknown)(cwd);
    } else {
      sessionManager = (SM['create'] as (c: string) => unknown)(cwd);
    }
  } catch {
    sessionManager = (SessionManager as Record<string, (c: string) => unknown>)['create']!(cwd);
  }

  // Build runtime factory — loads extension in-process via Pi service resource loading.
  const extensionFactory = createExtension({ promptMode: 'octocode-first' });

  const createRuntime = async ({
    cwd: rCwd,
    sessionManager: sm,
    sessionStartEvent,
  }: {
    cwd: string;
    sessionManager: unknown;
    sessionStartEvent: unknown;
  }) => {
    const serviceOptions: Record<string, unknown> = {
      cwd: rCwd,
      agentDir,
      resourceLoaderOptions: {
        // Match the subprocess path's `--no-extensions` (buildPiArgs): load ONLY
        // the inline Octocode extension factory, never auto-discovered package
        // extensions. Without this, a pi-package `@octocodeai/pi-extension`
        // configured in settings (or installed via `pi install`) is discovered AND
        // loaded here too, re-registering every tool/flag and emitting "Extension
        // issues" collisions. `noExtensions` drops discovery; `extensionFactories`
        // keeps the inline harness.
        noExtensions: true,
        extensionFactories: [extensionFactory],
      },
    };
    if (settingsManager) serviceOptions['settingsManager'] = settingsManager;
    const services = await (
      createAgentSessionServices as (opts: Record<string, unknown>) => Promise<unknown>
    )(serviceOptions);
    return {
      ...((await (
        createAgentSessionFromServices as (opts: {
          services: unknown;
          sessionManager: unknown;
          sessionStartEvent: unknown;
        }) => Promise<unknown>
      )({ services, sessionManager: sm, sessionStartEvent })) as object),
      services,
      diagnostics: (services as Record<string, unknown>)['diagnostics'],
    };
  };

  let runtime: unknown;
  try {
    runtime = await (
      createAgentSessionRuntime as (
        factory: typeof createRuntime,
        opts: { cwd: string; agentDir: string; sessionManager: unknown },
      ) => Promise<unknown>
    )(createRuntime, { cwd, agentDir, sessionManager });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`octocode-agent: SDK runtime init failed (${msg}); falling back to subprocess`);
    return null;
  }

  try {
    if (parsed.mode === 'rpc') {
      await (runRpcMode as (r: unknown) => Promise<void>)(runtime);
      return 0;
    }

    if (parsed.mode === 'print') {
      const parts = [parsed.initialMessage, ...parsed.rest.filter((a) => !a.startsWith('-'))].filter(
        Boolean,
      );
      const msg = parts.join(' ').trim() || undefined;
      await (
        runPrintMode as (
          r: unknown,
          opts: { mode: string; initialMessage?: string; initialImages: unknown[]; messages: unknown[] },
        ) => Promise<void>
      )(runtime, { mode: parsed.outputFormat, initialMessage: msg, initialImages: [], messages: [] });
      return 0;
    }

    // Interactive mode (default)
    const IM = InteractiveMode as new (
      r: unknown,
      opts: {
        migratedProviders: unknown[];
        modelFallbackMessage: unknown;
        initialMessage?: string;
        initialImages: unknown[];
        initialMessages: unknown[];
      },
    ) => { run: () => Promise<void> };

    const imode = new IM(runtime, {
      migratedProviders: [],
      modelFallbackMessage: (runtime as Record<string, unknown>)['modelFallbackMessage'],
      initialMessage: parsed.initialMessage,
      initialImages: [],
      initialMessages: [],
    });
    await imode.run();
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`octocode-agent: session error: ${msg}`);
    return 1;
  }
}
