import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn as spawnChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { RuntimeFailure } from '@octocodeai/agent-core';

export type NativeProcessContainmentSignal = 'SIGTERM' | 'SIGKILL';

export interface NativeProcessContainmentIdentity {
  readonly schemaVersion: 1;
  readonly kind: 'posix-process-group';
  readonly pid: number;
  readonly processGroupId: number;
  readonly generation: string;
  readonly startToken: string;
  readonly commandSha256: string;
  readonly ownershipTokenSha256: string;
  readonly verification: 'linux-proc' | 'darwin-ps';
}

export interface NativeProcessContainmentReport {
  readonly identity: NativeProcessContainmentIdentity;
  readonly state: 'running' | 'exited' | 'identity-replaced';
  readonly members: readonly number[];
}

export interface NativeProcessContainmentSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly ownershipToken: string;
  readonly generation: string;
  readonly bootstrap?: Uint8Array;
}

export interface NativeProcessContainmentHandle {
  readonly pid: number;
  readonly identity: NativeProcessContainmentIdentity;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  write(line: string): Promise<void>;
  endInput(): Promise<void>;
}

export interface NativeProcessContainmentPort {
  readonly supported: boolean;
  spawn(spec: NativeProcessContainmentSpawnSpec): NativeProcessContainmentHandle;
  probe(identity: NativeProcessContainmentIdentity): NativeProcessContainmentIdentity | undefined;
  report(identity: NativeProcessContainmentIdentity): NativeProcessContainmentReport;
  enumerate(identity: NativeProcessContainmentIdentity): readonly number[];
  signal(identity: NativeProcessContainmentIdentity, signal: NativeProcessContainmentSignal): void;
  wait(
    identity: NativeProcessContainmentIdentity,
    options: { readonly timeoutMs: number; readonly pollMs: number },
  ): Promise<NativeProcessContainmentReport>;
}

export interface NodeNativeProcessContainmentOptions {
  readonly platform?: NodeJS.Platform;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function safeGeneration(value: string): string {
  const generation = value.trim();
  if (!generation || generation.length > 512 || generation.includes('\0')) {
    throw new RuntimeFailure('validation', 'Native process containment generation is invalid');
  }
  return generation;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      return close >= 0 && stat.slice(close + 2).trim().split(/\s+/)[0] !== 'Z';
    }
    if (process.platform === 'darwin') {
      return !execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
    }
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function linuxIdentity(
  pid: number,
  ownershipToken: string,
  generation: string,
  tokenIsDigest = false,
): NativeProcessContainmentIdentity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const startToken = fields[19];
    const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
    const environ = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    const token = environ.find((value) => value.startsWith('OCTOCODE_WORKER_OWNERSHIP_TOKEN='))
      ?.slice('OCTOCODE_WORKER_OWNERSHIP_TOKEN='.length);
    const processGeneration = environ.find((value) => value.startsWith('OCTOCODE_WORKER_CONTAINMENT_GENERATION='))
      ?.slice('OCTOCODE_WORKER_CONTAINMENT_GENERATION='.length);
    if (!startToken || !command || !token || !processGeneration || !Number.isSafeInteger(processGroupId) || processGroupId < 1) return undefined;
    const expectedTokenDigest = tokenIsDigest ? ownershipToken : sha256(ownershipToken);
    if (sha256(token) !== expectedTokenDigest || processGeneration !== generation) return undefined;
    return {
      schemaVersion: 1,
      kind: 'posix-process-group',
      pid,
      processGroupId,
      generation,
      startToken,
      commandSha256: sha256(command),
      ownershipTokenSha256: expectedTokenDigest,
      verification: 'linux-proc',
    };
  } catch {
    return undefined;
  }
}

function darwinIdentity(
  pid: number,
  ownershipToken: string,
  generation: string,
  tokenIsDigest = false,
): NativeProcessContainmentIdentity | undefined {
  try {
    const output = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8' }).trim();
    const match = /^(.{24})\s+(\d+)\s+(.+)$/.exec(output);
    if (!match) return undefined;
    return {
      schemaVersion: 1,
      kind: 'posix-process-group',
      pid,
      processGroupId: Number(match[2]),
      generation,
      startToken: match[1]!,
      commandSha256: sha256(match[3]!),
      ownershipTokenSha256: tokenIsDigest ? ownershipToken : sha256(ownershipToken),
      verification: 'darwin-ps',
    };
  } catch {
    return undefined;
  }
}

export function captureNativeProcessContainment(
  pid: number,
  ownershipToken: string,
  generation: string,
  platform: NodeJS.Platform = process.platform,
): NativeProcessContainmentIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || !ownershipToken) return undefined;
  const safe = safeGeneration(generation);
  if (platform === 'linux') return linuxIdentity(pid, ownershipToken, safe);
  if (platform === 'darwin') return darwinIdentity(pid, ownershipToken, safe);
  return undefined;
}

export function probeNativeProcessContainment(
  identity: NativeProcessContainmentIdentity,
): NativeProcessContainmentIdentity | undefined {
  if (identity.verification === 'linux-proc') {
    return linuxIdentity(identity.pid, identity.ownershipTokenSha256, identity.generation, true);
  }
  if (identity.verification === 'darwin-ps') {
    return darwinIdentity(identity.pid, identity.ownershipTokenSha256, identity.generation, true);
  }
  return undefined;
}

export function sameNativeProcessContainment(
  left: NativeProcessContainmentIdentity,
  right: NativeProcessContainmentIdentity,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.pid === right.pid
    && left.processGroupId === right.processGroupId
    && left.generation === right.generation
    && left.startToken === right.startToken
    && left.commandSha256 === right.commandSha256
    && left.ownershipTokenSha256 === right.ownershipTokenSha256
    && left.verification === right.verification;
}

function groupMembers(processGroupId: number): readonly number[] {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
    const members = output.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!match || Number(match[2]) !== processGroupId || match[3]!.startsWith('Z')) return [];
      return [Number(match[1])];
    });
    return Object.freeze(members.sort((left, right) => left - right));
  } catch {
    return Object.freeze([]);
  }
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createNodeNativeProcessContainmentPort(
  options: NodeNativeProcessContainmentOptions = {},
): NativeProcessContainmentPort {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin' || platform === 'linux';
  const requireSupported = (): void => {
    if (!supported) {
      throw new RuntimeFailure('unsupported-capability', `Native process containment is not supported on ${platform}`);
    }
  };
  const port: NativeProcessContainmentPort = {
    supported,
    spawn(spec) {
      requireSupported();
      const generation = safeGeneration(spec.generation);
      const child = spawnChildProcess(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: {
          ...spec.env,
          OCTOCODE_WORKER_OWNERSHIP_TOKEN: spec.ownershipToken,
          OCTOCODE_WORKER_CONTAINMENT_GENERATION: generation,
        },
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      const bootstrap = child.stdio[3] as Writable | null;
      if (child.pid === undefined || bootstrap === null || typeof bootstrap.write !== 'function') {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The failed launch may already be gone. */ }
        }
        throw new RuntimeFailure('adapter-compatibility', 'Native worker containment bootstrap is unavailable');
      }
      const identity = captureNativeProcessContainment(child.pid, spec.ownershipToken, generation, platform);
      if (identity === undefined || identity.processGroupId !== child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The failed launch may already be gone. */ }
        throw new RuntimeFailure('unsupported-capability', 'Native worker containment identity cannot be verified');
      }
      bootstrap.on('error', () => undefined);
      bootstrap.end(Buffer.from(spec.bootstrap ?? []));
      const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      return Object.freeze({
        pid: child.pid,
        identity,
        stdout: child.stdout as Readable,
        stderr: child.stderr as Readable,
        exit,
        async write(line: string): Promise<void> {
          if (child.stdin === null || child.stdin.destroyed || !child.stdin.writable) {
            throw new RuntimeFailure('adapter-compatibility', 'Native worker stdin is unavailable');
          }
          if (!child.stdin.write(line, 'utf8')) await once(child.stdin, 'drain');
        },
        async endInput(): Promise<void> {
          if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) return;
          await new Promise<void>((resolve, reject) => {
            child.stdin!.end((error?: Error | null) => error ? reject(error) : resolve());
          });
        },
      });
    },
    probe(identity) {
      requireSupported();
      return probeNativeProcessContainment(identity);
    },
    report(identity) {
      requireSupported();
      const current = probeNativeProcessContainment(identity);
      if (current === undefined) {
        const members = groupMembers(identity.processGroupId);
        return Object.freeze({
          identity,
          state: processAlive(identity.pid) || members.length > 0 ? 'identity-replaced' : 'exited',
          members,
        });
      }
      if (!sameNativeProcessContainment(identity, current)) {
        return Object.freeze({ identity, state: 'identity-replaced', members: groupMembers(identity.processGroupId) });
      }
      const members = groupMembers(identity.processGroupId);
      return Object.freeze({ identity, state: members.length === 0 ? 'exited' : 'running', members });
    },
    enumerate(identity) {
      requireSupported();
      const current = probeNativeProcessContainment(identity);
      if (current === undefined) {
        if (processAlive(identity.pid)) throw new RuntimeFailure('conflict', 'Native process containment identity no longer matches its leader');
        return Object.freeze([]);
      }
      if (!sameNativeProcessContainment(identity, current)) {
        throw new RuntimeFailure('conflict', 'Native process containment generation or identity is stale');
      }
      return groupMembers(identity.processGroupId);
    },
    signal(identity, signal) {
      requireSupported();
      const current = probeNativeProcessContainment(identity);
      if (current === undefined) {
        if (processAlive(identity.pid)) throw new RuntimeFailure('conflict', 'Native process containment identity no longer matches its leader');
        return;
      }
      if (!sameNativeProcessContainment(identity, current)) {
        throw new RuntimeFailure('conflict', 'Native process containment generation or identity is stale');
      }
      try {
        process.kill(-identity.processGroupId, signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    },
    async wait(identity, waitOptions) {
      requireSupported();
      if (!Number.isSafeInteger(waitOptions.timeoutMs) || waitOptions.timeoutMs < 0
        || !Number.isSafeInteger(waitOptions.pollMs) || waitOptions.pollMs < 1) {
        throw new RuntimeFailure('validation', 'Native process containment wait bounds are invalid');
      }
      const deadline = Date.now() + waitOptions.timeoutMs;
      const initial = port.report(identity);
      if (initial.members.length === 0) {
        return Object.freeze({ identity, state: 'exited', members: initial.members });
      }
      if (initial.state !== 'running') return initial;
      for (;;) {
        const members = groupMembers(identity.processGroupId);
        if (members.length === 0) return Object.freeze({ identity, state: 'exited', members });
        if (Date.now() >= deadline) return Object.freeze({ identity, state: 'running', members });
        await delay(Math.min(waitOptions.pollMs, Math.max(1, deadline - Date.now())));
      }
    },
  };
  return Object.freeze(port);
}
