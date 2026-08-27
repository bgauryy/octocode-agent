/**
 * Shared type definitions for octocode-agent launcher.
 * No runtime imports — purely declaration.
 */

export interface PiBinInfo {
  bin: string;
  pkgRoot: string;
  source: 'env-bin' | 'env-package' | 'bundled';
}

/** Minimal spawn return shape (subset of SpawnSyncReturns). */
export interface SpawnResult {
  status: number | null;
  error?: Error;
}

export type SpawnFn = (
  command: string,
  args?: ReadonlyArray<string>,
  options?: { stdio?: string; env?: NodeJS.ProcessEnv },
) => SpawnResult;

export type Command =
  | 'version'
  | 'help'
  | 'smoke'
  | 'config'
  | 'setup'
  | 'auth'
  | 'models'
  | 'sessions'
  | 'update'
  | 'completion'
  | 'doctor'
  | 'run'
  | 'serve'
  | 'resume'
  | 'memory'
  | 'awareness'
  | 'tools'
  | 'skills'
  | 'launch';

export interface ParsedInvocation {
  command: Command;
  target?: 'core' | 'platform';
  /** Shell name for `completion <shell>`. */
  shell?: string;
  /** Whether --json was passed (report commands only). */
  json?: boolean;
  args?: string[];
  rest?: string[];
  /** Value of --profile <name>, if present (launch/run only). */
  profile?: string;
}

export interface UpdateCommandResult {
  cmd: string;
  args: string[];
}

// ── SDK deps ──────────────────────────────────────────────────────────────────

/** Minimal typed surface of the Pi SDK module (rest is unknown). */
export type PiSdkModule = Record<string, unknown>;

/** Factory function returned by importExtensionFactory. */
export type ExtensionFactory = (opts?: Record<string, unknown>) => unknown;

export type OctocodeShellFactory = (
  runtime: unknown,
  deps?: { version?: string },
) => { run: () => Promise<number> } | Promise<{ run: () => Promise<number> }>;

export interface SdkDeps {
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  importPiSdk?: () => Promise<PiSdkModule | null>;
  importExtensionFactory?: () => Promise<ExtensionFactory | null>;
  resolveHome?: (env: NodeJS.ProcessEnv) => string;
  /** OCTOCODE_SHELL=1 shell factory. Defaults to the core shell export; inject to test. */
  createOctocodeShell?: OctocodeShellFactory;
}

// ── Launch deps ───────────────────────────────────────────────────────────────

export interface LaunchDeps extends SdkDeps {
  out?: (msg: string) => void;
  spawn?: SpawnFn;
  launchWithSdk?: (argv: string[], deps: SdkDeps) => Promise<number | null>;
  runServeStdio?: (argv: string[], deps: LaunchDeps) => Promise<number>;
  resolvePiBin?: (env: NodeJS.ProcessEnv) => PiBinInfo | null;
  resolveCoreSpec?: (env: NodeJS.ProcessEnv) => string;
  /** Prefix dir used by updateCommand for 'core' target. */
  prefix?: string;
}

// ── SDK arg parser ─────────────────────────────────────────────────────────────

export interface ParsedSdkArgs {
  mode: 'interactive' | 'print' | 'rpc';
  /** Output format for print mode (ignored for 'interactive'/'rpc'). Mirrors upstream pi's --mode text|json. */
  outputFormat: 'text' | 'json';
  continue: boolean;
  noSession: boolean;
  name?: string;
  sessionPath?: string;
  initialMessage?: string;
  rest: string[];
}
