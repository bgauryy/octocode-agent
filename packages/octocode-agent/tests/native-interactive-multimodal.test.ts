import { PassThrough } from 'node:stream';

import {
  RuntimeKernel,
  ToolRegistry,
  assertRuntimeUserInputV1,
  sessionId,
  type ModelRequest,
} from '@octocodeai/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { runNativeInteractiveController } from '../src/native-interactive-controller.js';
import type {
  NativeInteractivePresentationPort,
  NativePresentationInputEvent,
  NativePresentationWorkingState,
} from '../src/presentation/contracts.js';

const PNG_BASE64 = 'iVBORw0KGgoAAA==';

describe('native interactive multimodal routing', () => {
  it('preserves ordered image input from the presentation event through the runtime provider request', async () => {
    const requests: ModelRequest[] = [];
    const runtime = new RuntimeKernel({
      sessionId: sessionId('s-native-image-input'),
      cwd: '/workspace',
      trust: { workspace: 'trusted', managedOnly: false },
      approve: async () => true,
      tools: new ToolRegistry(),
      model: {
        run: async (request) => {
          requests.push(request);
          return {
            stop: 'complete',
            text: 'seen',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    let working: NativePresentationWorkingState = 'idle';
    let inputListener:
      | ((event: NativePresentationInputEvent) => void | Promise<void>)
      | undefined;
    const terminal: NativeInteractivePresentationPort = {
      inputOwnership: 'renderer',
      start: vi.fn(async () => undefined),
      accept: (event) => {
        if (event.type === 'presentation-changed' && event.property === 'working')
          working = event.value;
      },
      acceptInput: () => false,
      subscribeInput: (listener) => {
        inputListener = listener;
        return () => { inputListener = undefined; };
      },
      subscribeFailure: () => () => undefined,
      cancelInteraction: () => false,
      snapshot: () => ({ working }),
      stop: vi.fn(async () => undefined),
    };
    const controller = runNativeInteractiveController({
      runtime,
      terminal,
      interactions: {
        attach: () => () => undefined,
        interact: async () => ({ status: 'unsupported' }),
      },
      input: new PassThrough(),
      signalSource: { on: vi.fn(), off: vi.fn() },
    });
    await vi.waitFor(() => expect(inputListener).toBeTypeOf('function'));
    const input = assertRuntimeUserInputV1({
      schemaVersion: 1,
      parts: [
        { type: 'text', text: 'inspect ' },
        {
          type: 'image',
          mediaType: 'image/png',
          data: { encoding: 'base64', value: PNG_BASE64 },
          byteLength: Buffer.from(PNG_BASE64, 'base64').byteLength,
          filename: 'screen.png',
        },
        { type: 'text', text: ' please' },
      ],
    });

    await inputListener!({ type: 'input', input });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await inputListener!({ type: 'interrupt' });
    await expect(controller).resolves.toBe(0);

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'inspect  please',
      userInput: input,
    });
  });
});
