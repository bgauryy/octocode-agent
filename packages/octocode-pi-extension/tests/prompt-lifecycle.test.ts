import { describe, expect, it } from 'vitest';
import { PROMPT_LIFECYCLE_MATRIX, promptLifecycleFor } from '../src/tools/prompt-lifecycle.js';

describe('prompt lifecycle matrix', () => {
  it('classifies every context kind exactly once', () => {
    expect(Object.keys(PROMPT_LIFECYCLE_MATRIX).sort()).toEqual([
      'memory-lead', 'peer-event', 'plan', 'product-policy', 'project-instruction', 'skill', 'tool-contract', 'tool-result', 'user-request',
    ]);
  });

  it('keeps cacheable contracts frozen and mutable state out of frozen bytes', () => {
    for (const kind of ['product-policy', 'project-instruction', 'tool-contract', 'skill'] as const) {
      expect(promptLifecycleFor(kind).placement).toBe('frozen-system');
      expect(promptLifecycleFor(kind).mutable).toBe(false);
    }
    for (const kind of ['plan', 'peer-event', 'memory-lead'] as const) {
      expect(promptLifecycleFor(kind).placement).not.toBe('frozen-system');
    }
  });
});
