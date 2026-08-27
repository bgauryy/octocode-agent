/**
 * Machine-readable command contract for Awareness — the SINGLE SOURCE OF
 * TRUTH for the CLI verbs and their parameters. Hosts embedding this package
 * import `AWARENESS_COMMANDS` to GENERATE typed,
 * discriminated tool schemas and CLI arg-vectors from it, instead of
 * hand-duplicating the flag shapes. Keep this in sync with `cli.ts`'s parser.
 *
 * Each group maps to a CLI noun (`cli`); each action maps to `<cli> <action>`
 * (or just `<cli>` when `singleton`). A param declares its tool-facing camelCase
 * `name`, its CLI `flag` (kebab, no leading `--`), its `type`, whether it is
 * `required`, and a `description`. `durationMs: true` means the host sends an
 * integer of milliseconds and the value is emitted as `<n>ms` for the CLI's
 * duration parser. `needsAgentId` injects the current agent id under
 * `agentIdFlag` (default `agent-id`; `message send` uses `from`).
 */

export type CommandParamType = 'string' | 'integer' | 'boolean' | 'string[]';

export interface CommandParam {
  name: string;
  flag: string;
  type: CommandParamType;
  required?: boolean;
  enum?: readonly string[];
  description: string;
  min?: number;
  max?: number;
  durationMs?: boolean;
}

export interface CommandAction {
  action: string;
  summary: string;
  /** Inject the current agent id (host-owned) as a flag. */
  needsAgentId?: boolean;
  /** Flag name for the injected agent id (default `agent-id`). */
  agentIdFlag?: string;
  params: readonly CommandParam[];
}

export interface CommandGroup {
  /** Tool/resource name exposed to hosts, e.g. `lock`, `agent`. */
  resource: string;
  /** Canonical CLI noun, e.g. `lock`, `check`, or `agent`. */
  cli: string;
  label: string;
  summary: string;
  /** A single read with no action discriminator (e.g. status). */
  singleton?: boolean;
  actions: readonly CommandAction[];
}

const P = {
  file: (required = true): CommandParam => ({ name: 'file', flag: 'file', type: 'string', required, description: 'Workspace-relative file path.' }),
  reason: (): CommandParam => ({ name: 'reason', flag: 'reason', type: 'string', description: 'Short human reason.' }),
  ttl: (): CommandParam => ({ name: 'ttlSeconds', flag: 'ttl', type: 'integer', min: 1, max: 3600, description: 'Lease seconds (default 1800).' }),
  taskId: (required = true): CommandParam => ({ name: 'taskId', flag: 'task-id', type: 'string', required, description: 'Task id.' }),
  planId: (required = false): CommandParam => ({ name: 'planId', flag: 'plan-id', type: 'string', required, description: 'Plan id.' }),
  lease: (): CommandParam => ({ name: 'leaseSeconds', flag: 'lease', type: 'integer', min: 1, max: 3600, description: 'Claim lease seconds.' }),
} as const;

export const AWARENESS_COMMANDS: readonly CommandGroup[] = [
  {
    resource: 'awarenessStatus', cli: 'status', label: 'Awareness', singleton: true,
    summary: 'Read active shared-repo counts without mutating stored rows: plans, ready/in-progress tasks, verification debt, locks, work presence, peers, and messages. Use when peer state can change the next action.',
    actions: [
      { action: 'status', summary: 'read the snapshot', params: [{ name: 'staleAfterMs', flag: 'stale-after', type: 'integer', min: 1000, durationMs: true, description: 'Optional window (ms) for counting stale peers.' }] },
    ],
  },
  {
    resource: 'lock', cli: 'lock', label: 'Lock',
    summary: 'Advisory exclusive file locks for non-mergeable edits, shared across all coding agents in this repo. Lock only genuinely non-mergeable state; use work presence for ordinary declaration.',
    actions: [
      { action: 'acquire', summary: 'claim a file lock', needsAgentId: true, params: [P.file(), P.reason(), P.ttl()] },
      { action: 'release', summary: 'release a lock you own', needsAgentId: true, params: [P.file()] },
      { action: 'wait', summary: 'block until a peer-held lock frees', needsAgentId: true, params: [P.file(), { name: 'waitMs', flag: 'wait', type: 'integer', min: 0, max: 60000, durationMs: true, description: 'Max ms to wait for the lock to free (0 = check now).' }] },
      { action: 'list', summary: 'list active locks', params: [] },
    ],
  },
  {
    resource: 'task', cli: 'task', label: 'Task',
    summary: 'Shared, claimable multi-agent work units in an Awareness plan (cross-host). Prefer ready tasks; claim rejects tasks owned by peers or blocked by unverified deps.',
    actions: [
      {
        action: 'add', summary: 'create a scoped task', params: [
          P.planId(true), { name: 'title', flag: 'title', type: 'string', required: true, description: 'Task title.' },
          P.file(false), { name: 'paths', flag: 'path', type: 'string[]', description: 'All target paths.' },
          { name: 'dependsOn', flag: 'depends-on', type: 'string', description: 'Task id this depends on.' },
          { name: 'reasoning', flag: 'reasoning', type: 'string', description: 'Why this task exists.' },
          { name: 'acceptance', flag: 'acceptance', type: 'string', description: 'Observable done state.' },
          { name: 'checkCommand', flag: 'check', type: 'string', description: 'Command that verifies the task.' },
          { name: 'priority', flag: 'priority', type: 'integer', description: 'Higher runs first.' },
        ],
      },
      { action: 'list', summary: 'list tasks', params: [P.planId(), { name: 'status', flag: 'status', type: 'string', enum: ['OPEN', 'CLAIMED', 'DONE'], description: 'Status filter.' }] },
      { action: 'ready', summary: 'list ready (unblocked) tasks', params: [P.planId(), { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 500, description: 'Max tasks.' }] },
      { action: 'show', summary: 'show one task', params: [P.taskId()] },
      { action: 'claim', summary: 'claim a task to work it', needsAgentId: true, params: [P.taskId(), P.lease()] },
      { action: 'heartbeat', summary: 'extend your claim lease', needsAgentId: true, params: [P.taskId(), P.lease()] },
      { action: 'release', summary: 'give a task back', needsAgentId: true, params: [P.taskId(), { name: 'blockedReason', flag: 'blocked-reason', type: 'string', description: 'Why blocked.' }] },
      { action: 'done', summary: 'mark a task done (still needs verify)', needsAgentId: true, params: [P.taskId()] },
      { action: 'reopen', summary: 'reopen a task', needsAgentId: true, params: [P.taskId(), { name: 'reason', flag: 'reason', type: 'string', description: 'Why reopened.' }, P.lease()] },
      { action: 'depend', summary: 'add a dependency', needsAgentId: true, params: [P.taskId(), { name: 'dependsOn', flag: 'depends-on', type: 'string', required: true, description: 'Task id this depends on.' }] },
    ],
  },
  {
    resource: 'work', cli: 'work', label: 'Work',
    summary: 'Advisory file presence — tell peers which files you are touching without blocking them (weaker than a lock). Combine with git status/diffs for real overlap.',
    actions: [
      { action: 'start', summary: 'declare presence on a file', needsAgentId: true, params: [P.file(), P.reason(), P.ttl()] },
      { action: 'touch', summary: 'refresh presence on a file', needsAgentId: true, params: [P.file(), P.reason(), P.ttl()] },
      { action: 'list', summary: 'list all active work presence', params: [] },
      { action: 'show', summary: 'show presence on a file', params: [P.file()] },
      { action: 'end', summary: 'clear your presence on a file', needsAgentId: true, params: [P.file()] },
    ],
  },
  {
    resource: 'handoff', cli: 'handoff', label: 'Handoff',
    summary: 'Compact continuation notes for the next agent (not a chat log, inbox, or task queue). Treat handoffs as hints; verify against current code/tests.',
    actions: [
      { action: 'add', summary: 'leave a continuation note', needsAgentId: true, params: [{ name: 'summary', flag: 'summary', type: 'string', required: true, description: 'What remains / current state.' }, { name: 'files', flag: 'file', type: 'string[]', description: 'Related files.' }] },
      { action: 'list', summary: 'read open handoffs', params: [{ name: 'includeCleared', flag: 'include-cleared', type: 'boolean', description: 'Include already-cleared notes.' }] },
      { action: 'clear', summary: 'resolve a handoff', params: [{ name: 'handoffId', flag: 'handoff-id', type: 'string', required: true, description: 'Handoff id.' }] },
    ],
  },
  {
    resource: 'check', cli: 'check', label: 'Check',
    summary: 'Verification debt for done tasks — a done task is untrustworthy until its check receipt is marked from a check you actually ran. Never mark a check you did not run.',
    actions: [
      { action: 'audit', summary: 'list done-but-unverified tasks', params: [P.planId(), { name: 'minAgeMs', flag: 'min-age', type: 'integer', min: 1000, durationMs: true, description: 'Only tasks done at least this long ago (ms).' }] },
      { action: 'mark', summary: 'record a check result', needsAgentId: true, params: [P.taskId(), { name: 'message', flag: 'message', type: 'string', required: true, description: 'What the check observed (e.g. "yarn test passed").' }, { name: 'status', flag: 'status', type: 'string', enum: ['SUCCESS', 'FAILED'], description: 'SUCCESS (default) marks verified; FAILED reopens the task.' }] },
    ],
  },
  {
    resource: 'message', cli: 'message', label: 'Message',
    summary: 'Small cross-agent inbox/broadcast — your channel to peers, including agents on OTHER coding hosts (Claude Code, Cursor, Codex) sharing this repo. Use for live coordination on overlap or decisions.',
    actions: [
      { action: 'send', summary: 'message a peer or broadcast', needsAgentId: true, agentIdFlag: 'from', params: [{ name: 'text', flag: 'text', type: 'string', required: true, description: 'Message body.' }, { name: 'to', flag: 'to', type: 'string', description: 'Recipient agent id (omit to broadcast).' }, { name: 'topic', flag: 'topic', type: 'string', description: 'Topic tag.' }, { name: 'files', flag: 'file', type: 'string[]', description: 'Related files.' }] },
      { action: 'read', summary: 'read messages from peers', needsAgentId: true, params: [{ name: 'topic', flag: 'topic', type: 'string', description: 'Topic filter.' }, { name: 'includeRead', flag: 'include-read', type: 'boolean', description: 'Include already-read messages.' }, { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 100, description: 'Max messages.' }] },
    ],
  },
  {
    resource: 'memory', cli: 'memory', label: 'Memory',
    summary: 'Durable workspace memory. Ordinary rows are unverified leads; verified routes require provenance, expiry and secret hardening. Recall remains evidence, never authority.',
    actions: [
      { action: 'store', summary: 'store an unverified memory lead', params: [{ name: 'label', flag: 'label', type: 'string', required: true, description: 'Memory label.' }, { name: 'text', flag: 'text', type: 'string', required: true, description: 'Memory text; secrets are rejected.' }, { name: 'tags', flag: 'tags', type: 'string[]', description: 'Comma-separated tags.' }] },
      { action: 'store-verified', summary: 'store provenance-bound verified memory', params: [
        { name: 'label', flag: 'label', type: 'string', required: true, description: 'Memory label.' },
        { name: 'text', flag: 'text', type: 'string', required: true, description: 'Verified learning; secrets are rejected.' },
        { name: 'sourceDigest', flag: 'source-digest', type: 'string', required: true, description: 'Digest or stable identity of the checked source.' },
        { name: 'scope', flag: 'scope', type: 'string', enum: ['project', 'artifact'], description: 'Verification scope.' },
        { name: 'verifiedAt', flag: 'verified-at', type: 'string', description: 'ISO verification time.' },
        { name: 'validUntil', flag: 'valid-until', type: 'string', description: 'Optional ISO expiry.' },
        { name: 'importance', flag: 'importance', type: 'integer', min: 1, max: 10, description: 'Importance 1-10.' },
        { name: 'tags', flag: 'tags', type: 'string[]', description: 'Comma-separated tags.' },
      ] },
      { action: 'recall', summary: 'recall ordinary memory leads', params: [{ name: 'query', flag: 'query', type: 'string', description: 'Search text.' }, { name: 'label', flag: 'label', type: 'string', description: 'Exact label.' }, { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 50, description: 'Maximum rows.' }, { name: 'semantic', flag: 'semantic', type: 'boolean', description: 'Use semantic ranking with lexical fallback.' }, { name: 'minSimilarity', flag: 'min-similarity', type: 'string', description: 'Semantic score floor.' }] },
      { action: 'recall-verified', summary: 'recall only current provenance-bound verified memories', params: [
        { name: 'query', flag: 'query', type: 'string', description: 'Search text.' }, { name: 'label', flag: 'label', type: 'string', description: 'Exact label.' },
        { name: 'sourceDigest', flag: 'source-digest', type: 'string', description: 'Exact source digest.' }, { name: 'scope', flag: 'scope', type: 'string', enum: ['project', 'artifact'], description: 'Scope filter.' },
        { name: 'mode', flag: 'mode', type: 'string', enum: ['lexical', 'semantic', 'hybrid'], description: 'Recall mode.' }, { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 50, description: 'Maximum rows.' },
        { name: 'now', flag: 'now', type: 'string', description: 'ISO evaluation time.' }, { name: 'minSimilarity', flag: 'min-similarity', type: 'string', description: 'Semantic score floor.' },
      ] },
      { action: 'evaluate', summary: 'run the maintained or supplied verified-memory corpus', params: [
        { name: 'corpusJson', flag: 'corpus-json', type: 'string', description: 'Optional inline MemoryEvaluationCorpusV1 JSON.' }, { name: 'now', flag: 'now', type: 'string', description: 'ISO evaluation time.' },
        { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 50, description: 'Per-case result limit.' }, { name: 'minSimilarity', flag: 'min-similarity', type: 'string', description: 'Semantic score floor.' },
      ] },
      { action: 'list', summary: 'list recent ordinary rows', params: [{ name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 50, description: 'Maximum rows.' }] },
      { action: 'reindex', summary: 'rebuild missing/incompatible embeddings', params: [{ name: 'force', flag: 'force', type: 'boolean', description: 'Rebuild every row.' }, { name: 'limit', flag: 'limit', type: 'integer', min: 1, max: 5000, description: 'Maximum rows.' }] },
      { action: 'forget', summary: 'delete one memory', params: [{ name: 'memoryId', flag: 'memory-id', type: 'string', required: true, description: 'Memory id.' }] },
      { action: 'prune', summary: 'delete old memories after confirmation', params: [{ name: 'olderThanMs', flag: 'older-than', type: 'integer', required: true, durationMs: true, description: 'Age threshold.' }, { name: 'label', flag: 'label', type: 'string', description: 'Optional label.' }, { name: 'confirm', flag: 'confirm', type: 'boolean', description: 'Perform deletion; otherwise dry-run.' }] },
    ],
  },
  {
    resource: 'agent', cli: 'agent', label: 'Peers',
    summary: 'Peer registry for the shared repo. Peers may be other coding agents (host-tagged clawde-*, cursea-*, codex-*, octo-*). Distinct from spawnAgent/AgentMessage (worker orchestration). Combine lastSeenAt with real inspection before assuming a peer is live.',
    actions: [
      { action: 'list', summary: 'list active peer agents and their host', params: [{ name: 'includeLeft', flag: 'include-left', type: 'boolean', description: 'Include agents that have left.' }, { name: 'staleAfterMs', flag: 'stale-after', type: 'integer', min: 1000, durationMs: true, description: 'Flag agents not seen within this window (ms).' }] },
      { action: 'join', summary: 'register this session', needsAgentId: true, params: [{ name: 'name', flag: 'name', type: 'string', description: 'Display name.' }, { name: 'role', flag: 'role', type: 'string', description: 'Role, e.g. implementer.' }] },
      { action: 'leave', summary: 'deregister this session', needsAgentId: true, params: [] },
    ],
  },
  {
    resource: 'plan', cli: 'plan', label: 'Plan',
    summary: 'Shared Awareness plan lifecycle — create, list, inspect, complete, or abandon a plan and its sourced task graph. Non-conflicting with the session-local `plan` tool.',
    actions: [
      {
        action: 'create', summary: 'create a shared plan', params: [
          { name: 'title', flag: 'title', type: 'string', required: true, description: 'Plan title.' },
          { name: 'goal', flag: 'goal', type: 'string', description: 'Goal or scope.' },
        ],
      },
      { action: 'list', summary: 'list plans', params: [] },
      { action: 'show', summary: 'show a plan by id', params: [P.planId(true)] },
      {
        action: 'done', summary: 'mark a plan done', params: [
          P.planId(true),
          { name: 'force', flag: 'force', type: 'boolean', description: 'Skip unfinished-task guard.' },
        ],
      },
      {
        action: 'abandon', summary: 'abandon a plan, cancelling unfinished tasks', needsAgentId: true, params: [
          P.planId(true),
          P.reason(),
        ],
      },
    ],
  },
];

/** Look up a group by its resource name. */
export function getCommandGroup(resource: string): CommandGroup | undefined {
  return AWARENESS_COMMANDS.find((g) => g.resource === resource);
}
