import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ToolExecutionInput, type UiInteractionRequest } from '@octocodeai/agent-core';

import {
  createNativeInteractionBroker,
  registerNativeAskUserTool,
} from '../src/native-interactions.js';

function execution(input: unknown, signal = new AbortController().signal): ToolExecutionInput {
  return {
    input,
    callId: 'ask:1' as never,
    context: {
      sessionId: 'session:1' as never,
      turnId: 'turn:1' as never,
      cwd: '/workspace',
      mode: 'interactive',
      trust: { workspace: 'unknown', managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe('native interaction broker and askUser tool', () => {
  it('registers a read/no-effect askUser contract and never hangs headless', async () => {
    const registry = new ToolRegistry();
    const broker = createNativeInteractionBroker({ timeoutMs: 25 });
    registerNativeAskUserTool(registry, broker);
    const tool = registry.get('askUser')!;

    expect(tool.policy).toEqual({ effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' });
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      anyOf: [
        { required: ['type', 'question'] },
        { required: ['questions'] },
      ],
      properties: {
        type: { enum: ['select', 'input', 'editor', 'confirm'] },
        question: { type: 'string' },
        options: { type: 'array' },
      },
    });
    await expect(tool.execute(execution({ type: 'input', question: 'Name?' }))).resolves.toMatchObject({
      ok: true,
      content: { status: 'unsupported' },
      detailsVersion: 1,
    });
  });

  it('maps select, free-text, multiline editor, and confirm requests through one attached handler', async () => {
    const requests: UiInteractionRequest[] = [];
    const broker = createNativeInteractionBroker();
    broker.attach(async (request) => {
      requests.push(request);
      if (request.type === 'select') return { status: 'accepted', value: request.options[1] };
      if (request.type === 'confirm') return { status: 'accepted', value: true };
      return { status: 'accepted', value: 'octocode' };
    });
    const registry = new ToolRegistry();
    registerNativeAskUserTool(registry, broker);
    const ask = registry.get('askUser')!;

    const selected = await ask.execute(execution({ type: 'select', question: 'Pick', options: ['one', 'two'] }));
    const text = await ask.execute(execution({ type: 'input', question: 'Name?', initial: 'octo' }));
    const edited = await ask.execute(execution({ type: 'editor', question: 'Revise the plan', initial: 'Step 1' }));
    const confirmed = await ask.execute(execution({ type: 'confirm', question: 'Continue?' }));

    expect([selected.content, text.content, edited.content, confirmed.content]).toEqual([
      { status: 'accepted', value: 'two' },
      { status: 'accepted', value: 'octocode' },
      { status: 'accepted', value: 'octocode' },
      { status: 'accepted', value: true },
    ]);
    expect(requests).toEqual([
      { type: 'select', message: 'Pick', options: ['one', 'two'] },
      { type: 'input', message: 'Name?', initial: 'octo' },
      { type: 'editor', message: 'Revise the plan', initial: 'Step 1' },
      { type: 'confirm', message: 'Continue?' },
    ]);
  });

  it('runs bounded question workflows one question at a time and returns an ordered answer ledger', async () => {
    const requests: UiInteractionRequest[] = [];
    const broker = createNativeInteractionBroker();
    broker.attach(async (request) => {
      requests.push(request);
      return request.type === 'confirm'
        ? { status: 'accepted', value: true }
        : { status: 'accepted', value: request.type === 'select' ? request.options[0] : 'typed answer' };
    });
    const registry = new ToolRegistry();
    registerNativeAskUserTool(registry, broker);

    const result = await registry.get('askUser')!.execute(execution({
      title: 'Implementation choices',
      instructions: 'Answer what is known; choose Discuss when context is missing.',
      questions: [
        { id: 'runtime', type: 'select', question: 'Runtime?', options: ['Rust', 'TypeScript'] },
        { id: 'confirm', type: 'confirm', question: 'Proceed?' },
      ],
    }));

    expect(result.content).toEqual({
      status: 'answered',
      answers: [
        { id: 'runtime', value: 'Rust' },
        { id: 'confirm', value: true },
      ],
    });
    expect(requests).toEqual([
      expect.objectContaining({
        type: 'select', message: 'Runtime?',
        workflow: expect.objectContaining({ questionId: 'runtime', index: 0, total: 2, allowDiscuss: true }),
      }),
      expect.objectContaining({
        type: 'confirm', message: 'Proceed?',
        workflow: expect.objectContaining({ questionId: 'confirm', index: 1, total: 2, allowDiscuss: true }),
      }),
    ]);
  });

  it('stops a question workflow at Discuss and preserves prior answers for the model', async () => {
    const broker = createNativeInteractionBroker();
    let call = 0;
    broker.attach(async () => (++call === 1
      ? { status: 'accepted', value: 'TypeScript' }
      : { status: 'discuss' }));
    const registry = new ToolRegistry();
    registerNativeAskUserTool(registry, broker);

    const result = await registry.get('askUser')!.execute(execution({
      questions: [
        { id: 'interface', type: 'input', question: 'Interface?' },
        { id: 'storage', type: 'input', question: 'Storage?' },
        { id: 'rendering', type: 'input', question: 'Rendering?' },
      ],
    }));

    expect(result.content).toEqual({
      status: 'discuss',
      question: { id: 'storage', question: 'Storage?' },
      answers: [{ id: 'interface', value: 'TypeScript' }],
      remainingQuestionIds: ['storage', 'rendering'],
    });
  });

  it('settles cancellation, timeout, and caller abort even when a handler ignores its signal', async () => {
    const never = () => new Promise<never>(() => undefined);
    const broker = createNativeInteractionBroker({ timeoutMs: 10 });
    broker.attach(never);
    await expect(broker.interact({ type: 'input', message: 'wait' }, new AbortController().signal))
      .resolves.toEqual({ status: 'timeout' });

    const abortBroker = createNativeInteractionBroker({ timeoutMs: 1_000 });
    abortBroker.attach(never);
    const controller = new AbortController();
    const pending = abortBroker.interact({ type: 'confirm', message: 'wait' }, controller.signal);
    controller.abort('caller cancelled');
    await expect(pending).resolves.toEqual({ status: 'cancelled' });

    const cancelBroker = createNativeInteractionBroker();
    cancelBroker.attach(async () => ({ status: 'cancelled' }));
    await expect(cancelBroker.interact({ type: 'select', message: 'pick', options: ['a'] }, new AbortController().signal))
      .resolves.toEqual({ status: 'cancelled' });
  });

  it('propagates handler failures instead of disguising them as unsupported capability', async () => {
    const broker = createNativeInteractionBroker();
    broker.attach(async () => { throw new Error('renderer callback failed'); });

    await expect(broker.interact(
      { type: 'confirm', message: 'continue?' },
      new AbortController().signal,
    )).rejects.toThrow('renderer callback failed');
  });
});
