import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRuntimeStore, runRuntimeTask } from '../src/tools/runtime-store.js';

test('runtime store resets session state and tracks ordered initialization work', async () => {
  let now = 100;
  const store = createRuntimeStore(() => ++now);
  const firstGeneration = store.getState().begin('loading configuration');
  store.getState().setStatus('worker', 'running');
  await runRuntimeTask(store, 'environment', 'loading environment', async () => 'ok');
  store.getState().ready('Octocode ready · cached MCP');

  assert.equal(firstGeneration, 1);
  assert.equal(store.getState().phase, 'ready');
  assert.equal(store.getState().tasks['environment']?.status, 'ready');
  assert.equal(store.getState().statuses['worker'], 'running');

  const secondGeneration = store.getState().begin();
  assert.equal(secondGeneration, 2);
  assert.deepEqual(store.getState().tasks, {});
  assert.deepEqual(store.getState().statuses, {});
  assert.equal(store.getState().mcp.status, 'idle');
});

test('non-critical runtime work degrades without rejecting initialization', async () => {
  const store = createRuntimeStore();
  store.getState().begin();
  const result = await runRuntimeTask(store, 'github', 'checking GitHub', async () => {
    throw new Error('offline');
  });

  assert.equal(result, undefined);
  assert.equal(store.getState().tasks['github']?.status, 'degraded');
  assert.equal(store.getState().tasks['github']?.error, 'offline');
});

test('critical runtime work records failure and rejects', async () => {
  const store = createRuntimeStore();
  store.getState().begin();
  await assert.rejects(
    runRuntimeTask(store, 'environment', 'loading environment', () => { throw new Error('bad env'); }, { critical: true }),
    /bad env/,
  );
  assert.equal(store.getState().tasks['environment']?.status, 'failed');
});
