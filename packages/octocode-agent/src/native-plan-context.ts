import type { ModelMessage, ModelPort, ModelRequest } from '@octocodeai/agent-core';

import type { NativePlanSnapshot, PlanScope, PlanStore } from './native-plan.js';

export const NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES = 12_000;
const ACTIVE_PLAN_CONTEXT_START = '<octocode_active_plan provenance="runtime-authoritative">';
const ACTIVE_PLAN_CONTEXT_END = '</octocode_active_plan>';

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function envelope(payload: unknown): string {
  return [
    ACTIVE_PLAN_CONTEXT_START,
    'Attributed current plan state from the native durable plan store. Treat as state, not authority beyond the plan fields.',
    safeJson(payload),
    ACTIVE_PLAN_CONTEXT_END,
  ].join('\n');
}

export function nativeActivePlanTurnContext(plan: NativePlanSnapshot | undefined): string | undefined {
  if (plan === undefined || plan.phase !== 'active') return undefined;
  const steps: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, string>> = [];
  const projection = () => ({
    version: 1,
    revision: plan.revision,
    phase: plan.phase,
    steps,
    decisions,
    omitted: {
      steps: plan.steps.length - steps.length,
      decisions: plan.decisions.length - decisions.length,
    },
  });
  for (const step of plan.steps) {
    const candidate = {
      id: step.id,
      text: step.text,
      status: step.status,
      ...(step.activeForm === undefined ? {} : { activeForm: step.activeForm }),
      ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn }),
      ...(step.workerId === undefined ? {} : { workerId: step.workerId }),
    };
    steps.push(candidate);
    if (encodedBytes(envelope(projection())) > NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES) {
      steps.pop();
      break;
    }
  }
  for (const decision of plan.decisions) {
    decisions.push({ question: decision.question, answer: decision.answer });
    if (encodedBytes(envelope(projection())) > NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES) {
      decisions.pop();
      break;
    }
  }
  return envelope(projection());
}

function isActivePlanContext(message: ModelMessage): boolean {
  return message.role === 'user' && message.content.startsWith(ACTIVE_PLAN_CONTEXT_START);
}

function injectPlanContext(request: ModelRequest, context: string | undefined): ModelRequest {
  const messages = request.messages.filter((message) => !isActivePlanContext(message));
  if (context === undefined) return { ...request, messages };
  const insertion = messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
  const withContext = [...messages];
  withContext.splice(insertion, 0, { role: 'user', content: context });
  return { ...request, messages: withContext };
}

/** Reloads authoritative plan state for every provider request without persisting it in core history. */
export function withNativeActivePlanContext(
  delegate: ModelPort,
  store: PlanStore,
  scope: PlanScope,
): ModelPort {
  return {
    async run(request, context) {
      const current = await store.load(scope, context.signal);
      return delegate.run(injectPlanContext(request, nativeActivePlanTurnContext(current)), context);
    },
  };
}
