import type { Readable, Writable } from 'node:stream';
import type { AgentRuntime } from '@octocodeai/agent-core';
import type { ParsedNativeArgs } from './native-launcher.js';
import type { OpenTuiTerminal } from './terminal/opentui/presentation.js';

export interface SpawnResult { status: number | null; error?: Error; }
export type SpawnFn = (command: string, args?: ReadonlyArray<string>, options?: { stdio?: string; env?: NodeJS.ProcessEnv }) => SpawnResult;
export interface LaunchDeps {
  out?: (message: string) => void;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  spawn?: SpawnFn;
  createRuntime?: (options: { env: NodeJS.ProcessEnv; cwd: string; args: ParsedNativeArgs }) => Promise<AgentRuntime>;
  createTerminal?: () => OpenTuiTerminal;
}
