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

const MARK = { todo: '[ ]', doing: '[~]', done: '[x]' } as const;

function renderList(steps: PlanStep[]): string {
  if (steps.length === 0) return '(no active plan)';
  return steps.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}`).join('\n');
}

// ─── User-facing TODO widget (below-editor) ──────────────────────────────────

function planWidgetLines(steps: PlanStep[], theme?: PiTheme): string[] {
  const done = steps.filter((s) => s.status === 'done').length;
  const title = theme?.fg('toolTitle', 'Octocode plan') ?? 'Octocode plan';
  const head = `${title}: ${theme?.fg('dim', `${done}/${steps.length} done`) ?? `${done}/${steps.length} done`}`;
  const rows = steps.map((s, i) => {
    const line = `${MARK[s.status]} ${i + 1}. ${s.text}`;
    if (s.status === 'done') return theme?.fg('dim', line) ?? line;
    if (s.status === 'doing') return theme?.fg('accent', line) ?? line;
    return line;
  });
  return [head, ...rows];
}

/** Mirror the active plan into the below-editor TODO widget + footer, or clear it when empty. */
export function refreshPlanUi(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  const cwd = ctx.cwd ?? process.cwd();
  const steps = getPlan(cwd);
  if (steps.length === 0) {
    ctx.ui?.setStatus?.('octocode-plan', undefined);
    ctx.ui?.setWidget?.('octocode-plan', undefined);
    return;
  }
  const done = steps.filter((s) => s.status === 'done').length;
  ctx.ui?.setStatus?.('octocode-plan', `plan ${done}/${steps.length}`);
  ctx.ui?.setWidget?.(
    'octocode-plan',
    (_tui: unknown, theme: PiTheme) => makeRenderer((w) => planWidgetLines(steps, theme).map((l) => truncateToWidth(l, w))),
    { placement: 'belowEditor' },
  );
}

// ─── /octocode-plan command (user can view / complete / delete tasks) ────────

export const OCTOCODE_PLAN_COMMAND_USAGE = '/octocode-plan [show|complete <n>|start <n>|clear]';
export const OCTOCODE_PLAN_COMMAND_COMPLETIONS = ['show', 'complete ', 'start ', 'clear'] as const;

type NotifyFn = (ctx: PiContext | undefined, message: string, level?: string) => void;

export async function handleOctocodePlanCommand(args: string, ctx: PiContext | undefined, notify: NotifyFn): Promise<void> {
  const cwd = ctx?.cwd ?? process.cwd();
  const [action = 'show', arg] = args.trim().split(/\s+/).filter(Boolean);
  const n = Number(arg);
  switch (action) {
    case 'clear':
      clearPlan(cwd);
      notify(ctx, 'Plan cleared.', 'info');
      break;
    case 'complete':
      if (Number.isFinite(n)) completeStep(cwd, n);
      break;
    case 'start':
      if (Number.isFinite(n)) startStep(cwd, n);
      break;
    case 'show':
    default:
      break;
  }
  refreshPlanUi(ctx);
  const steps = getPlan(cwd);
  const done = steps.filter((s) => s.status === 'done').length;
  notify(ctx, steps.length === 0 ? 'No active plan.' : `Plan ${done}/${steps.length} done\n${renderList(steps)}`, 'info');
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
      refreshPlanUi(ctx);
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
