import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createOctocodeCronScheduler,
  formatOctocodeCronStatus,
  handleOctocodeCronCommand,
} from '../src/scheduler.js';
import type { PiExecResult } from '../src/types.js';

test('cron scheduler lists the non-mutating maintenance digest job', () => {
  const scheduler = createOctocodeCronScheduler({
    env: {
      OCTOCODE_CRON: '0',
      OCTOCODE_AWARENESS_CLI: '/tmp/awareness.js',
    } as NodeJS.ProcessEnv,
  });

  scheduler.start({ cwd: '/workspace' });
  const jobs = scheduler.list();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.name, 'maintenance-digest');
  assert.equal(jobs[0]!.enabled, false);
  assert.equal(jobs[0]!.status, 'cancelled');
  assert.match(formatOctocodeCronStatus(jobs), /maintenance-digest/);
  assert.match(formatOctocodeCronStatus(jobs), /dry-run/);
});

test('cron scheduler can run the maintenance digest on demand', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const scheduler = createOctocodeCronScheduler({
    env: {
      OCTOCODE_CRON: '0',
      OCTOCODE_AWARENESS_CLI: '/tmp/awareness.js',
    } as NodeJS.ProcessEnv,
    executor: async (command, args): Promise<PiExecResult> => {
      calls.push({ command, args });
      return { stdout: 'digest ok', stderr: '', code: 0 };
    },
  });

  const results = await scheduler.runNow('maintenance-digest', { cwd: '/repo' });

  assert.deepEqual(results, [
    {
      job: 'maintenance-digest',
      status: 'succeeded',
      exitCode: 0,
      message: 'digest ok',
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args, [
    '/tmp/awareness.js',
    'maintenance',
    'digest',
    '--workspace',
    '/repo',
    '--dry-run',
    '--compact',
  ]);
});

test('cron scheduler skips manual runs when awareness CLI is missing', async () => {
  const scheduler = createOctocodeCronScheduler({
    env: { OCTOCODE_CRON: '0' } as NodeJS.ProcessEnv,
    executor: async (): Promise<PiExecResult> => {
      throw new Error('executor should not run without awareness CLI');
    },
  });

  const results = await scheduler.runNow('maintenance-digest', { cwd: '/repo' });

  assert.equal(results[0]!.status, 'skipped');
  assert.match(results[0]!.message, /OCTOCODE_AWARENESS_CLI/);
});

test('cron command supports list, check, cancel, and help', async () => {
  const messages: Array<{ message: string; level?: string }> = [];
  const scheduler = createOctocodeCronScheduler({
    env: {
      OCTOCODE_CRON: '1',
      OCTOCODE_CRON_DIGEST_INTERVAL_MS: '600000',
      OCTOCODE_AWARENESS_CLI: '/tmp/awareness.js',
    } as NodeJS.ProcessEnv,
    executor: async (): Promise<PiExecResult> => ({ stdout: 'checked', stderr: '', code: 0 }),
  });
  const notify = (_ctx: unknown, message: string, level?: string) => {
    messages.push({ message, level });
  };

  scheduler.start({ cwd: '/repo' });
  await handleOctocodeCronCommand('list', undefined, scheduler, notify);
  assert.match(messages.at(-1)!.message, /Octocode session jobs/);

  await handleOctocodeCronCommand('check maintenance-digest', undefined, scheduler, notify);
  assert.match(messages.at(-1)!.message, /checked/);

  await handleOctocodeCronCommand('cancel maintenance-digest', undefined, scheduler, notify);
  assert.match(messages.at(-1)!.message, /Cancelled/);

  await handleOctocodeCronCommand('help', undefined, scheduler, notify);
  assert.match(messages.at(-1)!.message, /Usage: \/octocode-cron/);

  scheduler.stop();
});
