import {
  createEffectSet,
  type ToolRegistry,
  type UiInteractionRequest,
  type UiInteractionResult,
} from '@octocodeai/agent-core';

export type NativeInteractionHandler = (
  request: UiInteractionRequest,
  signal: AbortSignal,
) => Promise<UiInteractionResult>;

export interface NativeInteractionBroker {
  attach(handler: NativeInteractionHandler): () => void;
  interact(request: UiInteractionRequest, signal: AbortSignal, timeoutMs?: number): Promise<UiInteractionResult>;
}

export interface NativeInteractionBrokerOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_INTERACTION_TIMEOUT_MS = 120_000;

function timeoutResult(reason: unknown): UiInteractionResult {
  return typeof reason === 'string' && reason.toLowerCase().includes('timeout')
    ? { status: 'timeout' }
    : { status: 'cancelled' };
}

export function createNativeInteractionBroker(
  options: NativeInteractionBrokerOptions = {},
): NativeInteractionBroker {
  let handler: NativeInteractionHandler | undefined;
  let generation = 0;
  const defaultTimeout = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs!
    : DEFAULT_INTERACTION_TIMEOUT_MS;

  return {
    attach(next) {
      handler = next;
      const attachedGeneration = ++generation;
      return () => {
        if (generation === attachedGeneration) handler = undefined;
      };
    },
    async interact(request, signal, timeoutMs = defaultTimeout) {
      const current = handler;
      if (current === undefined) return { status: 'unsupported' };
      if (signal.aborted) return timeoutResult(signal.reason);

      const controller = new AbortController();
      let timedOut = false;
      const relayAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', relayAbort, { once: true });
      const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeout;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('interaction timeout');
      }, duration);
      const aborted = new Promise<UiInteractionResult>((resolve) => {
        controller.signal.addEventListener('abort', () => {
          resolve(timedOut ? { status: 'timeout' } : timeoutResult(controller.signal.reason));
        }, { once: true });
      });
      const handled = Promise.resolve()
        .then(() => current(request, controller.signal))
        .catch((error: unknown): UiInteractionResult => {
          if (controller.signal.aborted) {
            return timedOut ? { status: 'timeout' } : timeoutResult(controller.signal.reason);
          }
          throw error;
        });
      try {
        return await Promise.race([handled, aborted]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relayAbort);
      }
    },
  };
}

type AskUserInput = {
  readonly type: 'select' | 'input' | 'confirm';
  readonly question: string;
  readonly options?: readonly string[];
  readonly initial?: string;
  readonly timeoutMs?: number;
};

function parseAskUserInput(value: unknown): AskUserInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if ((input.type !== 'select' && input.type !== 'input' && input.type !== 'confirm') || typeof input.question !== 'string') return undefined;
  if (input.initial !== undefined && typeof input.initial !== 'string') return undefined;
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) return undefined;
  if (input.type === 'select' && (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 100 || !input.options.every((option) => typeof option === 'string'))) return undefined;
  if (input.type !== 'select' && input.options !== undefined) return undefined;
  return {
    type: input.type,
    question: input.question,
    ...(input.type === 'select' ? { options: [...input.options as string[]] } : {}),
    ...(typeof input.initial === 'string' ? { initial: input.initial } : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
  };
}

function interactionRequest(input: AskUserInput): UiInteractionRequest {
  switch (input.type) {
    case 'confirm': return { type: 'confirm', message: input.question };
    case 'select': return { type: 'select', message: input.question, options: input.options ?? [] };
    case 'input': return { type: 'input', message: input.question, ...(input.initial === undefined ? {} : { initial: input.initial }) };
  }
}

export function registerNativeAskUserTool(
  registry: ToolRegistry,
  broker: NativeInteractionBroker,
): void {
  registry.register({
    name: 'askUser',
    label: 'Ask user',
    description: 'Ask the user to confirm, select an option, or enter free text.',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      required: ['type', 'question'],
      properties: {
        type: { type: 'string', enum: ['select', 'input', 'confirm'] },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        initial: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan: 'allowed' },
    presentation: { callLabel: 'Question', resultLabel: 'Answer' },
    async execute({ input, signal }) {
      const parsed = parseAskUserInput(input);
      if (parsed === undefined) {
        return { ok: false, content: { status: 'unsupported', reason: 'Invalid askUser input' }, category: 'validation', detailsVersion: 1 };
      }
      const content = await broker.interact(interactionRequest(parsed), signal, parsed.timeoutMs);
      return { ok: true, content, detailsVersion: 1 };
    },
  }, 'native-interactions');
}
