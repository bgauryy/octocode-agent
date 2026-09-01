import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeKernel,
  assertRuntimeUserInputV1,
  sessionId,
  type LifecycleDispatchResult,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeUserInputV1,
} from '../src/index.js';

const imageInput = (filename = 'pixel.png'): RuntimeUserInputV1 => ({
  schemaVersion: 1,
  parts: [
    { type: 'text', text: 'before ' },
    { type: 'image', mediaType: 'image/png', data: { encoding: 'base64', value: 'iVBORw0KGgo=' }, byteLength: 8, filename },
    { type: 'text', text: ' after' },
  ],
});

describe('runtime multimodal input', () => {
  it('preserves ordered parts while lifecycle events expose metadata but not bytes', async () => {
    const requests: ModelRequest[] = [];
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('multimodal'),
      model: { run: async (request) => { requests.push(structuredClone(request)); return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } },
      emit: async (event) => { events.push(structuredClone(event)); },
    });
    await kernel.submit(imageInput());

    expect(requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'before  after', userInput: imageInput() });
    const received = events.find((event) => event.type === 'input.received')!;
    expect(received.payload).toEqual({
      text: 'before  after',
      attachments: [{ schemaVersion: 1, type: 'image', partIndex: 1, mediaType: 'image/png', byteLength: 8, filename: 'pixel.png' }],
    });
    expect(JSON.stringify(received)).not.toContain('iVBORw0KGgo=');
  });

  it('preserves multimodal follow-up and steer payloads through their queues', async () => {
    const requests: ModelRequest[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = vi.fn();
    const kernel = new RuntimeKernel({
      sessionId: sessionId('multimodal-queue'),
      model: { run: async (request, context) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          entered();
          await Promise.race([blocked, new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))]);
          if (context.signal.aborted) return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    const active = kernel.submit('first');
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    await kernel.execute({ type: 'input.steer', input: imageInput() });
    await active;
    const steered = requests.at(-1)!.messages.at(-1);
    expect(steered).toMatchObject({ userInput: imageInput() });
    release();
  });

  it('retains image parts when a legacy context hook rewrites only role and content', async () => {
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('multimodal-context-rewrite'),
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'context.preparing') return;
        const payload = event.payload as { iteration: number; messages: ModelRequest['messages'] };
        return {
          payload: {
            ...payload,
            messages: payload.messages.map((message, index) =>
              index === payload.messages.length - 1
                ? { role: 'user' as const, content: 'rewritten text' }
                : message),
          },
          decision: { kind: 'continue' },
          context: [],
          suppressed: false,
          receipts: [],
        };
      },
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await kernel.submit(imageInput());

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'rewritten text',
      userInput: {
        ...imageInput(),
        parts: [
          { type: 'text', text: 'rewritten text' },
          imageInput().parts[1],
        ],
      },
    });
  });

  it('rejects an explicitly replaced userInput that disagrees with rewritten content', async () => {
    const run = vi.fn();
    const kernel = new RuntimeKernel({
      sessionId: sessionId('multimodal-context-invalid-rewrite'),
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'context.preparing') return;
        const payload = event.payload as { iteration: number; messages: ModelRequest['messages'] };
        return {
          payload: {
            ...payload,
            messages: payload.messages.map((message, index) =>
              index === payload.messages.length - 1
                ? { role: 'user' as const, content: 'does not match', userInput: imageInput('replacement.png') }
                : message),
          },
          decision: { kind: 'continue' },
          context: [],
          suppressed: false,
          receipts: [],
        };
      },
      model: { run },
    });

    await expect(kernel.submit(imageInput())).rejects.toThrow(
      'context.preparing lifecycle payload requires valid messages',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed for noncanonical, mismatched, or unsupported image payloads', () => {
    expect(() => assertRuntimeUserInputV1({ schemaVersion: 1, parts: [
      { type: 'image', mediaType: 'image/svg+xml', data: { encoding: 'base64', value: 'AQID' }, byteLength: 3 },
    ] })).toThrow('Unsupported image media type');
    expect(() => assertRuntimeUserInputV1({ schemaVersion: 1, parts: [
      { type: 'image', mediaType: 'image/png', data: { encoding: 'base64', value: 'AQID' }, byteLength: 2 },
    ] })).toThrow('byteLength');
    expect(() => assertRuntimeUserInputV1({ schemaVersion: 1, parts: [
      { type: 'image', mediaType: 'image/png', data: { encoding: 'base64', value: 'AQID' }, byteLength: 3 },
    ] })).toThrow('file signature');
    expect(() => assertRuntimeUserInputV1({ schemaVersion: 1, parts: [
      { type: 'image', mediaType: 'image/jpeg', data: { encoding: 'base64', value: '//9=' }, byteLength: 2 },
    ] })).toThrow('canonical base64');
  });
});
