/**
 * plan — a lightweight, session-scoped task-breakdown tool that operationalizes the
 * think-first "task breakdown gate". The plan is projected into the system prompt every
 * turn (`renderActivePlanAddendum`), so it survives compaction and stays visible.
 *
 * For shared/persistent multi-agent plans use the awareness `plan`/`task` CLI instead;
 * this tool is the solo, per-turn working checklist.
 */

import type { ToolDefinition, ToolCallResult, PiContext, PiTheme } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { refreshStatusPanel } from './status-panel.js';
import { activePlanScope, setPlan, addStep, startStep, completeStep, clearPlan, getPlan, renderActivePlanAddendum, MARK, stepLabel, displayStatus, type PlanStep, type DisplayStatus, type StepInput } from './active-plan.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

type PlanAction = 'set' | 'add' | 'start' | 'complete' | 'clear' | 'show';

interface PlanParams {
  action: PlanAction;
  steps?: StepInput[];
  text?: string;
  activeForm?: string;
  index?: number;
}

const TEXT_MARK: Record<DisplayStatus, string> = { ...MARK, blocked: '[!]' };

function renderList(steps: PlanStep[]): string {
  if (steps.length === 0) return '(no active plan)';
  return steps.map((s, i) => {
    const ds = displayStatus(s, steps);
    const needs = ds === 'blocked' && s.dependsOn?.length ? ` (needs ${s.dependsOn.join(',')})` : '';
    return `${TEXT_MARK[ds]} ${i + 1}. ${s.text}${needs}`;
  }).join('\n');
}

const GLYPH: Record<DisplayStatus, string> = { todo: '○', doing: '▸', done: '✓', blocked: '⊘' };
const BAR_WIDTH = 8;

/** Render a compact `███░░` progress bar for done/total. */
function progressBar(done: number, total: number): string {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/** The Plan section lines for the below-editor panel (header + colored checklist). Empty when no plan. */
export function planPanelLines(steps: PlanStep[], theme?: PiTheme): string[] {
  if (steps.length === 0) return [];
  const done = steps.filter((s) => s.status === 'done').length;
  const paintStep = (status: DisplayStatus, text: string): string => {
    if (status === 'done') return paint(theme, 'muted', text);
    if (status === 'doing') return paint(theme, 'warning', text);
    if (status === 'blocked') return paint(theme, 'muted', text);
    return paint(theme, 'brand', text);
  };
  const current = steps.find((s) => s.status === 'doing') ?? steps.find((s) => s.status === 'todo');
  const currentLabel = current ? ` · now: ${stepLabel(current)}` : '';
  const header = `Plan  ${progressBar(done, steps.length)}  ${done}/${steps.length}${currentLabel}`;
  const rows = steps.map((s, i) => {
    const ds = displayStatus(s, steps);
    const needs = ds === 'blocked' && s.dependsOn?.length ? ` (needs ${s.dependsOn.join(',')})` : '';
    return paintStep(ds, `${GLYPH[ds]} ${i + 1}. ${stepLabel(s)}${needs}`);
  });
  return [paint(theme, 'success', header), ...rows];
}

/** Mirror the active plan into the compact footer status AND a live below-editor checklist panel. */
export function refreshPlanUi(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  const scope = activePlanScope(ctx);
  const steps = getPlan(scope);
  if (steps.length === 0) {
    ctx.ui?.setStatus?.('octocode-plan', undefined);
    refreshStatusPanel(ctx);
    return;
  }
  const done = steps.filter((s) => s.status === 'done').length;
  const current = steps.find((s) => s.status === 'doing') ?? steps.find((s) => s.status === 'todo');
  ctx.ui?.setStatus?.('octocode-plan', `plan ${done}/${steps.length}${current ? ` · ${stepLabel(current)}` : ''}`);
  // The Plan section is rendered by the unified below-editor status panel.
  refreshStatusPanel(ctx);
}

// ─── /octocode-plan command (user can view / complete / delete tasks) ────────

export const OCTOCODE_PLAN_COMMAND_USAGE = '/octocode-plan [show|complete <n>|start <n>|clear]';
export const OCTOCODE_PLAN_COMMAND_COMPLETIONS = ['show', 'complete ', 'start ', 'clear'] as const;

type NotifyFn = (ctx: PiContext | undefined, message: string, level?: string) => void;

export async function handleOctocodePlanCommand(args: string, ctx: PiContext | undefined, notify: NotifyFn): Promise<void> {
  const scope = activePlanScope(ctx);
  const [action = 'show', arg] = args.trim().split(/\s+/).filter(Boolean);
  const n = Number(arg);
  switch (action) {
    case 'clear':
      clearPlan(scope);
      notify(ctx, 'Plan cleared.', 'info');
      break;
    case 'complete':
      if (Number.isFinite(n)) completeStep(scope, n);
      break;
    case 'start':
      if (Number.isFinite(n)) startStep(scope, n);
      break;
    case 'show':
    default:
      break;
  }
  refreshPlanUi(ctx);
  const steps = getPlan(scope);
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
      'Optionally give each step an activeForm (present-continuous label, e.g. "Editing file") — it is shown in the live plan panel while that step runs.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['set', 'add', 'start', 'complete', 'clear', 'show'], description: 'set|add|start|complete|clear|show' }),
      steps: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              text: Type.String(),
              activeForm: Type.Optional(Type.String({ description: 'Present-continuous label shown while this step runs, e.g. "Editing file".' })),
              dependsOn: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: '1-based indices of steps that must be done first; shows as blocked until then.' })),
            }),
          ]),
          { description: 'Ordered steps for action:set. Each is an imperative string, or {text, activeForm} to add a present-continuous label.' },
        ),
      ),
      text: Type.Optional(Type.String({ description: 'Step text for action:add.' })),
      activeForm: Type.Optional(Type.String({ description: 'Optional present-continuous label for action:add (e.g. "Editing file").' })),
      index: Type.Optional(Type.Integer({ minimum: 1, description: '1-based step number for start/complete.' })),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext) {
      const p = raw as unknown as PlanParams;
      const scope = activePlanScope(ctx);
      let steps: PlanStep[];
      switch (p.action) {
        case 'set':
          steps = setPlan(scope, Array.isArray(p.steps) ? p.steps : []);
          break;
        case 'add':
          steps = addStep(scope, String(p.text ?? ''), p.activeForm);
          break;
        case 'start':
        case 'complete': {
          const current = getPlan(scope);
          const idx = Number(p.index);
          if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
            const msg = current.length === 0
              ? `[PLAN] no active plan — nothing to ${p.action}. Use plan set first.`
              : `[PLAN] no such step ${p.index ?? '(missing index)'} — plan has ${current.length} step(s). Run plan show for indices.`;
            return {
              content: [{ type: 'text', text: `${msg}\n${renderList(current)}` }],
              isError: true,
              details: { action: p.action, steps: current, addendum: renderActivePlanAddendum(scope), error: 'invalid-index' },
            } as unknown as ToolCallResult;
          }
          steps = p.action === 'start' ? startStep(scope, idx) : completeStep(scope, idx);
          break;
        }
        case 'clear':
          clearPlan(scope);
          steps = [];
          break;
        case 'show':
        default:
          steps = getPlan(scope);
          break;
      }
      refreshPlanUi(ctx);
      const done = steps.filter((s) => s.status === 'done').length;
      const header = p.action === 'clear' ? '[PLAN] cleared' : `[PLAN] ${done}/${steps.length} done`;
      return {
        content: [{ type: 'text', text: `${header}\n${renderList(steps)}` }],
        details: { action: p.action, steps, addendum: renderActivePlanAddendum(scope) },
      } as unknown as ToolCallResult;
    },

    renderCall(raw: unknown) {
      const p = raw as PlanParams;
      const extra = p.action === 'set' ? ` (${(p.steps ?? []).length} steps)` : p.index ? ` #${p.index}` : '';
      return makeRenderer((w) => [truncateToWidth(`plan(${p.action}${extra})`, w)]);
    },

    renderResult(result: unknown, _opts: unknown, theme?: PiTheme) {
      const r = result as { details?: { steps?: PlanStep[]; action?: string } };
      const steps = r?.details?.steps ?? [];
      if (r?.details?.action === 'clear' || steps.length === 0) {
        const line = '◆ plan cleared';
        return makeRenderer((w) => [truncateToWidth(paint(theme, 'dim', line), w)]);
      }
      const done = steps.filter((s) => s.status === 'done').length;
      const current = steps.find((s) => s.status === 'doing') ?? steps.find((s) => s.status === 'todo');
      const line = `◆ plan ${done}/${steps.length}${current ? ` · ${stepLabel(current)}` : ''}`;
      // Dim, single line — the full checklist lives in the under-input panel.
      return makeRenderer((w) => [truncateToWidth(paint(theme, 'dim', line), w)]);
    },
  });
}
