import {
  authority,
  thinkFirst,
  workMode,
  tools,
  searchAndResearch,
  octocodeCli,
  skills,
  code,
  testing,
  docs,
  output,
  context,
  agents,
  browserAgent,
  safety,
} from './sections/index.js';

/** The full Octocode system prompt — sections in the order they appear below. */
export const SYSTEM_PROMPT =
  [
    authority,
    safety,
    workMode,
    thinkFirst,
    octocodeCli,
    skills,
    agents,
    tools,
    browserAgent,
    searchAndResearch,
    code,
    testing,
    docs,
    context,
    output,
  ].join('\n\n') + '\n';
