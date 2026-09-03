import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('shared-definition ownership', () => {
  it('keeps the native prompt module as an adapter instead of a policy copy', () => {
    const nativePrompt = source('../../octocode-agent/src/native-prompt.ts');
    expect(nativePrompt).not.toContain('const authority =');
    expect(nativePrompt).toContain('@octocodeai/octocode-shared/prompts');
  });

  it('keeps persisted Awareness records in the shared entity module', () => {
    const plans = source('../../octocode-awareness/src/plans.ts');
    const tasks = source('../../octocode-awareness/src/tasks-catalog.ts');
    expect(plans).not.toMatch(/export (?:type|interface) PlanRecord/);
    expect(tasks).not.toMatch(/export (?:type|interface) PlanTaskRecord/);
    expect(plans).toContain('@octocodeai/octocode-shared/entities');
    expect(tasks).toContain('@octocodeai/octocode-shared/entities');
  });

  it('keeps prompt-mode policy out of the native host adapter', () => {
    const nativePrompt = source('../../octocode-agent/src/native-prompt.ts');
    expect(nativePrompt).not.toContain("OCTOCODE_PROMPT_MODE = 'octocode-first'");
  });
});
