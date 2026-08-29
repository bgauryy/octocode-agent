import { EXTERNAL_AGENT_AWARENESS_PROMPT } from '@octocodeai/octocode-awareness';
import { buildOctocodeSystemPrompt } from '@octocodeai/octocode-shared/prompts';

/** Pi binds the shared Octocode policy to Awareness's coordination contract. */
export const SYSTEM_PROMPT = buildOctocodeSystemPrompt(EXTERNAL_AGENT_AWARENESS_PROMPT);
