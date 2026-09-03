import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeWorkerIntegrationCoordinator,
  createNodeNativeWorkerIntegrationGit,
  type NativeWorkerIntegrationRecord,
  type NativeWorkerIntegrationStore,
} from '../src/native-worker-integration.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class MemoryIntegrationStore implements NativeWorkerIntegrationStore {
  readonly records = new Map<string, NativeWorkerIntegrationRecord>();

  async create(record: NativeWorkerIntegrationRecord): Promise<void> {
    if (this.records.has(record.integrationId)) throw new Error('duplicate integration');
    this.records.set(record.integrationId, structuredClone(record));
  }

  async load(integrationId: string): Promise<NativeWorkerIntegrationRecord | undefined> {
    const record = this.records.get(integrationId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async compareAndSet(
    integrationId: string,
    expectedGeneration: number,
    record: NativeWorkerIntegrationRecord,
  ): Promise<void> {
    const current = this.records.get(integrationId);
    if (current?.recordGeneration !== expectedGeneration) throw new Error('stale integration record');
    this.records.set(integrationId, structuredClone(record));
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(repository: string, message: string): string {
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

function fixture(): {
  root: string;
  repository: string;
  integrationsRoot: string;
  targetRef: string;
  baseOid: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-integration-'));
  roots.push(root);
  const repository = path.join(root, 'repository');
  const integrationsRoot = path.join(root, 'integrations');
  fs.mkdirSync(repository);
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.name', 'Octocode Test');
  git(repository, 'config', 'user.email', 'test@invalid');
  fs.writeFileSync(path.join(repository, 'shared.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, 'stable.txt'), 'stable\n');
  const baseOid = commit(repository, 'base');
  return {
    root,
    repository,
    integrationsRoot,
    targetRef: git(repository, 'symbolic-ref', '-q', 'HEAD'),
    baseOid,
  };
}

function workerRef(repository: string, targetRef: string, name: string, file: string, content: string): string {
  git(repository, 'checkout', '--quiet', '-b', name, targetRef);
  fs.writeFileSync(path.join(repository, file), content);
  commit(repository, name);
  const ref = `refs/heads/${name}`;
  git(repository, 'checkout', '--quiet', targetRef.slice('refs/heads/'.length));
  return ref;
}

describe('native worker staged integration', () => {
  it('retains conflicts in the owned integration worktree and leaves the user checkout unchanged', async () => {
    const setup = fixture();
    const first = workerRef(setup.repository, setup.targetRef, 'worker-a', 'shared.txt', 'worker-a\n');
    const second = workerRef(setup.repository, setup.targetRef, 'worker-b', 'shared.txt', 'worker-b\n');
    const store = new MemoryIntegrationStore();
    const coordinator = new NativeWorkerIntegrationCoordinator({
      repositoryRoot: setup.repository,
      integrationsRoot: setup.integrationsRoot,
      git: createNodeNativeWorkerIntegrationGit(),
      store,
      workspaceGeneration: async () => 7,
    });

    const record = await coordinator.stage({
      integrationId: 'conflicting-workers',
      workspaceGeneration: 7,
      workerRefs: [first, second],
    });

    expect(record.state).toBe('conflict-retained');
    expect(record.conflictingPaths).toEqual(['shared.txt']);
    expect(git(setup.repository, 'rev-parse', 'HEAD')).toBe(setup.baseOid);
    expect(git(setup.repository, 'symbolic-ref', '-q', 'HEAD')).toBe(setup.targetRef);
    expect(git(setup.repository, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(fs.readFileSync(path.join(setup.repository, 'shared.txt'), 'utf8')).toBe('base\n');
  });

  it.each(['advanced', 'dirty', 'detached', 'generation'] as const)(
    'refuses explicit apply when the target checkout is %s',
    async (mutation) => {
      const setup = fixture();
      const worker = workerRef(setup.repository, setup.targetRef, `worker-${mutation}`, `${mutation}.txt`, 'candidate\n');
      const store = new MemoryIntegrationStore();
      let currentGeneration = 11;
      const coordinator = new NativeWorkerIntegrationCoordinator({
        repositoryRoot: setup.repository,
        integrationsRoot: setup.integrationsRoot,
        git: createNodeNativeWorkerIntegrationGit(),
        store,
        workspaceGeneration: async () => currentGeneration,
      });
      const staged = await coordinator.stage({
        integrationId: `apply-${mutation}`,
        workspaceGeneration: 11,
        workerRefs: [worker],
      });
      expect(staged.state).toBe('ready-to-apply');

      if (mutation === 'advanced') {
        fs.writeFileSync(path.join(setup.repository, 'advanced-target.txt'), 'advanced\n');
        commit(setup.repository, 'advance target');
      } else if (mutation === 'dirty') {
        fs.writeFileSync(path.join(setup.repository, 'stable.txt'), 'dirty\n');
      } else if (mutation === 'detached') {
        git(setup.repository, 'checkout', '--quiet', '--detach');
      } else {
        currentGeneration = 12;
      }

      await expect(coordinator.apply(staged.integrationId)).rejects.toThrow(/target checkout|target ref|workspace generation/i);
      expect((await store.load(staged.integrationId))?.state).toBe('ready-to-apply');
      expect(git(staged.integrationPath, 'rev-parse', 'HEAD')).toBe(staged.candidateOid);
    },
  );

  it('fast-forwards the attached clean target only after explicit final CAS', async () => {
    const setup = fixture();
    const worker = workerRef(setup.repository, setup.targetRef, 'worker-applied', 'result.txt', 'candidate\n');
    const store = new MemoryIntegrationStore();
    const coordinator = new NativeWorkerIntegrationCoordinator({
      repositoryRoot: setup.repository,
      integrationsRoot: setup.integrationsRoot,
      git: createNodeNativeWorkerIntegrationGit(),
      store,
      workspaceGeneration: async () => 12,
    });
    const staged = await coordinator.stage({
      integrationId: 'successful-apply',
      workspaceGeneration: 12,
      workerRefs: [worker],
    });

    const applied = await coordinator.apply(staged.integrationId);

    expect(applied.state).toBe('integrated');
    expect(git(setup.repository, 'rev-parse', 'HEAD')).toBe(staged.candidateOid);
    expect(git(setup.repository, 'symbolic-ref', '-q', 'HEAD')).toBe(setup.targetRef);
    expect(fs.readFileSync(path.join(setup.repository, 'result.txt'), 'utf8')).toBe('candidate\n');
  });

  it('marks an uninspectable apply failure uncertain', async () => {
    const setup = fixture();
    const worker = workerRef(setup.repository, setup.targetRef, 'worker-success', 'result.txt', 'candidate\n');
    const store = new MemoryIntegrationStore();
    const baseGit = createNodeNativeWorkerIntegrationGit();
    const physicalRepository = fs.realpathSync(setup.repository);
    let ambiguous = false;
    let applyStarted = false;
    const coordinator = new NativeWorkerIntegrationCoordinator({
      repositoryRoot: setup.repository,
      integrationsRoot: setup.integrationsRoot,
      git: {
        async run(cwd, args, signal) {
          if (ambiguous && cwd === physicalRepository && args[0] === 'merge') {
            applyStarted = true;
            throw new Error('transport ended during apply');
          }
          if (applyStarted && cwd === physicalRepository && args[0] === 'rev-parse') throw new Error('target cannot be inspected');
          return baseGit.run(cwd, args, signal);
        },
      },
      store,
      workspaceGeneration: async () => 13,
    });
    const staged = await coordinator.stage({
      integrationId: 'ambiguous-apply',
      workspaceGeneration: 13,
      workerRefs: [worker],
    });
    ambiguous = true;

    await expect(coordinator.apply(staged.integrationId)).rejects.toThrow(/uncertain/i);
    expect((await store.load(staged.integrationId))?.state).toBe('uncertain');
    expect(git(setup.repository, 'rev-parse', 'HEAD')).toBe(setup.baseOid);
  });
});
