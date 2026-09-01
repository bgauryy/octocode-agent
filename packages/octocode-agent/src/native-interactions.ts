import {
  createEffectSet,
  MAX_UI_INTERACTION_OPTIONS,
  MAX_UI_WORKFLOW_STEPS,
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
  readonly type: 'select' | 'input' | 'editor' | 'confirm';
  readonly question: string;
  readonly options?: readonly string[];
  readonly initial?: string;
  readonly timeoutMs?: number;
};

type AskQuestion = Omit<AskUserInput, 'timeoutMs'> & { readonly id: string };
type AskWorkflowInput = {
  readonly title?: string;
  readonly instructions?: string;
  readonly questions: readonly AskQuestion[];
  readonly timeoutMs?: number;
};

const MAX_ASK_QUESTIONS = MAX_UI_WORKFLOW_STEPS;
let nextAskWorkflowId = 1;

function parseQuestion(value: unknown): AskQuestion | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const parsed = parseAskUserInput({ ...record, timeoutMs: undefined });
  if (parsed === undefined || typeof record.id !== 'string' || !record.id.trim()) return undefined;
  return { ...parsed, id: record.id };
}

function parseAskWorkflowInput(value: unknown): AskWorkflowInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > MAX_ASK_QUESTIONS) return undefined;
  if (input.title !== undefined && typeof input.title !== 'string') return undefined;
  if (input.instructions !== undefined && typeof input.instructions !== 'string') return undefined;
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) return undefined;
  const questions = input.questions.map(parseQuestion);
  if (questions.some((question) => question === undefined)) return undefined;
  const ids = questions.map((question) => question!.id);
  if (new Set(ids).size !== ids.length) return undefined;
  return {
    questions: questions as AskQuestion[],
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(typeof input.instructions === 'string' ? { instructions: input.instructions } : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
  };
}

function parseAskUserInput(value: unknown): AskUserInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if ((input.type !== 'select' && input.type !== 'input' && input.type !== 'editor' && input.type !== 'confirm') || typeof input.question !== 'string') return undefined;
  if (input.initial !== undefined && typeof input.initial !== 'string') return undefined;
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) return undefined;
  if (input.type === 'select' && (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > MAX_UI_INTERACTION_OPTIONS || !input.options.every((option) => typeof option === 'string'))) return undefined;
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
    case 'editor': return { type: 'editor', message: input.question, initial: input.initial ?? '' };
  }
}

async function runAskWorkflow(
  input: AskWorkflowInput,
  broker: NativeInteractionBroker,
  signal: AbortSignal,
): Promise<unknown> {
  const workflowId = `ask-${nextAskWorkflowId++}`;
  const answers: { readonly id: string; readonly value: string | boolean }[] = [];
  for (const [index, question] of input.questions.entries()) {
    const workflow = {
      workflowId,
      questionId: question.id,
      index,
      total: input.questions.length,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      allowDiscuss: true,
    } as const;
    const request = { ...interactionRequest(question), workflow } as UiInteractionRequest;
    const result = await broker.interact(request, signal, input.timeoutMs);
    if (result.status === 'discuss') {
      return {
        status: 'discuss',
        question: { id: question.id, question: question.question },
        answers,
        remainingQuestionIds: input.questions.slice(index).map(({ id }) => id),
      };
    }
    if (result.status !== 'accepted') return { status: result.status, answers };
    if (typeof result.value !== 'string' && typeof result.value !== 'boolean') {
      return { status: 'unsupported', reason: 'Renderer returned an invalid answer', answers };
    }
    answers.push({ id: question.id, value: result.value });
  }
  return { status: 'answered', answers };
}

export function registerNativeAskUserTool(
  registry: ToolRegistry,
  broker: NativeInteractionBroker,
): void {
  registry.register({
    name: 'askUser',
    label: 'Ask user',
    description: 'Ask one question or a bounded sequence. Workflows show one question at a time and let the user answer, discuss, or cancel.',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      anyOf: [
        { required: ['type', 'question'] },
        { required: ['questions'] },
      ],
      properties: {
        type: { type: 'string', enum: ['select', 'input', 'editor', 'confirm'] },
        question: { type: 'string' },
        options: { type: 'array', minItems: 1, maxItems: MAX_UI_INTERACTION_OPTIONS, items: { type: 'string' } },
        initial: { type: 'string' },
        timeoutMs: { type: 'number' },
        title: { type: 'string' },
        instructions: { type: 'string' },
        questions: {
          type: 'array', minItems: 1, maxItems: MAX_ASK_QUESTIONS,
          items: {
            type: 'object', required: ['id', 'type', 'question'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['select', 'input', 'editor', 'confirm'] },
              question: { type: 'string' },
              options: { type: 'array', minItems: 1, maxItems: MAX_UI_INTERACTION_OPTIONS, items: { type: 'string' } },
              initial: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan: 'allowed' },
    presentation: { callLabel: 'Question', resultLabel: 'Answer' },
    async execute({ input, signal }) {
      const workflow = parseAskWorkflowInput(input);
      if (workflow !== undefined) {
        return { ok: true, content: await runAskWorkflow(workflow, broker, signal), detailsVersion: 1 };
      }
      const parsed = parseAskUserInput(input);
      if (parsed === undefined) {
        return { ok: false, content: { status: 'unsupported', reason: 'Invalid askUser input' }, category: 'validation', detailsVersion: 1 };
      }
      const content = await broker.interact(interactionRequest(parsed), signal, parsed.timeoutMs);
      return { ok: true, content, detailsVersion: 1 };
    },
  }, 'native-interactions');
}
