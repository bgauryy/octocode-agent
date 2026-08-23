/**
 * callSkill — a self-extending meta-tool for **workflows** (sibling of callTool).
 *
 * A skill is an approved, reusable multi-step workflow the agent follows (a `SKILL.md`).
 * callSkill mirrors callTool's lifecycle: resolve (O(1)) → reuse → propose (research +
 * brainstorm + ask the user) → create via a skill-smith subagent → validate + register →
 * maintain. Skills orchestrate; tools (callTool) execute. Any executable `scripts/` a skill
 * ships should be run through the callTool sandbox.
 *
 * Skills are written to `~/.pi/agent/skills/<name>/` so Pi discovers them: spawned
 * subagents see a new skill immediately; the main process surfaces it after a reload or by
 * `read`ing the returned SKILL.md path.
 */

import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import { sliceBetween } from '../utils.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { cliToolTitle, paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { spawnRpcAgent, waitForAgentTurn, isSubagentProcess, killWorkerById } from './agent-tools.js';
import {
  resolveSkill,
  registerSkill,
  deleteSkill,
  listSkills,
  recordSkillUse,
  sweepJunkSkills,
  type SkillManifestEntry,
} from './dynamic-skills.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;
type Mode = 'auto' | 'use' | 'create' | 'enhance' | 'fix' | 'list' | 'delete';

interface CallSkillParams {
  skillType: string;
  metadata?: Record<string, unknown>;
  mode?: Mode;
}

// ─── codegen contract (injectable for tests) ──────────────────────────────────

export interface GeneratedSkill {
  name: string;
  description: string;
  reason: string;
  skillMd: string;
}

export interface SkillGenerateArgs {
  skillType: string;
  intent: string;
  metadata: Record<string, unknown>;
  mode: Mode;
  existing?: SkillManifestEntry;
  ctx?: PiContext;
}

export type SkillGenerator = (args: SkillGenerateArgs) => Promise<GeneratedSkill>;

let _generator: SkillGenerator | null = null;
export function setSkillGeneratorForTests(gen: SkillGenerator | null): void {
  _generator = gen;
}

// ─── triviality guard ──────────────────────────────────────────────────────────

/**
 * A skill must be a *recurring multi-step workflow*. A one-shot action the agent already
 * does inline, or a single tool/bash call, does not earn a persisted skill. Heuristic:
 * a skill is trivial when its intent has no multi-step signal (few words, no sequencing
 * markers). Override with `metadata._force:true`.
 */
export function assessSkillTriviality(skillType: string, intent: string): { trivial: boolean; detail?: string } {
  const text = `${skillType} ${intent}`.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const hasSequence = /\bthen\b|\bstep\b|\bsteps\b|\bworkflow\b|\bfirst\b|\bafter\b|\bpipeline\b|->|→|;|,|\band then\b|\d\./.test(
    intent.toLowerCase(),
  );
  if (!hasSequence && words.length < 6) {
    return { trivial: true, detail: 'looks like a single action — use a tool/bash or answer inline; skills are for recurring multi-step workflows' };
  }
  return { trivial: false };
}

// ─── skill-smith worker (default generator) ────────────────────────────────────

const SENTINELS = { manifest: '===MANIFEST===', skillMd: '===SKILL_MD===', end: '===END===' } as const;

function buildSkillSmithPrompt(a: SkillGenerateArgs): string {
  const lines = [
    a.mode === 'enhance' || a.mode === 'fix'
      ? `Improve the existing skill "${a.skillType}".`
      : `Author a new skill named "${a.skillType}".`,
    '',
    `Intent: ${a.intent || '(infer from the name and metadata)'}`,
    `Context metadata: ${JSON.stringify(a.metadata)}`,
    '',
    'Before writing, briefly research/brainstorm: is there an existing skill, tool, or simple command that already covers this? A skill is justified only for a recurring MULTI-STEP workflow.',
    '',
    'Requirements for the SKILL.md:',
    '- Valid Agent Skills frontmatter: `name` (1-64 lowercase a-z/0-9/hyphen) and a specific `description` (<=1024 chars, says what it does AND when to use it).',
    '- A clear body with a heading and concrete, ordered steps the agent can follow.',
    '- If it needs executable helpers, describe running them via the sandboxed `callTool`; do not inline unsafe code.',
    '',
    'Output EXACTLY these three sentinel-delimited sections, nothing else:',
    SENTINELS.manifest,
    '{"name":"<name>","description":"<what + when>","reason":"<why this reusable workflow should exist>"}',
    SENTINELS.skillMd,
    '---\nname: <name>\ndescription: <what + when>\n---\n\n# <Title>\n\n## Steps\n1. ...',
    SENTINELS.end,
  ];
  return lines.join('\n');
}

export function parseGeneratedSkill(output: string, fallbackName: string): GeneratedSkill {
  const manifestRaw = sliceBetween(output, SENTINELS.manifest, SENTINELS.skillMd);
  const skillMd = stripFences(sliceBetween(output, SENTINELS.skillMd, SENTINELS.end));
  if (!skillMd) throw new Error('skill-smith output missing SKILL_MD section');
  let manifest: Partial<GeneratedSkill> = {};
  try {
    manifest = JSON.parse(manifestRaw || '{}');
  } catch {
    throw new Error('skill-smith MANIFEST section is not valid JSON');
  }
  return {
    name: (manifest.name as string) || fallbackName,
    description: (manifest.description as string) || fallbackName,
    reason: (manifest.reason as string) || '',
    skillMd,
  };
}

function stripFences(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
}

const defaultGenerator: SkillGenerator = async (a) => {
  const record = spawnRpcAgent(
    {
      task: buildSkillSmithPrompt(a),
      name: `skill-smith · ${a.skillType}`,
      tools: [],
      resourceMode: 'lean',
      systemPrompt:
        'You are a skill-smith. You author concise, correct Agent Skills (SKILL.md) for recurring ' +
        'multi-step workflows. Emit only the three sentinel-delimited sections requested. No prose.',
      noSession: true,
    },
    a.ctx,
  );
  try {
    // Progress-aware: ride out long-but-active authoring turns (resets on every
    // event, probes on quiet gaps), with a generous absolute backstop so a truly
    // hung smith can't wedge the main process forever.
    await waitForAgentTurn(record, { maxSilenceMs: 120_000, absoluteCapMs: 600_000 });
    return parseGeneratedSkill(record.lastOutput || record.stderr || '', a.skillType);
  } finally {
    // On timeout/error the spawned smith worker is still alive — kill it so it
    // does not orphan, and its record becomes droppable (reclaimable slot).
    // On success the process has already exited, so this is a harmless no-op.
    killWorkerById(record.id);
  }
};

function getGenerator(): SkillGenerator {
  return _generator ?? defaultGenerator;
}

// ─── orchestration ─────────────────────────────────────────────────────────────

interface SkillOutcome {
  status: 'reuse' | 'created' | 'proposal' | 'declined' | 'error' | 'listed' | 'deleted';
  skillName?: string;
  hit?: 'exact' | 'keyword' | 'miss';
  message?: string;
  skillMd?: string;
  pruned?: string[];
  skills?: Array<{ name: string; description: string; version: number; uses: number }>;
}

async function orchestrate(params: CallSkillParams, ctx?: PiContext): Promise<SkillOutcome> {
  const metadata = params.metadata ?? {};
  const mode: Mode = params.mode ?? 'auto';
  const intent = typeof metadata['intent'] === 'string' ? (metadata['intent'] as string) : '';
  const reason = typeof metadata['reason'] === 'string' ? (metadata['reason'] as string) : '';
  const approveCreate = metadata['_approveCreate'] === true;
  const force = metadata['_force'] === true;

  const pruned = sweepJunkSkills();

  if (mode === 'list') {
    return {
      status: 'listed',
      pruned,
      skills: listSkills().map((s) => ({ name: s.name, description: s.description, version: s.version, uses: s.stats.uses })),
    };
  }
  if (mode === 'delete') {
    const ok = deleteSkill(params.skillType);
    return { status: ok ? 'deleted' : 'error', skillName: params.skillType, pruned, message: ok ? `Deleted skill "${params.skillType}".` : `No skill named "${params.skillType}".` };
  }

  const resolved = resolveSkill(params.skillType, intent);
  let entry: SkillManifestEntry | undefined =
    resolved.hit === 'exact' || resolved.hit === 'keyword' ? resolved.entry : undefined;

  const explicitCreate = mode === 'create' || mode === 'enhance' || mode === 'fix';
  const wantsCreate = explicitCreate || (mode === 'auto' && resolved.hit === 'miss');

  if (mode === 'use' && resolved.hit === 'miss') {
    return { status: 'error', hit: 'miss', pruned, message: `No skill matches "${params.skillType}" and mode:"use" won't create one.` };
  }

  if (wantsCreate) {
    if ((mode === 'enhance' || mode === 'fix') && !entry) {
      return { status: 'error', pruned, message: `mode:"${mode}" requires an existing skill named "${params.skillType}".` };
    }
    const triv = assessSkillTriviality(params.skillType, intent);
    if (triv.trivial && !force) {
      return { status: 'declined', skillName: params.skillType, pruned, message: `Not creating "${params.skillType}": ${triv.detail}. Re-call with metadata._force:true if it truly is a recurring multi-step workflow.` };
    }
    const approved = explicitCreate || approveCreate;
    if (!approved) {
      return {
        status: 'proposal',
        skillName: params.skillType,
        hit: resolved.hit,
        pruned,
        message: `No skill for "${params.skillType}". Before creating: research whether an existing skill/tool/command covers it, brainstorm the smallest workflow, then ASK the user to confirm and re-call with mode:"create" and metadata.reason.`,
      };
    }
    if (!reason.trim()) {
      return { status: 'error', skillName: params.skillType, pruned, message: 'Skill creation requires metadata.reason explaining why this reusable workflow should exist.' };
    }
    let generated: GeneratedSkill;
    try {
      generated = await getGenerator()({ skillType: params.skillType, intent, metadata, mode, existing: entry, ctx });
    } catch (err) {
      return { status: 'error', pruned, message: `Skill generation failed: ${(err as Error).message}` };
    }
    const reg = registerSkill({ name: generated.name, description: generated.description, reason: generated.reason || reason, skillMd: generated.skillMd });
    if (!reg.ok) {
      return { status: 'error', skillName: generated.name, pruned, message: `Generated skill rejected by validation gate (${reg.reason}${reg.detail ? `: ${reg.detail}` : ''}).` };
    }
    entry = reg.entry;
    recordSkillUse(entry.name);
    return {
      status: 'created',
      skillName: entry.name,
      pruned,
      skillMd: entry.skillMd,
      message: `Created skill "${entry.name}". Follow it now: read ${entry.skillMd} (or /skill:${entry.name}). Spawned subagents can use it immediately; reload to surface it in the main prompt.`,
    };
  }

  if (!entry) return { status: 'error', hit: resolved.hit, pruned, message: 'No skill available.' };
  recordSkillUse(entry.name);
  return {
    status: 'reuse',
    skillName: entry.name,
    hit: resolved.hit,
    pruned,
    skillMd: entry.skillMd,
    message: `Reusing skill "${entry.name}" (${resolved.hit}). Follow it: read ${entry.skillMd} (or /skill:${entry.name}).`,
  };
}

function renderHeader(o: SkillOutcome): string {
  switch (o.status) {
    case 'reuse': return `[REUSE] ${o.message}`;
    case 'created': return `[CREATED] ${o.message}`;
    case 'proposal': return `[PROPOSAL] ${o.message}`;
    case 'declined': return `[DECLINED] ${o.message}`;
    case 'listed': return `[SKILLS] ${(o.skills ?? []).length} dynamic skill(s)`;
    case 'deleted': return `[DELETED] ${o.message}`;
    default: return `[ERROR] ${o.message}`;
  }
}

// ─── registration ─────────────────────────────────────────────────────────────

export function registerCallSkill(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  if (isSubagentProcess()) return;

  registerFn(pi, registeredToolNames, {
    name: 'callSkill',
    label: 'Call Skill',
    description: [
      'Meta-tool for workflows: request a reusable multi-step workflow by name and callSkill reuses, proposes, or maintains a dynamic skill (a SKILL.md the agent follows).',
      'Resolves an existing skill in O(1); on a miss it PROPOSES creation (never silently authors). After you research/brainstorm and the user confirms, re-call with mode:"create" and metadata.reason; a skill-smith authors the SKILL.md, which is registered ONLY if it passes frontmatter+structure validation.',
      '',
      'Modes: auto (reuse, else propose) · use (reuse only) · create (author after approval) · enhance/fix (revise existing) · list · delete. Every call prunes junk skills.',
      'A skill must be a recurring MULTI-STEP workflow — not a one-off action a single tool/bash call or callTool covers. Skills orchestrate; callTool executes.',
      'metadata reserved keys: intent (what the workflow does), reason (REQUIRED to create), _approveCreate (approve in auto mode), _force (override the triviality decline).',
    ].join('\n'),
    promptSnippet: 'Reuse, propose, or maintain a dynamic multi-step workflow skill',
    promptGuidelines: [
      'Use callSkill for recurring multi-step workflows; never for a single action a tool/bash/callTool already covers.',
      'On a creation proposal: research existing skills/tools/commands and brainstorm the smallest workflow, then ASK the user before re-calling with mode:"create" and a clear metadata.reason.',
      'Maintain the library: it auto-prunes broken skills; use mode:"list" to review and mode:"delete" to remove obsolete skills.',
      'Follow a created/reused skill by reading its SKILL.md path (or /skill:<name>); spawned subagents see new skills immediately, the main prompt after a reload.',
    ],
    parameters: Type.Object({
      skillType: Type.String({ description: 'Skill name / workflow id (lowercase a-z, 0-9, hyphens). O(1) registry key.' }),
      metadata: Type.Optional(
        Type.Unsafe({
          type: 'object',
          additionalProperties: true,
          description: 'Reserved keys: intent, reason (required to create), _approveCreate, _force.',
        }),
      ),
      mode: Type.Optional(
        Type.Unsafe({
          type: 'string',
          enum: ['auto', 'use', 'create', 'enhance', 'fix', 'list', 'delete'],
          description: 'auto (default) · use · create · enhance/fix · list · delete.',
        }),
      ),
    }),

    async execute(_id: string, rawParams: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext) {
      const outcome = await orchestrate(rawParams as unknown as CallSkillParams, ctx);
      const parts: string[] = [renderHeader(outcome)];
      if (outcome.status === 'listed') {
        parts.push(
          (outcome.skills ?? []).map((s) => `  ${s.name} v${s.version} — ${s.description} (uses ${s.uses})`).join('\n') || '  (no dynamic skills)',
        );
      }
      if (outcome.pruned && outcome.pruned.length > 0) parts.push(`[MAINTAINED] pruned broken skills: ${outcome.pruned.join(', ')}`);
      return {
        content: [{ type: 'text', text: parts.join('\n') }],
        isError: outcome.status === 'error',
        details: outcome,
      } as unknown as ToolCallResult;
    },

    renderCall(rawParams: unknown, theme?: PiTheme) {
      const p = rawParams as CallSkillParams;
      // Brand title + dim args, matching the other tool-call rows.
      const title = cliToolTitle(theme, 'callSkill');
      const args = `(${p.skillType}${p.mode && p.mode !== 'auto' ? `, ${p.mode}` : ''})`;
      return makeRenderer((w) => [truncateToWidth(`${title}${paint(theme, 'dim', args)}`, w)]);
    },

    renderResult(result: unknown, _opts: unknown, theme?: PiTheme) {
      const r = result as { content?: Array<{ text?: string }> };
      const first = (r?.content?.[0]?.text ?? '').split('\n')[0] || 'callSkill';
      // Contract: red=error, gold=act-on-me (declined awaiting your call), green=win.
      const colored = first.startsWith('[ERROR]')
        ? paint(theme, 'error', first)
        : first.startsWith('[DECLINED]') || first.startsWith('[BLOCKED]')
          ? paint(theme, 'warning', first)
          : paint(theme, 'success', first);
      return makeRenderer((w) => [truncateToWidth(colored, w)]);
    },
  });
}
