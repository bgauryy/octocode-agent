import type { ContextSegmentV1 } from '@octocodeai/octocode-awareness';

export type PromptPlacement = 'frozen-system' | 'turn-context' | 'transcript';
export interface PromptLifecycleRuleV1 {
  version: 1;
  placement: PromptPlacement;
  mutable: boolean;
  delivery: 'once' | 'on-change' | 'on-trigger' | 'every-turn';
  reason: string;
}

export const PROMPT_LIFECYCLE_MATRIX: Readonly<Record<ContextSegmentV1['kind'], PromptLifecycleRuleV1>> = Object.freeze({
  'product-policy': { version: 1, placement: 'frozen-system', mutable: false, delivery: 'once', reason: 'cache-stable harness authority' },
  'project-instruction': { version: 1, placement: 'frozen-system', mutable: false, delivery: 'once', reason: 'session-scoped repository instructions' },
  'tool-contract': { version: 1, placement: 'frozen-system', mutable: false, delivery: 'once', reason: 'session tool inventory contract' },
  skill: { version: 1, placement: 'frozen-system', mutable: false, delivery: 'on-trigger', reason: 'inventory frozen; bodies loaded on trigger' },
  plan: { version: 1, placement: 'turn-context', mutable: true, delivery: 'on-change', reason: 'durable domain state can evolve' },
  'memory-lead': { version: 1, placement: 'turn-context', mutable: true, delivery: 'on-trigger', reason: 'retrieval is attributed evidence' },
  'tool-result': { version: 1, placement: 'transcript', mutable: false, delivery: 'on-trigger', reason: 'result belongs to its call' },
  'peer-event': { version: 1, placement: 'turn-context', mutable: true, delivery: 'on-trigger', reason: 'inbound data is policy-filtered before delivery' },
  'user-request': { version: 1, placement: 'transcript', mutable: false, delivery: 'on-trigger', reason: 'operator input remains attributable' },
});

export function promptLifecycleFor(kind: ContextSegmentV1['kind']): PromptLifecycleRuleV1 {
  return PROMPT_LIFECYCLE_MATRIX[kind];
}
