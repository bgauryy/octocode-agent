import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { PiContext, PiInstance } from '../src/types.js';
import {
  scheduleCompactionContinuation,
  resetCompactionResumeStateForTests,
  setCompactionResumeRetryDelayForTests,
} from '../src/tools/compaction-resume.js';

const ctx = { hasUI: true, ui: { setWorkingMessage() {}, setWorkingVisible() {} } } as unknown as PiContext;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

afterEach(() => {
  resetCompactionResumeStateForTests();
  setCompactionResumeRetryDelayForTests(null);
});

function makePi(sendImpl: (text: string) => void | Promise<void>) {
  const calls: string[] = [];
  const pi = {
    sendUserMessage: (text: string) => { calls.push(text); return sendImpl(text); },
  } as unknown as PiInstance;
  return { pi, calls };
}

test('resume sends the continuation exactly once on success', async () => {
  resetCompactionResumeStateForTests();
  const notes: Array<{ msg: string; level?: string }> = [];
  const { pi, calls } = makePi(() => undefined);
  scheduleCompactionContinuation(pi, ctx, (_c, msg, level) => notes.push({ msg, level }), 'continue', 'done');
  await sleep(10);
  assert.equal(calls.length, 1);
  assert.ok(notes.some((n) => n.msg === 'done' && n.level === 'info'));
  assert.ok(!notes.some((n) => n.level === 'error' || n.level === 'warning'));
});

test('resume retries once when the first send rejects, then succeeds silently', async () => {
  resetCompactionResumeStateForTests();
  setCompactionResumeRetryDelayForTests(1);
  const notes: Array<{ msg: string; level?: string }> = [];
  let attempts = 0;
  const { pi, calls } = makePi(() => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('busy'));
    return Promise.resolve();
  });
  scheduleCompactionContinuation(pi, ctx, (_c, msg, level) => notes.push({ msg, level }), 'continue', 'done');
  await sleep(30);
  assert.equal(calls.length, 2, 'retried once after the first rejection');
  assert.ok(!notes.some((n) => n.level === 'error' || n.level === 'warning'), 'no failure surfaced after a successful retry');
});

test('resume surfaces an actionable affordance when both attempts fail', async () => {
  resetCompactionResumeStateForTests();
  setCompactionResumeRetryDelayForTests(1);
  const notes: Array<{ msg: string; level?: string }> = [];
  const { pi, calls } = makePi(() => Promise.reject(new Error('down')));
  scheduleCompactionContinuation(pi, ctx, (_c, msg, level) => notes.push({ msg, level }), 'continue', 'done');
  await sleep(40);
  assert.equal(calls.length, 2, 'tried twice');
  const failure = notes.find((n) => n.level === 'warning');
  assert.ok(failure, 'a warning-level affordance is emitted');
  assert.match(failure!.msg, /type/i, 'tells the user to type to continue');
  assert.match(failure!.msg, /down/, 'includes the underlying error');
});
