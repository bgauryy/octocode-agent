/**
 * TDD tests for file-state.ts
 *
 * Covers the shared file read-state tracking and mutation queue used by
 * edit-tool.ts, write-tool.ts, and octocode-tools.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'vitest';
import {
  resolveFilePath,
  withFileMutationQueue,
  recordFileReadState,
  checkReadState,
  clearReadStatesForTests,
} from '../src/tools/file-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-state-test-'));
  clearReadStatesForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearReadStatesForTests();
});

// ─── resolveFilePath ──────────────────────────────────────────────────────────

test('resolveFilePath: absolute path is returned as-is', () => {
  const abs = path.join(os.tmpdir(), 'example.txt');
  assert.equal(resolveFilePath(abs, '/some/cwd'), abs);
});

test('resolveFilePath: relative path is resolved against cwd', () => {
  const cwd = '/my/project';
  assert.equal(resolveFilePath('src/index.ts', cwd), '/my/project/src/index.ts');
});

test('resolveFilePath: defaults to process.cwd() when cwd omitted', () => {
  const rel = 'some/file.ts';
  assert.equal(resolveFilePath(rel), path.resolve(rel));
});

// ─── withFileMutationQueue ────────────────────────────────────────────────────

test('withFileMutationQueue: executes the operation and resolves its value', async () => {
  const result = await withFileMutationQueue('/some/key', () => Promise.resolve(42));
  assert.equal(result, 42);
});

test('withFileMutationQueue: propagates errors from the fn to the caller', async () => {
  await assert.rejects(
    () => withFileMutationQueue('/some/key', () => Promise.reject(new Error('boom'))),
    /boom/,
  );
});

test('withFileMutationQueue: serialises concurrent writes on the same key', async () => {
  const filePath = path.join(tmpDir, 'serial.txt');
  fs.writeFileSync(filePath, 'init');

  const order: number[] = [];
  const op = (n: number, delay: number): Promise<void> =>
    withFileMutationQueue(filePath, () =>
      new Promise((res) => setTimeout(() => { order.push(n); res(); }, delay)),
    );

  // Launch all three simultaneously; expect them to execute in enqueue order.
  await Promise.all([op(1, 30), op(2, 10), op(3, 5)]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('withFileMutationQueue: queue continues after a failed operation', async () => {
  const key = '/some/key-recovery';
  const results: string[] = [];

  await Promise.allSettled([
    withFileMutationQueue(key, () => Promise.reject(new Error('fail'))),
    withFileMutationQueue(key, () => { results.push('ok'); return Promise.resolve(); }),
  ]);
  assert.deepEqual(results, ['ok'], 'second op must run even if first failed');
});

test('withFileMutationQueue: different keys run independently (no blocking)', async () => {
  const starts: string[] = [];
  const done: string[] = [];

  const op = (key: string, delay: number) =>
    withFileMutationQueue(key, () =>
      new Promise<void>((res) => {
        starts.push(key);
        setTimeout(() => { done.push(key); res(); }, delay);
      }),
    );

  await Promise.all([op('a', 30), op('b', 5)]);
  // Both started before either finished (different keys don't serialise each other)
  assert.equal(starts.length, 2);
  assert.equal(done.length, 2);
  // 'b' finishes first because its delay is shorter
  assert.equal(done[0], 'b');
  assert.equal(done[1], 'a');
});

// ─── recordFileReadState / checkReadState ─────────────────────────────────────

test('recordFileReadState then checkReadState returns "fresh" for unchanged file', async () => {
  const file = path.join(tmpDir, 'track.txt');
  fs.writeFileSync(file, 'hello world');
  await recordFileReadState(file, tmpDir);
  const result = await checkReadState(file, false);
  assert.equal(result.state, 'fresh');
});

test('checkReadState returns "missing" when file was never recorded', async () => {
  const file = path.join(tmpDir, 'untracked.txt');
  fs.writeFileSync(file, 'content');
  const result = await checkReadState(file, false);
  assert.equal(result.state, 'missing');
});

test('checkReadState throws when requireRecentRead is true and no state is recorded', async () => {
  const file = path.join(tmpDir, 'no-state.txt');
  fs.writeFileSync(file, 'content');
  await assert.rejects(
    () => checkReadState(file, true),
    /No prior localGetFileContent read state recorded/,
  );
});

test('checkReadState throws "changed" error when file content is modified after recording', async () => {
  const file = path.join(tmpDir, 'stale.txt');
  fs.writeFileSync(file, 'original content');
  await recordFileReadState(file, tmpDir);

  // Modify content — this will change both mtime and content hash
  fs.writeFileSync(file, 'modified content');

  await assert.rejects(
    () => checkReadState(file, false),
    /File changed since last recorded read/,
  );
});

test('clearReadStatesForTests removes all recorded states', async () => {
  const file = path.join(tmpDir, 'clear-test.txt');
  fs.writeFileSync(file, 'data');
  await recordFileReadState(file, tmpDir);
  clearReadStatesForTests();
  // After clearing, state is missing → should not throw with requireRecentRead=false
  const result = await checkReadState(file, false);
  assert.equal(result.state, 'missing');
});

test('recordFileReadState accepts an absolute path (cwd unused)', async () => {
  const file = path.join(tmpDir, 'abs.txt');
  fs.writeFileSync(file, 'absolute');
  // Pass absolute path; cwd is irrelevant
  await recordFileReadState(file);
  const result = await checkReadState(file, true);
  assert.equal(result.state, 'fresh');
});

test('recordFileReadState resolves relative path against provided cwd', async () => {
  const file = path.join(tmpDir, 'relative.txt');
  fs.writeFileSync(file, 'relative path test');
  // Pass relative filename + cwd
  await recordFileReadState('relative.txt', tmpDir);
  const result = await checkReadState(file, true);
  assert.equal(result.state, 'fresh');
});

test('checkReadState returns "fresh" even when mtime changes but content is identical', async () => {
  const file = path.join(tmpDir, 'touch-test.txt');
  const content = 'same content both times';
  fs.writeFileSync(file, content);
  await recordFileReadState(file, tmpDir);

  // Simulate editor "touch" — change mtime without changing content
  // We write the exact same bytes so content hash matches
  await new Promise((res) => setTimeout(res, 10)); // ensure mtime would differ
  fs.writeFileSync(file, content);

  // No error — content hash matches, so not stale
  const result = await checkReadState(file, false);
  assert.equal(result.state, 'fresh');
});
