import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn as spawnChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  RuntimeFailure,
  packetId,
  parseRpcEvent,
  parseRpcResponse,
  type RpcResponse,
  type WorkerHandle,
  type WorkerPacket,
  type WorkerPort,
  type WorkerSpawnPacket,
  type WorkerTerminalOutcome,
  type WorkerTerminalPacket,
  type WorkerWorktreePort,
} from '@octocodeai/agent-core';
import type {
  NativeWorkerInputCommand,
  NativeWorkerMessageJournal,
} from './native-rust-worker-messages.js';
import {
  encodeNativeWorkerBootstrapPacketV1,
  type NativeWorkerBootstrapPacketV1,
  type NativeWorkerPromptCustomizationV1,
} from './native-worker-bootstrap.js';
import type { NativeResolvedPortableCustomizationDescriptorV1 } from './native-portable-customization.js';

export interface NativeGitProcessResult { readonly stdout: string; readonly stderr: string }
export interface NativeGitProcessAdapter {
  run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<NativeGitProcessResult>;
}

export type NativeWorkerWorktreeRecovery =
  | { readonly path: string; readonly action: 'retain' }
  | { readonly path: string; readonly action: 'discard' }
  | { readonly path: string; readonly action: 'refresh'; readonly baseRevision: string };

export interface NativeWorkerWorktreePortOptions {
  readonly repositoryRoot: string;
  readonly worktreesRoot: string;
  readonly git?: NativeGitProcessAdapter;
  readonly release?: (terminal: WorkerTerminalPacket) => 'retain' | 'discard';
}

export interface NativeWorkerProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly shell: false;
  readonly promptDigest: string;
  readonly cacheKey: string;
  readonly ownershipToken: string;
  /** One closed bootstrap frame delivered over inherited descriptor 3. */
  readonly bootstrap?: Uint8Array;
}

export interface NativeWorkerProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
  readonly commandSha256: string;
  readonly ownershipTokenSha256: string;
  readonly verification: 'linux-proc' | 'darwin-ps';
}

export interface NativeWorkerProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface NativeWorkerProcessHandle {
  readonly pid?: number;
  readonly identity?: NativeWorkerProcessIdentity;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly exit: Promise<NativeWorkerProcessResult>;
  write(line: string): Promise<void>;
  endInput(): Promise<void>;
  abort(): void;
  kill(): void;
}

export interface NativeWorkerProcessAdapter {
  spawn(spec: NativeWorkerProcessSpec): NativeWorkerProcessHandle;
}

export interface NativeWorkerHandback {
  readonly schemaVersion: 1;
  readonly text: string;
  readonly events: readonly unknown[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly promptDigest: string;
  readonly cacheKey: string;
}

export interface NativeWorkerProcessPortOptions {
  readonly process: NativeWorkerProcessAdapter;
  readonly command: string;
  readonly argvPrefix?: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envAllowlist?: readonly string[];
  readonly maxOutputBytes?: number;
  readonly parentAgentId?: string;
  /** Current process depth in the bounded native-worker tree. Root is zero. */
  readonly workerDepth?: number;
  /** Maximum child-process depth. A process at this depth cannot delegate again. */
  readonly maxWorkerDepth?: number;
  /** Optional defense-in-depth boundary for worktree process cwd validation. */
  readonly worktreesRoot?: string;
  readonly onProcessStarted?: (packet: WorkerSpawnPacket, identity: NativeWorkerProcessIdentity) => void | Promise<void>;
  readonly messageJournal?: NativeWorkerMessageJournal;
  readonly workerCustomization?: NativeResolvedPortableCustomizationDescriptorV1;
  readonly workerPromptCustomization?: NativeWorkerPromptCustomizationV1;
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WORKER_TOOLS = 128;
const MAX_WORKER_MODELS = 64;
const MAX_WORKER_TURNS = 1_000;
const MAX_CAPABILITY_ENV_BYTES = 16 * 1024;
const DEFAULT_MAX_WORKER_DEPTH = 1;
const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  'HOME', 'PATH', 'SHELL', 'TMPDIR', 'USER',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'OCTOCODE_HOME', 'OCTOCODE_MODEL_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
]);

function safeString(value: string, label: string): string {
  if (!value.trim()) throw new RuntimeFailure('validation', `${label} must not be empty`);
  if (value.includes('\0')) throw new RuntimeFailure('validation', `${label} must not contain a null byte`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RuntimeFailure('validation', `${label} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new RuntimeFailure('validation', `${label} must be a non-negative integer`);
  return resolved;
}

function canonicalDirectory(value: string): string {
  const resolved = path.resolve(safeString(value, 'Worker cwd'));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new RuntimeFailure('validation', 'Worker cwd must be a directory');
  return fs.realpathSync(resolved);
}

function containedPath(root: string, candidate: string): string {
  const value = safeString(candidate, 'Worker worktree path');
  if (!path.isAbsolute(value)) throw new RuntimeFailure('validation', 'Worker worktree path must be absolute');
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const physical = path.join(fs.realpathSync(ancestor), ...suffix);
  const physicalRoot = fs.realpathSync(root);
  const relative = path.relative(physicalRoot, physical);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new RuntimeFailure('validation', 'Worker worktree path must be contained by the configured worktrees root');
  }
  return physical;
}

export function createNodeNativeGitProcessAdapter(): NativeGitProcessAdapter {
  return {
    run(cwd, args, signal) {
      return new Promise((resolve, reject) => {
        execFile('git', [...args], { cwd, encoding: 'utf8', signal, shell: false }, (error, stdout, stderr) => {
          if (error) {
            reject(new RuntimeFailure('adapter-compatibility', `Git worktree operation failed: ${String(stderr).trim() || error.message}`));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      });
    },
  };
}

/** Safe native lifecycle for explicit, contained git worktrees. */
export class NativeWorkerWorktreePort implements WorkerWorktreePort {
  readonly #repositoryRoot: string;
  readonly #worktreesRoot: string;
  readonly #git: NativeGitProcessAdapter;
  readonly #releasePolicy: (terminal: WorkerTerminalPacket) => 'retain' | 'discard';

  constructor(options: NativeWorkerWorktreePortOptions) {
    this.#repositoryRoot = canonicalDirectory(options.repositoryRoot);
    const worktreesRoot = path.resolve(safeString(options.worktreesRoot, 'Worker worktrees root'));
    fs.mkdirSync(worktreesRoot, { recursive: true });
    this.#worktreesRoot = fs.realpathSync(worktreesRoot);
    this.#git = options.git ?? createNodeNativeGitProcessAdapter();
    this.#releasePolicy = options.release ?? (() => 'retain');
  }

  async prepare(packet: WorkerSpawnPacket, signal: AbortSignal): Promise<void> {
    if (packet.workspace.mode !== 'worktree') return;
    if (signal.aborted) throw new RuntimeFailure('cancelled', 'Worker worktree preparation was cancelled');
    const target = containedPath(this.#worktreesRoot, packet.workspace.path);
    const revision = safeString(packet.workspace.baseRevision, 'Worker base revision');
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.#git.run(this.#repositoryRoot, ['worktree', 'add', '--detach', target, revision], signal);
      return;
    }
    await this.#assertClean(target, signal);
    await this.#git.run(target, ['checkout', '--detach', revision], signal);
  }

  async release(packet: WorkerSpawnPacket, terminal: WorkerTerminalPacket): Promise<void> {
    if (packet.workspace.mode !== 'worktree') return;
    if (this.#releasePolicy(terminal) === 'discard') await this.recover({ path: packet.workspace.path, action: 'discard' });
  }

  async recover(request: NativeWorkerWorktreeRecovery): Promise<void> {
    const target = containedPath(this.#worktreesRoot, request.path);
    if (request.action === 'retain') return;
    if (!fs.existsSync(target)) return;
    await this.#assertClean(target);
    if (request.action === 'refresh') {
      await this.#git.run(target, ['checkout', '--detach', safeString(request.baseRevision, 'Worker base revision')]);
      return;
    }
    await this.#git.run(this.#repositoryRoot, ['worktree', 'remove', '--force', target]);
  }

  async #assertClean(target: string, signal?: AbortSignal): Promise<void> {
    const status = await this.#git.run(target, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    if (status.stdout.trim()) throw new RuntimeFailure('conflict', 'Worker worktree is dirty or conflicted and was retained');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function linuxProcessIdentity(pid: number, ownershipToken: string): NativeWorkerProcessIdentity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startToken = fields[19];
    const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
    const environ = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    if (!startToken || !command || !environ.includes(`OCTOCODE_WORKER_OWNERSHIP_TOKEN=${ownershipToken}`)) return undefined;
    return { pid, startToken, commandSha256: sha256(command), ownershipTokenSha256: sha256(ownershipToken), verification: 'linux-proc' };
  } catch { return undefined; }
}

function darwinProcessIdentity(pid: number, ownershipToken: string, tokenIsDigest = false): NativeWorkerProcessIdentity | undefined {
  try {
    const output = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim();
    const match = /^(.{24})\s+(.+)$/.exec(output);
    if (!match) return undefined;
    return { pid, startToken: match[1]!, commandSha256: sha256(match[2]!), ownershipTokenSha256: tokenIsDigest ? ownershipToken : sha256(ownershipToken), verification: 'darwin-ps' };
  } catch { return undefined; }
}

export function captureNativeWorkerProcessIdentity(pid: number, ownershipToken: string): NativeWorkerProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || !ownershipToken) return undefined;
  if (process.platform === 'linux') return linuxProcessIdentity(pid, ownershipToken);
  if (process.platform === 'darwin') return darwinProcessIdentity(pid, ownershipToken);
  return undefined;
}

export function probeNativeWorkerProcessIdentity(identity: NativeWorkerProcessIdentity): NativeWorkerProcessIdentity | undefined {
  if (identity.verification === 'linux-proc') {
    try {
      const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      const startToken = stat.slice(close + 2).trim().split(/\s+/)[19];
      const command = fs.readFileSync(`/proc/${identity.pid}/cmdline`).toString('utf8');
      const token = fs.readFileSync(`/proc/${identity.pid}/environ`).toString('utf8').split('\0')
        .find((value) => value.startsWith('OCTOCODE_WORKER_OWNERSHIP_TOKEN='))?.slice('OCTOCODE_WORKER_OWNERSHIP_TOKEN='.length);
      if (!startToken || !command || !token) return undefined;
      return { pid: identity.pid, startToken, commandSha256: sha256(command), ownershipTokenSha256: sha256(token), verification: 'linux-proc' };
    } catch { return undefined; }
  }
  if (identity.verification === 'darwin-ps') return darwinProcessIdentity(identity.pid, identity.ownershipTokenSha256, true);
  return undefined;
}

export function sameNativeWorkerProcess(left: NativeWorkerProcessIdentity, right: NativeWorkerProcessIdentity): boolean {
  return left.pid === right.pid && left.startToken === right.startToken && left.commandSha256 === right.commandSha256
    && left.ownershipTokenSha256 === right.ownershipTokenSha256 && left.verification === right.verification;
}

function capabilityEnvironment(packet: WorkerSpawnPacket): {
  tools: string;
  octocodeTools?: string;
  models: string;
  maxTurns: string;
} {
  if (packet.capabilities.tools.length > MAX_WORKER_TOOLS) throw new RuntimeFailure('validation', `Worker tools exceed ${MAX_WORKER_TOOLS}`);
  if ((packet.capabilities.octocodeTools?.length ?? 0) > MAX_WORKER_TOOLS) throw new RuntimeFailure('validation', `Worker Octocode tools exceed ${MAX_WORKER_TOOLS}`);
  if (packet.capabilities.models.length > MAX_WORKER_MODELS) throw new RuntimeFailure('validation', `Worker models exceed ${MAX_WORKER_MODELS}`);
  if (!Number.isSafeInteger(packet.capabilities.maxTurns) || packet.capabilities.maxTurns < 1 || packet.capabilities.maxTurns > MAX_WORKER_TURNS) {
    throw new RuntimeFailure('validation', `Worker maxTurns must be between 1 and ${MAX_WORKER_TURNS}`);
  }
  const tools = JSON.stringify(packet.capabilities.tools.map((tool) => safeString(tool, 'Worker tool capability')));
  const octocodeTools = packet.capabilities.octocodeTools === undefined
    ? undefined
    : JSON.stringify(packet.capabilities.octocodeTools.map((tool) => safeString(tool, 'Worker Octocode tool capability')));
  const models = JSON.stringify(packet.capabilities.models.map((model) => ({
    providerId: safeString(model.providerId, 'Worker model provider'),
    modelId: safeString(model.modelId, 'Worker model id'),
  })));
  const maxTurns = String(packet.capabilities.maxTurns);
  if (Buffer.byteLength(tools) + Buffer.byteLength(octocodeTools ?? '') + Buffer.byteLength(models) + Buffer.byteLength(maxTurns) > MAX_CAPABILITY_ENV_BYTES) {
    throw new RuntimeFailure('validation', `Worker capability metadata exceeds ${MAX_CAPABILITY_ENV_BYTES} bytes`);
  }
  return { tools, ...(octocodeTools === undefined ? {} : { octocodeTools }), models, maxTurns };
}

function messageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = (value as { event?: unknown }).event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const candidate = event as { type?: unknown; payload?: unknown };
  if (candidate.type !== 'message.delta' || !candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) return undefined;
  const payload = candidate.payload as { type?: unknown; text?: unknown };
  return payload.type === 'text' && typeof payload.text === 'string' ? payload.text : undefined;
}

function terminalPacket(
  spawn: WorkerSpawnPacket,
  outcome: WorkerTerminalOutcome,
  reason: string | undefined,
  handback?: NativeWorkerHandback,
): WorkerTerminalPacket {
  return Object.freeze({
    schemaVersion: 1,
    type: 'worker.terminal',
    packetId: packetId(`native-terminal:${spawn.workerId}:${outcome}`),
    workerId: spawn.workerId,
    correlationId: spawn.correlationId,
    sessionId: spawn.sessionId,
    redaction: spawn.redaction,
    outcome,
    ...(handback === undefined ? {} : { handback }),
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Creates the low-level Node adapter used by NativeWorkerProcessPort. */
export function createNodeNativeWorkerProcessAdapter(): NativeWorkerProcessAdapter {
  return {
    spawn(spec) {
      const child = spawnChildProcess(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      const bootstrap = child.stdio[3];
      if (bootstrap == null || typeof (bootstrap as NodeJS.WritableStream).write !== 'function') {
        child.kill('SIGKILL');
        throw new RuntimeFailure('adapter-compatibility', 'Native worker bootstrap pipe is unavailable');
      }
      bootstrap.on('error', () => undefined);
      (bootstrap as NodeJS.WritableStream).end(Buffer.from(spec.bootstrap ?? []));
      const exit = new Promise<NativeWorkerProcessResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      return {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        ...(child.pid === undefined ? {} : { identity: captureNativeWorkerProcessIdentity(child.pid, spec.ownershipToken) }),
        stdout: child.stdout,
        stderr: child.stderr,
        exit,
        async write(line) {
          if (child.stdin.destroyed || !child.stdin.writable) throw new RuntimeFailure('adapter-compatibility', 'Native worker stdin is unavailable');
          if (!child.stdin.write(line, 'utf8')) await once(child.stdin, 'drain');
        },
        async endInput() {
          if (child.stdin.destroyed || child.stdin.writableEnded) return;
          await new Promise<void>((resolve, reject) => {
            child.stdin.end((error?: Error | null) => error ? reject(error) : resolve());
          });
        },
        abort: () => { child.kill('SIGTERM'); },
        kill: () => { child.kill('SIGKILL'); },
      };
    },
  };
}

/**
 * Native process implementation of the core WorkerPort. Queueing, concurrency,
 * waiter resolution, lifecycle state, and shutdown remain solely owned by the
 * core WorkerSupervisor.
 */
export class NativeWorkerProcessPort implements WorkerPort {
  readonly #process: NativeWorkerProcessAdapter;
  readonly #command: string;
  readonly #argvPrefix: readonly string[];
  readonly #cwd: string;
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #envAllowlist: readonly string[];
  readonly #maxOutputBytes: number;
  readonly #parentAgentId: string;
  readonly #workerDepth: number;
  readonly #maxWorkerDepth: number;
  readonly #worktreesRoot?: string;
  readonly #onProcessStarted?: NativeWorkerProcessPortOptions['onProcessStarted'];
  readonly #messageJournal?: NativeWorkerMessageJournal;
  readonly #workerCustomization?: NativeResolvedPortableCustomizationDescriptorV1;
  readonly #workerPromptCustomization?: NativeWorkerPromptCustomizationV1;

  constructor(options: NativeWorkerProcessPortOptions) {
    this.#process = options.process;
    this.#command = safeString(options.command, 'Worker command');
    this.#argvPrefix = Object.freeze([...(options.argvPrefix ?? [])].map((value) => safeString(value, 'Worker argv prefix')));
    this.#cwd = canonicalDirectory(options.cwd);
    this.#sourceEnv = options.env ?? process.env;
    this.#envAllowlist = Object.freeze([...(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST)]);
    for (const key of this.#envAllowlist) safeString(key, 'Worker environment allowlist key');
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
    this.#parentAgentId = options.parentAgentId?.trim() || this.#sourceEnv.OCTOCODE_AGENT_ID?.trim() || 'native-agent';
    this.#workerDepth = nonNegativeInteger(options.workerDepth, 0, 'workerDepth');
    this.#maxWorkerDepth = positiveInteger(options.maxWorkerDepth, DEFAULT_MAX_WORKER_DEPTH, 'maxWorkerDepth');
    if (this.#maxWorkerDepth !== DEFAULT_MAX_WORKER_DEPTH) {
      throw new RuntimeFailure('validation', 'Native workers are leaf-only; maxWorkerDepth must be 1');
    }
    if (this.#workerDepth > this.#maxWorkerDepth) throw new RuntimeFailure('validation', 'workerDepth cannot exceed maxWorkerDepth');
    this.#worktreesRoot = options.worktreesRoot === undefined
      ? undefined
      : path.resolve(safeString(options.worktreesRoot, 'Worker worktrees root'));
    this.#onProcessStarted = options.onProcessStarted;
    this.#messageJournal = options.messageJournal;
    this.#workerCustomization = options.workerCustomization;
    this.#workerPromptCustomization = options.workerPromptCustomization;
  }

  async spawn(packet: WorkerSpawnPacket, signal: AbortSignal): Promise<WorkerHandle> {
    if (signal.aborted) throw new RuntimeFailure('cancelled', 'Worker spawn was cancelled');
    const childDepth = this.#workerDepth + 1;
    const delegates = packet.capabilities.tools.includes('worker');
    if (delegates && childDepth >= this.#maxWorkerDepth) {
      throw new RuntimeFailure('validation', `Worker capability exceeds the native worker depth cap ${this.#maxWorkerDepth}`);
    }
    const workerCwd = packet.workspace.mode === 'worktree'
      ? canonicalDirectory(this.#worktreesRoot === undefined
        ? packet.workspace.path
        : containedPath(this.#worktreesRoot, packet.workspace.path))
      : this.#cwd;
    const prompt = safeString(packet.prompt, 'Worker prompt');
    const capabilities = capabilityEnvironment(packet);
    const promptDigest = sha256(prompt);
    const customizationDigest = this.#workerCustomization !== undefined
      ? sha256(JSON.stringify(this.#workerCustomization))
      : this.#workerPromptCustomization === undefined
        ? null
        : sha256(JSON.stringify(this.#workerPromptCustomization));
    const cacheKey = sha256(JSON.stringify([
      this.#command,
      this.#argvPrefix,
      workerCwd,
      promptDigest,
      packet.promptSnapshotId,
      packet.capabilities,
      customizationDigest,
    ]));
    const env: NodeJS.ProcessEnv = {};
    for (const key of this.#envAllowlist) {
      const value = this.#sourceEnv[key];
      if (value !== undefined) env[key] = value;
    }
    env.OCTOCODE_NATIVE_WORKER = '1';
    env.OCTOCODE_NATIVE_WORKER_BOOTSTRAP_FD = '3';
    env.OCTOCODE_NATIVE_WORKER_DEPTH = String(childDepth);
    env.OCTOCODE_NATIVE_WORKER_MAX_DEPTH = String(this.#maxWorkerDepth);
    env.OCTOCODE_AGENT_ID = `${this.#parentAgentId}:worker:${packet.workerId}`;
    env.OCTOCODE_WORKER_ID = packet.workerId;
    env.OCTOCODE_WORKER_CORRELATION_ID = packet.correlationId;
    env.OCTOCODE_EXPECTED_PROMPT_SHA256 = safeString(packet.promptSnapshotId, 'Worker prompt snapshot id');
    env.OCTOCODE_WORKER_ALLOWED_TOOLS = capabilities.tools;
    if (capabilities.octocodeTools !== undefined) env.OCTOCODE_WORKER_ALLOWED_OCTOCODE_TOOLS = capabilities.octocodeTools;
    env.OCTOCODE_WORKER_ALLOWED_MODELS = capabilities.models;
    env.OCTOCODE_WORKER_MAX_TURNS = capabilities.maxTurns;
    const ownershipToken = randomUUID();
    env.OCTOCODE_WORKER_OWNERSHIP_TOKEN = ownershipToken;
    const bootstrapPacket: NativeWorkerBootstrapPacketV1 = {
      schemaVersion: 1,
      type: 'native.worker.bootstrap',
      workerId: packet.workerId,
      correlationId: packet.correlationId,
      promptSnapshotId: packet.promptSnapshotId,
      ...(this.#workerCustomization === undefined
        ? {}
        : { customization: this.#workerCustomization }),
      ...(this.#workerPromptCustomization === undefined
        ? {}
        : { promptCustomization: this.#workerPromptCustomization }),
    };
    const spec: NativeWorkerProcessSpec = Object.freeze({
      command: this.#command,
      args: Object.freeze([...this.#argvPrefix, '--mode', 'rpc', '--no-session', ...(delegates ? ['--allow-workers'] : [])]),
      cwd: workerCwd,
      env: Object.freeze(env),
      shell: false,
      promptDigest,
      cacheKey,
      ownershipToken,
      bootstrap: encodeNativeWorkerBootstrapPacketV1(bootstrapPacket),
    });
    const processHandle = this.#process.spawn(spec);
    if (this.#onProcessStarted !== undefined) {
      const identity = processHandle.identity;
      if (identity === undefined) {
        processHandle.kill();
        throw new RuntimeFailure('unsupported-capability', 'Native worker process identity cannot be verified on this platform');
      }
      try { await this.#onProcessStarted(packet, identity); }
      catch {
        processHandle.kill();
        throw new RuntimeFailure('persistence', 'Native worker process identity could not be persisted');
      }
    }
    let requestedOutcome: Extract<WorkerTerminalOutcome, 'aborted' | 'killed'> | undefined;
    let termSent = false;
    let killSent = false;
    let protocolFailure: string | undefined;
    let requestSequence = 0;
    const pending = new Map<string, { resolve(response: RpcResponse): void; reject(error: Error): void }>();
    let journalTail: Promise<void> = Promise.resolve();
    let journalFailure: string | undefined;

    const forceKill = (): void => {
      if (killSent) return;
      killSent = true;
      processHandle.kill();
    };
    const failProtocol = (reason: string): void => {
      if (protocolFailure !== undefined) return;
      protocolFailure = reason;
      const failure = new RuntimeFailure('protocol', reason);
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      forceKill();
    };
    const settleJournal = (operation: () => Promise<void>, reason: string): Promise<void> => {
      const settlement = journalTail.then(operation);
      journalTail = settlement.catch(() => { journalFailure ??= reason; });
      return settlement;
    };
    const request = async (command: NativeWorkerInputCommand): Promise<{ written: Promise<void>; response: Promise<RpcResponse> }> => {
      const requestId = `native-worker:${packet.workerId}:${++requestSequence}`;
      const lease = await this.#messageJournal?.stage({
        workerId: String(packet.workerId),
        correlationId: String(packet.correlationId),
        sessionId: String(packet.sessionId),
        parentAgentId: this.#parentAgentId,
        requestId,
        command,
      });
      const deliveryCommand = lease?.command ?? command;
      let resolve!: (response: RpcResponse) => void;
      let reject!: (error: Error) => void;
      const rpcResponse = new Promise<RpcResponse>((accept, decline) => { resolve = accept; reject = decline; });
      pending.set(requestId, { resolve, reject });
      const written = processHandle.write(`${JSON.stringify({ protocolVersion: 1, requestId, command: deliveryCommand })}\n`).catch((error: unknown) => {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('Native worker RPC write failed'));
        throw error;
      });
      const response = rpcResponse.then(async (value) => {
        if (lease !== undefined) await settleJournal(() => lease.ack(), 'Worker message acknowledgement failed');
        return value;
      }, async (error: unknown) => {
        if (lease !== undefined) await settleJournal(() => lease.release(), 'Worker message release failed');
        throw error;
      });
      return { written, response };
    };
    const abort = async (reason: string): Promise<void> => {
      if (termSent || killSent) return;
      termSent = true;
      try {
        const cancel = await request({ type: 'input.cancel', reason });
        await cancel.written;
        void cancel.response.catch(() => undefined);
      }
      catch { /* TERM is still required if the RPC stream is already broken. */ }
      processHandle.abort();
    };
    const onSignalAbort = (): void => {
      requestedOutcome ??= 'aborted';
      void abort(typeof signal.reason === 'string' ? signal.reason : 'Worker spawn signal aborted');
    };
    signal.addEventListener('abort', onSignalAbort, { once: true });

    const capture = this.#capture(processHandle, {
      onResponse(response) {
        const waiter = pending.get(response.requestId);
        if (!waiter) { failProtocol('Worker RPC response correlation is invalid'); return; }
        pending.delete(response.requestId);
        waiter.resolve(response);
      },
      onFailure: failProtocol,
      onExceeded: () => { failProtocol(`Worker output exceeded ${this.#maxOutputBytes} bytes`); },
    });
    let initial: Awaited<ReturnType<typeof request>>;
    try {
      initial = await request({ type: 'input.submit', text: prompt });
      await initial.written;
    } catch (error) {
      forceKill();
      throw error;
    }
    void initial.response.then((response) => {
      if (!response.ok) failProtocol('Worker rejected its initial prompt');
    }, () => undefined);
    const completion = (async (): Promise<WorkerTerminalPacket> => {
      let processResult: NativeWorkerProcessResult;
      try { processResult = await processHandle.exit; }
      finally {
        signal.removeEventListener('abort', onSignalAbort);
      }
      const captured = await capture;
      if (pending.size > 0) {
        if (requestedOutcome === undefined) {
          failProtocol('Worker RPC stream ended with unresolved requests');
        } else {
          const failure = new RuntimeFailure('cancelled', 'Worker process ended before acknowledging all input');
          for (const request of pending.values()) request.reject(failure);
          pending.clear();
        }
      }
      await journalTail;
      if (journalFailure !== undefined) failProtocol(journalFailure);
      const handback: NativeWorkerHandback = Object.freeze({
        schemaVersion: 1,
        text: captured.text,
        events: Object.freeze(captured.events),
        exitCode: processResult.code,
        signal: processResult.signal,
        promptDigest,
        cacheKey,
      });
      if (captured.exceeded) return terminalPacket(packet, 'failed', `Worker output exceeded ${this.#maxOutputBytes} bytes`, handback);
      if (protocolFailure !== undefined) return terminalPacket(packet, 'failed', protocolFailure, handback);
      if (requestedOutcome !== undefined) return terminalPacket(packet, requestedOutcome, requestedOutcome, handback);
      if (processResult.code === 0) return terminalPacket(packet, 'succeeded', undefined, handback);
      return terminalPacket(packet, 'failed', processResult.code === null ? 'Worker terminated unexpectedly' : `Worker exited with code ${processResult.code}`, handback);
    })();

    return Object.freeze({
      completion,
      async join(): Promise<void> {
        await processHandle.endInput();
      },
      async send(workerPacket: WorkerPacket): Promise<void> {
        const command: NativeWorkerInputCommand = workerPacket.type === 'worker.steer'
          ? { type: 'input.steer', text: workerPacket.text }
          : workerPacket.type === 'worker.follow-up'
            ? { type: 'input.follow-up', text: workerPacket.text }
            : { type: 'input.submit', text: workerPacket.text };
        const sent = await request(command);
        await sent.written;
        const response = await sent.response;
        if (!response.ok) throw new RuntimeFailure('adapter-translation', 'Native worker rejected an input command');
      },
      async abort(reason: string): Promise<void> {
        requestedOutcome ??= 'aborted';
        await abort(reason);
      },
      async kill(_reason: string): Promise<void> {
        requestedOutcome = 'killed';
        forceKill();
      },
    });
  }

  async #capture(
    handle: NativeWorkerProcessHandle,
    callbacks: {
      onResponse(response: RpcResponse): void;
      onFailure(reason: string): void;
      onExceeded(): void;
    },
  ): Promise<{ text: string; events: unknown[]; exceeded: boolean }> {
    const events: unknown[] = [];
    const text: string[] = [];
    let bytes = 0;
    let exceeded = false;
    let lastSequence = 0;
    let invalid = false;
    const stdout = (async (): Promise<void> => {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let pending = '';
      const fail = (reason: string): void => {
        if (invalid) return;
        invalid = true;
        callbacks.onFailure(reason);
      };
      const consume = (line: string): void => {
        if (invalid || !line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch { fail('Worker RPC stdout is malformed'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail('Worker RPC stdout is malformed'); return; }
        const value = parsed as Record<string, unknown>;
        if (value['protocolVersion'] !== 1) { fail('Worker RPC protocol version is unsupported'); return; }
        if (typeof value['requestId'] === 'string') {
          try { callbacks.onResponse(parseRpcResponse(value)); }
          catch { fail('Worker RPC response is malformed'); }
          return;
        }
        let rpcEvent;
        try { rpcEvent = parseRpcEvent(value); }
        catch { fail('Worker RPC event is malformed'); return; }
        if (rpcEvent.sequence <= lastSequence) {
          fail('Worker RPC event sequence is invalid');
          return;
        }
        lastSequence = rpcEvent.sequence;
        events.push(rpcEvent);
        const delta = messageText(rpcEvent);
        if (delta !== undefined) text.push(delta);
      };
      for await (const chunk of handle.stdout) {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        if (bytes > this.#maxOutputBytes) {
          if (!exceeded) { exceeded = true; callbacks.onExceeded(); }
          continue;
        }
        pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
    })();
    const stderr = (async (): Promise<void> => {
      for await (const _chunk of handle.stderr) {
        // Drained to prevent backpressure, never retained because it may contain secrets.
      }
    })();
    await Promise.allSettled([stdout, stderr]);
    return { text: text.join(''), events, exceeded };
  }
}
