/**
 * plan — a lightweight, session-scoped task-breakdown tool that operationalizes the
 * think-first "task breakdown gate". The plan is projected into the system prompt every
 * turn (`renderActivePlanAddendum`), so it survives compaction and stays visible.
 *
 * For shared/persistent multi-agent plans use the awareness `plan`/`task` CLI instead;
 * this tool is the solo, per-turn working checklist.
 */

import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { setPlan, addStep, startStep, completeStep, clearPlan, getPlan, renderActivePlanAddendum, type PlanStep } from './active-plan.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

type PlanAction = 'set' | 'add' | 'start' | 'complete' | 'clear' | 'show';

interface PlanParams {
  action: PlanAction;
  steps?: string[];
  text?: string;
  index?: number;
}

function renderList(steps: PlanStep[]): string {
  if (steps.length === 0) return '(no active plan)';
  const mark = { todo: '[ ]', doing: '[~]', done: '[x]' } as const;
  return steps.map((s, i) => `${mark[s.status]} ${i + 1}. ${s.text}`).join('\n');
}

export function registerPlanTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  registerFn(pi, registeredToolNames, {
    name: 'plan',
    label: 'Plan',
    description: [
      'Record and track the task breakdown from the think-first gate as a visible, compaction-durable checklist.',
      'The plan is re-injected into your context every turn (<active_plan>), so it survives compaction — set it once, then start/complete steps as you go.',
      'Use for non-trivial multi-step work (multiple files/phases/risky edits). Skip for obvious single-step tasks. For shared/persistent multi-agent plans use the awareness plan/task CLI instead.',
      'Actions: set (replace with an ordered step list) · add (append a step) · start (mark step N doing) · complete (mark step N done, auto-advances) · show · clear (when the task is finished/abandoned).',
    ].join('\n'),
    promptSnippet: 'Track a compaction-durable task-breakdown checklist (set/add/start/complete/show/clear)',
    promptGuidelines: [
      'When the think-first gate says decompose, record the steps with plan(set:[...]); then work the next step and plan(complete) it. Keep it proportional — no ceremony for single-step work.',
      'Clear the plan (plan clear) once the task is done or abandoned so a stale checklist does not linger in context.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['set', 'add', 'start', 'complete', 'clear', 'show'], description: 'set|add|start|complete|clear|show' }),
      steps: Type.Optional(Type.Array(Type.String(), { description: 'Ordered step texts for action:set.' })),
      text: Type.Optional(Type.String({ description: 'Step text for action:add.' })),
      index: Type.Optional(Type.Integer({ minimum: 1, description: '1-based step number for start/complete.' })),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext) {
      const p = raw as unknown as PlanParams;
      const cwd = ctx?.cwd ?? process.cwd();
      let steps: PlanStep[];
      switch (p.action) {
        case 'set':
          steps = setPlan(cwd, Array.isArray(p.steps) ? p.steps : []);
          break;
        case 'add':
          steps = addStep(cwd, String(p.text ?? ''));
          break;
        case 'start':
          steps = startStep(cwd, Number(p.index ?? 0));
          break;
        case 'complete':
          steps = completeStep(cwd, Number(p.index ?? 0));
          break;
        case 'clear':
          clearPlan(cwd);
          steps = [];
          break;
        case 'show':
        default:
          steps = getPlan(cwd);
          break;
      }
      const done = steps.filter((s) => s.status === 'done').length;
      const header = p.action === 'clear' ? '[PLAN] cleared' : `[PLAN] ${done}/${steps.length} done`;
      return {
        content: [{ type: 'text', text: `${header}\n${renderList(steps)}` }],
        details: { action: p.action, steps, addendum: renderActivePlanAddendum(cwd) },
      } as unknown as ToolCallResult;
    },

    renderCall(raw: unknown) {
      const p = raw as PlanParams;
      const extra = p.action === 'set' ? ` (${(p.steps ?? []).length} steps)` : p.index ? ` #${p.index}` : '';
      return makeRenderer((w) => [truncateToWidth(`plan(${p.action}${extra})`, w)]);
    },

    renderResult(result: unknown, _opts: unknown, theme?: PiTheme) {
      const r = result as { content?: Array<{ text?: string }> };
      const first = (r?.content?.[0]?.text ?? '').split('\n')[0] || 'plan';
      return makeRenderer((w) => [truncateToWidth(theme?.fg('success', first) ?? first, w)]);
    },
  });
}
