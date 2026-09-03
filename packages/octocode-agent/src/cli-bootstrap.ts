import { spawnSync } from "node:child_process";
import { constants } from "node:os";

import { parseInvocation } from "./launcher.js";

interface SpawnResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: "inherit"; readonly env: NodeJS.ProcessEnv },
) => SpawnResult;

type Execve = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => void;

export interface InteractiveFfiBootstrapOptions {
  readonly entrypoint: string;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly execve?: Execve | null;
  readonly spawn?: Spawn;
}

export function hasExperimentalFfi(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions?: string,
): boolean {
  return (
    execArgv.includes("--experimental-ffi") ||
    /(?:^|\s)--experimental-ffi(?=\s|$)/u.test(nodeOptions ?? "")
  );
}

export function requiresInteractiveFfi(argv: readonly string[]): boolean {
  const invocation = parseInvocation(argv);
  if (
    invocation.command !== "launch" &&
    invocation.command !== "resume" &&
    invocation.command !== "session"
  ) {
    return false;
  }
  const boundary = invocation.args.indexOf("--");
  const options = invocation.args.slice(
    0,
    boundary === -1 ? invocation.args.length : boundary,
  );
  if (options.some((value) => value === "--help" || value === "-h"))
    return false;
  if (options.some((value) => value === "--print" || value === "-p"))
    return false;
  const modeIndex = options.indexOf("--mode");
  return modeIndex === -1;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

export async function runWithInteractiveFfi(
  argv: readonly string[],
  run: () => Promise<number>,
  options: InteractiveFfiBootstrapOptions,
): Promise<number> {
  const execArgv = options.execArgv ?? process.execArgv;
  const env = options.env ?? process.env;
  if (
    !requiresInteractiveFfi(argv) ||
    hasExperimentalFfi(execArgv, env.NODE_OPTIONS)
  ) {
    return run();
  }

  const execPath = options.execPath ?? process.execPath;
  const childArgs = [
    ...execArgv,
    "--experimental-ffi",
    "--disable-warning=ExperimentalWarning",
    options.entrypoint,
    ...argv,
  ];
  const execve =
    options.execve === undefined ? process.execve?.bind(process) : options.execve;
  if (execve) {
    execve(execPath, [execPath, ...childArgs], env);
    return 0;
  }

  const result = (options.spawn ?? (spawnSync as Spawn))(
    execPath,
    childArgs,
    { stdio: "inherit", env },
  );
  if (result.error) throw result.error;
  return result.status ?? signalExitCode(result.signal);
}
