import { AWARENESS_COMMANDS } from './commands-spec.js';

/** Static policy fragment for agent hosts; operational detail stays in tool schemas. */
export const EXTERNAL_AGENT_AWARENESS_PROMPT = `<awareness>
Awareness coordinates shared repositories. Treat its ledger as coordination evidence, not code truth.
- The only automatic model-facing signal is an unread direct peer-message. On signal, use message read (action:read), act on decision-changing content, then continue.
- Plan owns session and shared plans, task projection, observed check receipts, and completion debt. Do not duplicate those concerns or invent results.
- Advisory presence is automatic, and mutation-time peer locks are enforced automatically. Use lock only for exceptional non-mergeable exclusivity; inspect or wait on conflict, message when needed, and release it.
- Inspect peers or ownership only when shared state can change the next action. Use message for overlap, blockers, or decisions; use memory only when verified learning can change the approach. Never edit through a peer lock or take over another owner.
</awareness>`;

/** Live agent guide assembled from the command metadata used by CLI and Pi. */
export function getExternalAgentAwarenessGuide(): {
  prompt: string;
  commands: Array<{ command: string; actions: string[]; summary: string }>;
} {
  return {
    prompt: EXTERNAL_AGENT_AWARENESS_PROMPT,
    commands: AWARENESS_COMMANDS.map((group) => ({
      command: group.cli,
      actions: group.actions.map((action) => action.action),
      summary: group.summary,
    })),
  };
}

/** Dynamic identity context hosts can append without duplicating usage policy. */
export function formatExternalAgentCoordinationContext(input: {
  selfId: string;
  parentId?: string;
  peerIds?: string[];
}): string {
  const peers = [...new Set((input.peerIds ?? []).filter((id) => id && id !== input.selfId))];
  return [
    'Awareness coordination identity:',
    `- your agent id: ${input.selfId}`,
    input.parentId ? `- parent agent id: ${input.parentId}` : undefined,
    peers.length ? `- peers: ${peers.join(', ')}` : '- peers: none yet (use agent list when discovery matters)',
    '- use the host Awareness tools or `octocode-awareness guide`; do not invent host-specific coordination commands.',
  ].filter((line): line is string => Boolean(line)).join('\n');
}
