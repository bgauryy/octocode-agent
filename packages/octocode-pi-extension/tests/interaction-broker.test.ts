import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { InteractionAnswerV1, InteractionRequestV1 } from '@octocodeai/octocode-awareness';
import { answerPendingInteraction, createPendingInteraction, setInteractionStoreFactoryForTests } from '../src/tools/interaction-broker.js';
import type { PiContext } from '../src/types.js';

afterEach(() => setInteractionStoreFactoryForTests());

test('TUI and RPC broker requests use the same host-neutral payload', () => {
  const requests: InteractionRequestV1[] = [];
  const answers: InteractionAnswerV1[] = [];
  setInteractionStoreFactoryForTests(() => ({
    createInteraction: (request) => requests.push(request),
    answerInteraction: (answer) => answers.push(answer),
    close: () => undefined,
  }));
  const base = { cwd: '/repo', sessionManager: { getSessionId: () => 'session-1' } };
  const params = { question: 'Choose?', options: [{ id: 'safe', label: 'Safe', recommended: true }] };
  const tui = createPendingInteraction({ ...base, mode: 'tui' } as PiContext, params);
  const rpc = createPendingInteraction({ ...base, mode: 'rpc' } as PiContext, params);
  assert.deepEqual(
    { ...tui, interactionId: '', correlationId: '', createdAt: '', expiresAt: '' },
    { ...rpc, interactionId: '', correlationId: '', createdAt: '', expiresAt: '' },
  );
  const answer = answerPendingInteraction(rpc, { status: 'selected', value: 'safe' });
  assert.deepEqual(answer.optionIds, ['safe']);
  assert.equal(answers.length, 1);
  assert.equal(requests.length, 2);
});

test('cancellation remains explicit and never selects a recommended default', () => {
  let answer: InteractionAnswerV1 | undefined;
  setInteractionStoreFactoryForTests(() => ({
    createInteraction: () => undefined,
    answerInteraction: (value) => { answer = value; },
    close: () => undefined,
  }));
  const request = createPendingInteraction({ cwd: '/repo', mode: 'rpc' } as PiContext, {
    question: 'Deploy?', options: [{ id: 'yes', label: 'Yes', recommended: true }],
  });
  answerPendingInteraction(request, { status: 'cancelled' });
  assert.equal(answer?.cancelled, true);
  assert.equal(answer?.optionIds, undefined);
});
