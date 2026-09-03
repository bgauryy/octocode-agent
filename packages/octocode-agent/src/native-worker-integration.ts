import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { RuntimeFailure } from '@octocodeai/agent-core';

export interface NativeWorkerIntegrationGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface NativeWorkerIntegrationGit {
  run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<NativeWorkerIntegrationGitResult>;
}

export class NativeWorkerIntegrationGitError extends Error {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;

  constructor(cwd: string, args: readonly string[], stdout: string, stderr: string, cause: Error) {
    super(`Git integration operation failed: ${stderr.trim() || cause.message}`, { cause });
    this.name = 'NativeWorkerIntegrationGitError';
    this.cwd = cwd;
    this.args = Object.freeze([...args]);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function createNodeNativeWorkerIntegrationGit(): NativeWorkerIntegrationGit {
  const adapter: NativeWorkerIntegrationGit = {
    run(cwd: string, args: readonly string[], signal?: AbortSignal) {
      return new Promise<NativeWorkerIntegrationGitResult>((resolve, reject) => {
        execFile('git', [...args], { cwd, encoding: 'utf8', shell: false, signal }, (error, stdout, stderr) => {
          if (error) {
            reject(new NativeWorkerIntegrationGitError(cwd, args, String(stdout), String(stderr), error));
            return;
          }
          resolve(Object.freeze({ stdout: String(stdout), stderr: String(stderr) }));
        });
      });
    },
  };
  return Object.freeze(adapter);
}

export type NativeWorkerIntegrationState =
  | 'preparing'
  | 'integrating'
  | 'conflict-retained'
  | 'ready-to-apply'
  | 'applying'
  | 'integrated'
  | 'recovery-needed'
  | 'uncertain';

export interface NativeWorkerIntegrationRecord {
  readonly schemaVersion: 1;
  readonly integrationId: string;
  readonly recordGeneration: number;
  readonly state: NativeWorkerIntegrationState;
  readonly repositoryRoot: string;
  readonly integrationPath: string;
  readonly targetRef: string;
  readonly expectedTargetOid: string;
  readonly workspaceGeneration: number;
  readonly workers: readonly { readonly ref: string; readonly oid: string }[];
  readonly appliedCandidateOids: readonly string[];
  readonly candidateOid?: string;
  readonly conflictingPaths?: readonly string[];
  readonly failureDigest?: string;
}

export interface NativeWorkerIntegrationStore {
  create(record: NativeWorkerIntegrationRecord): Promise<void>;
  load(integrationId: string): Promise<NativeWorkerIntegrationRecord | undefined>;
  compareAndSet(
    integrationId: string,
    expectedGeneration: number,
    record: NativeWorkerIntegrationRecord,
  ): Promise<void>;
}

export interface NativeWorkerIntegrationCoordinatorOptions {
  readonly repositoryRoot: string;
  readonly integrationsRoot: string;
  readonly git: NativeWorkerIntegrationGit;
  readonly store: NativeWorkerIntegrationStore;
  readonly workspaceGeneration: () => Promise<number>;
}

export interface NativeWorkerIntegrationStageInput {
  readonly integrationId: string;
  readonly workspaceGeneration: number;
  readonly workerRefs: readonly string[];
  readonly signal?: AbortSignal;
}

const OID = /^[a-f0-9]{40,64}$/u;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,510}$/u;

function identifier(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || result.includes('\0')) throw new RuntimeFailure('validation', `${label} is invalid`);
  return result;
}

function generation(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RuntimeFailure('validation', `${label} is invalid`);
  return value;
}

function oid(value: string, label: string): string {
  const result = value.trim();
  if (!OID.test(result)) throw new RuntimeFailure('adapter-compatibility', `${label} is invalid`);
  return result;
}

function digest(value: unknown): string {
  return createHash('sha256').update(value instanceof Error ? `${value.name}\0${value.message}` : String(value)).digest('hex');
}

function sameStage(record: NativeWorkerIntegrationRecord, input: NativeWorkerIntegrationStageInput): boolean {
  return record.workspaceGeneration === input.workspaceGeneration
    && record.workers.map((worker) => worker.ref).join('\0') === input.workerRefs.join('\0');
}

function freezeRecord(record: NativeWorkerIntegrationRecord): NativeWorkerIntegrationRecord {
  return Object.freeze({
    ...record,
    workers: Object.freeze(record.workers.map((worker) => Object.freeze({ ...worker }))),
    appliedCandidateOids: Object.freeze([...record.appliedCandidateOids]),
    ...(record.conflictingPaths === undefined ? {} : { conflictingPaths: Object.freeze([...record.conflictingPaths]) }),
  });
}

export class NativeWorkerIntegrationCoordinator {
  readonly #repositoryRoot: string;
  readonly #integrationsRoot: string;
  readonly #git: NativeWorkerIntegrationGit;
  readonly #store: NativeWorkerIntegrationStore;
  readonly #workspaceGeneration: () => Promise<number>;

  constructor(options: NativeWorkerIntegrationCoordinatorOptions) {
    this.#repositoryRoot = fs.realpathSync(path.resolve(options.repositoryRoot));
    const integrationsRoot = path.resolve(options.integrationsRoot);
    fs.mkdirSync(integrationsRoot, { recursive: true });
    this.#integrationsRoot = fs.realpathSync(integrationsRoot);
    this.#git = options.git;
    this.#store = options.store;
    this.#workspaceGeneration = options.workspaceGeneration;
  }

  async stage(input: NativeWorkerIntegrationStageInput): Promise<NativeWorkerIntegrationRecord> {
    const integrationId = identifier(input.integrationId, 'Worker integration id');
    const requestedGeneration = generation(input.workspaceGeneration, 'Worker integration workspace generation');
    if (input.workerRefs.length < 1 || input.workerRefs.length > 64) {
      throw new RuntimeFailure('validation', 'Worker integration requires between 1 and 64 worker refs');
    }
    const workerRefs = input.workerRefs.map((ref) => identifier(ref, 'Worker integration ref'));
    const existing = await this.#store.load(integrationId);
    if (existing !== undefined) {
      if (!sameStage(existing, { ...input, workerRefs })) throw new RuntimeFailure('conflict', 'Worker integration id is already owned by another request');
      return freezeRecord(existing);
    }
    if (await this.#workspaceGeneration() !== requestedGeneration) {
      throw new RuntimeFailure('conflict', 'Worker integration workspace generation changed before staging');
    }
    const targetRef = await this.#attachedTargetRef(input.signal);
    const expectedTargetOid = await this.#readOid(this.#repositoryRoot, ['rev-parse', 'HEAD'], 'Worker integration target HEAD', input.signal);
    const targetRefOid = await this.#readOid(this.#repositoryRoot, ['rev-parse', targetRef], 'Worker integration target ref', input.signal);
    if (targetRefOid !== expectedTargetOid) throw new RuntimeFailure('conflict', 'Worker integration target ref does not match checkout HEAD');
    await this.#assertCleanCheckout(input.signal);
    const workers: Array<{ ref: string; oid: string }> = [];
    for (const ref of workerRefs) {
      workers.push({ ref, oid: await this.#readOid(this.#repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`], 'Worker integration candidate', input.signal) });
    }
    const confirmedHead = await this.#readOid(this.#repositoryRoot, ['rev-parse', 'HEAD'], 'Worker integration confirmed target HEAD', input.signal);
    const confirmedTarget = await this.#readOid(this.#repositoryRoot, ['rev-parse', targetRef], 'Worker integration confirmed target ref', input.signal);
    if (confirmedHead !== expectedTargetOid || confirmedTarget !== expectedTargetOid
      || await this.#workspaceGeneration() !== requestedGeneration) {
      throw new RuntimeFailure('conflict', 'Worker integration target changed during staging preflight');
    }
    await this.#assertCleanCheckout(input.signal);
    const integrationPath = path.join(this.#integrationsRoot, encodeURIComponent(integrationId));
    if (fs.existsSync(integrationPath)) throw new RuntimeFailure('conflict', 'Unowned worker integration path already exists');
    let record = freezeRecord({
      schemaVersion: 1,
      integrationId,
      recordGeneration: 1,
      state: 'preparing',
      repositoryRoot: this.#repositoryRoot,
      integrationPath,
      targetRef,
      expectedTargetOid,
      workspaceGeneration: requestedGeneration,
      workers,
      appliedCandidateOids: [],
    });
    await this.#store.create(record);
    try {
      await this.#git.run(this.#repositoryRoot, [
        'worktree', 'add', '--detach', '--lock', '--reason', `octocode-integration:${integrationId}`, integrationPath, expectedTargetOid,
      ], input.signal);
      record = await this.#transition(record, { state: 'integrating' });
      for (const [index, worker] of workers.entries()) {
        try {
          await this.#git.run(integrationPath, ['merge', '--no-ff', '--no-commit', worker.oid], input.signal);
        } catch (error) {
          const conflictingPaths = await this.#conflictingPaths(integrationPath, input.signal);
          if (conflictingPaths.length > 0 || await this.#hasMergeHead(integrationPath, input.signal)) {
            return this.#transition(record, {
              state: 'conflict-retained',
              conflictingPaths,
              failureDigest: digest(error),
            });
          }
          await this.#transition(record, { state: 'recovery-needed', failureDigest: digest(error) });
          throw error;
        }
        await this.#git.run(integrationPath, [
          '-c', 'user.name=Octocode Integration',
          '-c', 'user.email=integration@octocode.invalid',
          'commit', '--quiet', '-m', `Octocode worker integration ${index + 1}/${workers.length}`,
        ], input.signal);
        const candidateOid = await this.#readOid(integrationPath, ['rev-parse', 'HEAD'], 'Worker integration candidate commit', input.signal);
        record = await this.#transition(record, {
          state: 'integrating',
          candidateOid,
          appliedCandidateOids: [...record.appliedCandidateOids, candidateOid],
        });
      }
      return this.#transition(record, { state: 'ready-to-apply' });
    } catch (error) {
      const current = await this.#store.load(integrationId);
      if (current !== undefined && current.state !== 'recovery-needed' && current.state !== 'conflict-retained') {
        await this.#transition(current, { state: 'recovery-needed', failureDigest: digest(error) });
      }
      throw error;
    }
  }

  async apply(integrationIdValue: string, signal?: AbortSignal): Promise<NativeWorkerIntegrationRecord> {
    const integrationId = identifier(integrationIdValue, 'Worker integration id');
    let record = await this.#store.load(integrationId);
    if (record === undefined) throw new RuntimeFailure('validation', 'Worker integration record does not exist');
    if (record.state === 'integrated') return freezeRecord(record);
    if (record.state !== 'ready-to-apply' || record.candidateOid === undefined) {
      throw new RuntimeFailure('conflict', 'Worker integration is not ready for explicit apply');
    }
    const candidateOid = record.candidateOid;
    await this.#assertFinalCas(record, signal);
    record = await this.#transition(record, { state: 'applying' });
    try {
      await this.#git.run(this.#repositoryRoot, ['merge', '--ff-only', candidateOid], signal);
    } catch (error) {
      return this.#reconcileApplyFailure(record, error, signal);
    }
    try {
      const applied = await this.#inspectApplied(record, signal);
      if (!applied) throw new Error('Applied target does not match the candidate integration commit');
      return this.#transition(record, { state: 'integrated' });
    } catch (error) {
      await this.#transition(record, { state: 'uncertain', failureDigest: digest(error) });
      throw new RuntimeFailure('persistence', 'Worker integration apply outcome is uncertain');
    }
  }

  async #reconcileApplyFailure(
    record: NativeWorkerIntegrationRecord,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<NativeWorkerIntegrationRecord> {
    try {
      if (await this.#inspectApplied(record, signal)) return this.#transition(record, { state: 'integrated' });
      const unchanged = await this.#inspectUnchanged(record, signal);
      if (unchanged) {
        await this.#transition(record, { state: 'ready-to-apply', failureDigest: digest(error) });
        throw new RuntimeFailure('conflict', 'Worker integration target rejected apply without mutation');
      }
    } catch (inspectionError) {
      if (inspectionError instanceof RuntimeFailure && /without mutation/u.test(inspectionError.message)) throw inspectionError;
    }
    await this.#transition(record, { state: 'uncertain', failureDigest: digest(error) });
    throw new RuntimeFailure('persistence', 'Worker integration apply outcome is uncertain');
  }

  async #assertFinalCas(record: NativeWorkerIntegrationRecord, signal?: AbortSignal): Promise<void> {
    if (await this.#workspaceGeneration() !== record.workspaceGeneration) {
      throw new RuntimeFailure('conflict', 'Worker integration workspace generation changed before apply');
    }
    const targetRef = await this.#attachedTargetRef(signal);
    if (targetRef !== record.targetRef) throw new RuntimeFailure('conflict', 'Worker integration target checkout is detached or attached to another branch');
    await this.#assertCleanCheckout(signal);
    const head = await this.#readOid(this.#repositoryRoot, ['rev-parse', 'HEAD'], 'Worker integration target HEAD', signal);
    const target = await this.#readOid(this.#repositoryRoot, ['rev-parse', record.targetRef], 'Worker integration target ref', signal);
    if (head !== record.expectedTargetOid || target !== record.expectedTargetOid) {
      throw new RuntimeFailure('conflict', 'Worker integration target ref or checkout HEAD advanced before apply');
    }
  }

  async #inspectApplied(record: NativeWorkerIntegrationRecord, signal?: AbortSignal): Promise<boolean> {
    if (await this.#workspaceGeneration() !== record.workspaceGeneration) return false;
    const targetRef = await this.#attachedTargetRef(signal);
    const head = await this.#readOid(this.#repositoryRoot, ['rev-parse', 'HEAD'], 'Worker integration applied HEAD', signal);
    const target = await this.#readOid(this.#repositoryRoot, ['rev-parse', record.targetRef], 'Worker integration applied target ref', signal);
    return targetRef === record.targetRef && head === record.candidateOid && target === record.candidateOid;
  }

  async #inspectUnchanged(record: NativeWorkerIntegrationRecord, signal?: AbortSignal): Promise<boolean> {
    if (await this.#workspaceGeneration() !== record.workspaceGeneration) return false;
    const targetRef = await this.#attachedTargetRef(signal);
    const head = await this.#readOid(this.#repositoryRoot, ['rev-parse', 'HEAD'], 'Worker integration unchanged HEAD', signal);
    const target = await this.#readOid(this.#repositoryRoot, ['rev-parse', record.targetRef], 'Worker integration unchanged target ref', signal);
    const status = await this.#git.run(this.#repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    return targetRef === record.targetRef && head === record.expectedTargetOid && target === record.expectedTargetOid && !status.stdout.trim();
  }

  async #attachedTargetRef(signal?: AbortSignal): Promise<string> {
    let targetRef: string;
    try {
      targetRef = (await this.#git.run(this.#repositoryRoot, ['symbolic-ref', '-q', 'HEAD'], signal)).stdout.trim();
    } catch {
      throw new RuntimeFailure('conflict', 'Worker integration target checkout must be attached to a branch');
    }
    if (!TARGET_REF.test(targetRef)) throw new RuntimeFailure('conflict', 'Worker integration target checkout branch is invalid');
    return targetRef;
  }

  async #assertCleanCheckout(signal?: AbortSignal): Promise<void> {
    const status = await this.#git.run(this.#repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    if (status.stdout.trim()) throw new RuntimeFailure('conflict', 'Worker integration target checkout must be clean');
  }

  async #readOid(cwd: string, args: readonly string[], label: string, signal?: AbortSignal): Promise<string> {
    return oid((await this.#git.run(cwd, args, signal)).stdout, label);
  }

  async #conflictingPaths(cwd: string, signal?: AbortSignal): Promise<readonly string[]> {
    try {
      const result = await this.#git.run(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], signal);
      return Object.freeze(result.stdout.split('\0').filter(Boolean).sort());
    } catch {
      return Object.freeze([]);
    }
  }

  async #hasMergeHead(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#git.run(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], signal);
      return true;
    } catch {
      return false;
    }
  }

  async #transition(
    record: NativeWorkerIntegrationRecord,
    patch: Pick<NativeWorkerIntegrationRecord, 'state'> & Partial<NativeWorkerIntegrationRecord>,
  ): Promise<NativeWorkerIntegrationRecord> {
    const next = freezeRecord({ ...record, ...patch, recordGeneration: record.recordGeneration + 1 });
    await this.#store.compareAndSet(record.integrationId, record.recordGeneration, next);
    return next;
  }
}
