import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('shared-definition ownership', () => {
  it('keeps consumer prompt modules as adapters instead of policy copies', () => {
    const piPrompt = source('../../octocode-pi-extension/src/prompts/prompt.ts');
    const piPlan = source('../../octocode-pi-extension/src/prompts/plan-prompt.ts');
    expect(piPrompt).not.toContain('const authority =');
    expect(piPrompt).toContain('@octocodeai/octocode-shared/prompts');
    expect(piPlan).not.toContain('[PLAN MODE]');
    expect(piPlan).toContain('@octocodeai/octocode-shared/prompts');
  });

  it('keeps persisted Awareness records in the shared entity module', () => {
    const plans = source('../../octocode-awareness/src/plans.ts');
    const tasks = source('../../octocode-awareness/src/tasks-catalog.ts');
    expect(plans).not.toMatch(/export (?:type|interface) PlanRecord/);
    expect(tasks).not.toMatch(/export (?:type|interface) PlanTaskRecord/);
    expect(plans).toContain('@octocodeai/octocode-shared/entities');
    expect(tasks).toContain('@octocodeai/octocode-shared/entities');
  });

  it('keeps permission and prompt-mode unions out of host adapters', () => {
    const approval = source('../../octocode-pi-extension/src/tools/approval.ts');
    const piTypes = source('../../octocode-pi-extension/src/types.ts');
    const nativePrompt = source('../../octocode-agent/src/native-prompt.ts');
    expect(approval).not.toContain("export type PermissionLevel =");
    expect(piTypes).not.toContain("export type PromptMode =");
    expect(nativePrompt).not.toContain("OCTOCODE_PROMPT_MODE = 'octocode-first'");
  });
});
