/**
 * plan — a lightweight, session-scoped task-breakdown tool that operationalizes the
 * think-first "task breakdown gate". The plan is projected into the system prompt every
 * turn (`renderActivePlanAddendum`), so it survives compaction and stays visible.
 *
 * For shared/persistent multi-agent plans use the awareness `plan`/`task` CLI instead;
 * this tool is the solo, per-turn working checklist.
 */

import path from 'node:path';
import type { ToolDefinition, ToolCallResult, PiContext, PiTheme, NotifyFn } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { cliToolTitle, paint } from '../tui/cli-design.js';
import { SEP } from '../tui/palette.js';
import { buildPlanPrompt } from '../prompts/plan-prompt.js';
import { enterPlanMode, exitPlanMode, isPlanMode } from './plan-mode.js';
import { runAskPrompt } from './ask-user-tool.js';
import { enablePlanHtmlSync, resetPlanHtmlSync, openPlanHtml, syncPlanHtmlIfEnabled, writePlanArtifacts, planArtifactsDir } from './plan-html.js';
import { serveDirectory, unmount } from './local-server.js';
import { PLAN_APPROVE_DESC, PLAN_APPROVE_LABEL, PLAN_PROPOSE_HINT, PLAN_REJECT_DESC, PLAN_REJECT_LABEL } from '../tui/content.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { refreshStatusPanel } from './status-panel.js';
import { activePlanScope, setPlan, activatePlan, addStep, startStep, completeStep, removeStep, clearPlan, getPlan, renderActivePlanAddendum, MARK, stepLabel, displayStatus, depsMet, resolveRfcPath, setPlanRfc, getPlanRfc, addPlanDecision, getPlanDecisions, planPhaseIndex, PLAN_PHASES, type PlanStep, type DisplayStatus, type StepInput } from './active-plan.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

type PlanAction = 'set' | 'propose' | 'clarify' | 'add' | 'start' | 'complete' | 'remove' | 'clear' | 'show';

/** One clarify-phase question: a prompt plus optional multiple-choice options. */
interface ClarifyQuestion {
  prompt: string;
  options?: Array<{ value?: string; label: string; description?: string; recommended?: boolean; pros?: string[]; cons?: string[] }>;
}

/** Cap on questions per clarify call — a bounded interview, not an interrogation. */
const MAX_CLARIFY = 3;

/** At/above this step count a plan is treated as consequential regardless of self-report. */
const CONSEQUENTIAL_STEP_COUNT = 5;
/** Risk vocabulary that flags consequential work in a step's text. */
const RISK_RE = /\b(migrat|schema|auth|delete|\bdrop\b|truncate|rename|breaking|public[\s-]?api|deprecat|secret|credential|\btoken\b|encrypt|permission|rollback|backfill|lockfile|release)\w*/i;

/**
 * Heuristic "does this look consequential?" from the proposed steps alone — step
 * count and risk vocabulary. Pure and exported for testing. Returns the verdict
 * plus the human-readable signals that fired (for the gate's block message).
 */
export function inferConsequential(steps: StepInput[]): { consequential: boolean; signals: string[] } {
  const texts = steps.map((s) => (typeof s === 'string' ? s : s?.text ?? ''));
  const signals: string[] = [];
  if (texts.length >= CONSEQUENTIAL_STEP_COUNT) signals.push(`${texts.length} steps`);
  const hits = new Set<string>();
  for (const t of texts) {
    const m = t.match(RISK_RE);
    if (m) hits.add(m[0].toLowerCase());
  }
  if (hits.size) signals.push(`risk terms: ${[...hits].slice(0, 4).join(', ')}`);
  return { consequential: signals.length > 0, signals };
}

interface PlanParams {
  action: PlanAction;
  steps?: StepInput[];
  text?: string;
  activeForm?: string;
  dependsOn?: number[];
  index?: number;
  /** For set/propose: mark the work consequential so the RFC gate applies (an accepted RFC is required). */
  consequential?: boolean;
  /** For set/propose: path to the accepted RFC (a `.octocode/rfc/<name>/` dir or its RFC.md). Renders on the plan page. */
  rfcPath?: string;
  /** For action:clarify — up to 3 high-impact questions to ask the user before proposing. */
  questions?: ClarifyQuestion[];
  /** Required with consequential:false when the work still looks consequential — the justification for skipping the RFC. */
  reason?: string;
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

const BAR_WIDTH = 8;

/**
 * A one-line phase stepper — `✓ Research → ✓ RFC → ▸ Build …` — so the panel
 * always shows where in the flow the plan is. Done phases fade, the current one
 * is brand-bold, upcoming ones are muted. Same color contract as the checklist.
 */
export function phaseStepperLine(steps: PlanStep[], theme?: PiTheme): string {
  const cur = planPhaseIndex(steps);
  const bold = (t: string) => (typeof theme?.bold === 'function' ? theme.bold(t) : t);
  const parts = PLAN_PHASES.map((label, i) => {
    if (i < cur) return paint(theme, 'dim', `✓ ${label}`);
    if (i === cur) return paint(theme, 'brand', bold(`▸ ${label}`));
    return paint(theme, 'muted', `○ ${label}`);
  });
  return parts.join(paint(theme, 'dim', ' → '));
}

/** Render a compact `███░░` progress bar for done/total. */
function progressBar(done: number, total: number): string {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/**
 * Compact plan projection for the persistent below-editor panel. The durable
 * checklist and phase detail remain available through the plan document/show
 * surfaces; the always-visible panel keeps only progress, active lanes, and
 * actionable counts. Every line is clipped at the source when width is given.
 */
export function planPanelLines(steps: PlanStep[], theme?: PiTheme, width?: number): string[] {
  if (steps.length === 0) return [];
  const done = steps.filter((step) => step.status === 'done').length;
  const doing = steps.filter((step) => step.status === 'doing');
  const current = doing[0] ?? steps.find((step) => step.status === 'todo');
  const currentLabel = doing.length > 1
    ? `${SEP}now: ${doing.map(stepLabel).join(SEP)}`
    : current ? `${SEP}now: ${stepLabel(current)}` : '';
  const header = paint(theme, 'brand', `Plan  ${progressBar(done, steps.length)}  ${done}/${steps.length} done${currentLabel}`);
  const blocked = steps.filter((step) => displayStatus(step, steps) === 'blocked').length;
  const ready = steps.filter((step) => step.status === 'todo' && depsMet(step, steps)).length;
  const counts = [
    blocked > 0 ? `${blocked} blocked` : '',
    ready > 0 ? `${ready} ready` : '',
    doing.length > 1 ? `${doing.length} active lanes` : '',
  ].filter(Boolean).join(SEP);
  const lines = counts ? [header, paint(theme, blocked > 0 ? 'warning' : 'muted', counts)] : [header];
  return width ? lines.map((line) => truncateToWidth(line, width)) : lines;
}

/**
 * Write the plan doc, start a localhost server hosting it, arm live sync, and
 * open the served URL in a browser (interactive TUI only). Returns the served
 * URL, or undefined if the doc write or the server failed. Used when the user
 * has already asked to see the plan (the /octocode-plan html command, or a yes
 * to the propose "show in browser?" prompt) — it does NOT ask on its own.
 */
/**
 * Per-scope mount name so parallel plan scopes in one process get distinct URLs
 * instead of silently clobbering a shared `/plan/` mount. The artifact dir's
 * basename is already the scope hash, so reuse it.
 */
function planMountName(scope: string): string {
  return `plan-${path.basename(planArtifactsDir(scope))}`;
}

function planWorkspace(scope: string): string {
  return scope.split('\0')[0] || scope;
}

function writeCurrentPlanArtifacts(scope: string, steps: PlanStep[], status: 'draft' | 'approved' | 'active' = 'active') {
  return writePlanArtifacts(scope, steps, { status, workspace: planWorkspace(scope) });
}

/** Tear down a scope's plan surface: stop live sync and drop its server mount. */
function tearDownPlanHtml(scope: string): void {
  resetPlanHtmlSync();
  unmount(planMountName(scope));
}

async function servePlanPage(ctx: PiContext | undefined, scope: string): Promise<string | undefined> {
  // servePlanPage is the sole writer for the browser path (callers must not
  // pre-write) so the doc and the served bytes never diverge.
  const artifacts = writeCurrentPlanArtifacts(scope, getPlan(scope), 'active');
  if (!artifacts) return undefined;
  // Host the plan's artifact dir under /plan-<hash>/ on the shared CLI server.
  const served = await serveDirectory(planMountName(scope), planArtifactsDir(scope), { indexFile: 'plan.html' });
  if (!served) return undefined;
  // Arm live sync so later plan mutations rewrite the files the server reads and
  // the page's meta-refresh picks them up.
  enablePlanHtmlSync(scope);
  if (ctx?.hasUI && ctx.mode === 'tui') {
    const opened = openPlanHtml(served.url);
    if (!opened.ok && opened.message) ctx.ui?.notify?.(opened.message, 'warn');
  }
  return served.url;
}

/** Mirror the active plan into the unified below-editor status panel only. */
export function refreshPlanUi(ctx?: PiContext): void {
  // Live HTML sync is independent of the TUI: headless mutations still keep
  // an opened plan page fresh.
  syncPlanHtmlIfEnabled(getPlan(activePlanScope(ctx)));
  if (!ctx?.hasUI) return;
  refreshStatusPanel(ctx);
}

// ─── /octocode-plan command (user can view / complete / delete tasks) ────────

export const OCTOCODE_PLAN_COMMAND_USAGE = '/octocode-plan [new <goal>|off|show|html|complete <n>|start <n>|remove <n>|clear]';
export const OCTOCODE_PLAN_COMMAND_COMPLETIONS = ['new ', 'off', 'show', 'html', 'complete ', 'start ', 'remove ', 'clear'] as const;

/** Host hook for `/octocode-plan new`: sends the plan-mode prompt to the agent as the next user turn. */
export type SendPlanPrompt = (text: string) => void | Promise<void>;


export async function handleOctocodePlanCommand(args: string, ctx: PiContext | undefined, notify: NotifyFn, sendPrompt?: SendPlanPrompt): Promise<void> {
  const scope = activePlanScope(ctx);
  const [action = 'show', arg] = args.trim().split(/\s+/).filter(Boolean);
  if (action === 'off') {
    const was = isPlanMode();
    exitPlanMode(ctx);
    notify(ctx, was ? 'Plan mode off — write tools restored.' : 'Plan mode was not on.', 'info');
    return;
  }
  if (action === 'new') {
    // Plan mode: hand the agent an explicit research → propose → gate prompt.
    // The goal is everything after `new`; the agent asks for one when absent.
    const goal = args.trim().replace(/^new\b/, '').trim();
    if (!sendPrompt) {
      notify(ctx, 'This host cannot send prompts — describe the goal and ask the agent to `plan(propose)` it.', 'warning');
      return;
    }
    enterPlanMode(ctx);
    await sendPrompt(buildPlanPrompt(goal));
    notify(ctx, goal ? `Plan mode on (write tools blocked until approval): planning “${goal.slice(0, 80)}”.` : 'Plan mode on (write tools blocked until approval): the agent will ask for the goal.', 'info');
    return;
  }
  const n = Number(arg);
  // Bad indices must say WHY nothing changed — the plan reprint alone reads as
  // a silent success (the tool path returns [PLAN] errors; parity for the command).
  const validStep = (verb: string): boolean => {
    const count = getPlan(scope).length;
    if (count === 0) {
      notify(ctx, `No active plan — nothing to ${verb}.`, 'warning');
      return false;
    }
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > count) {
      notify(ctx, `Usage: /octocode-plan ${verb} <n> with n between 1 and ${count} (got "${arg ?? ''}").`, 'warning');
      return false;
    }
    return true;
  };
  switch (action) {
    case 'html': {
      // Explicit user intent — serve + open the live local page; from now on
      // every plan mutation rewrites it (the page meta-refreshes) so the browser
      // tab tracks the plan while you keep working in the terminal.
      const url = await servePlanPage(ctx, scope);
      if (!url) {
        notify(ctx, 'Could not start the local plan server (is ~/.octocode/ writable?).', 'warning');
        return;
      }
      notify(ctx, `Plan page: ${url} (local server, live — updates on every plan change)`, 'info');
      return;
    }
    case 'clear':
      clearPlan(scope);
      tearDownPlanHtml(scope);
      notify(ctx, 'Plan cleared.', 'info');
      break;
    case 'complete':
      if (validStep('complete')) completeStep(scope, n);
      break;
    case 'start':
      if (validStep('start')) startStep(scope, n);
      break;
    case 'remove':
      if (validStep('remove')) removeStep(scope, n);
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
      'Record and track the task breakdown from the think-first gate as a visible, compaction-durable checklist and reviewable plan document.',
      'The plan is re-injected into your context every turn (<active_plan>), so it survives compaction — set it once, then start/complete steps as you go. Mutations also write plan.md/plan.html under the Octocode temp plan directory; when an RFC is linked (rfcPath), the plan.html renders that RFC document itself above the derived checklist and dependency diagram.',
      'Use for non-trivial multi-step work (multiple files/phases/risky edits). Skip for obvious single-step tasks. For consequential work, load octocode-rfc-generator first, discuss the RFC/implementation plan doc with the user, incorporate missing points, wait for approval, and only then derive these steps from the accepted document — pass consequential:true and rfcPath pointing at that RFC (a consequential set/propose with no RFC is BLOCKED). For shared/persistent multi-agent plans mirror those document-derived steps into the awareness plan/task CLI instead of creating task-only backlogs.',
      'Actions: clarify (ask ≤3 high-impact questions via inline cards before proposing — explore first, ask only what the repo can’t answer; each answer is recorded in the durable decision log and renders on the plan page) · set (replace with an ordered step list for already-approved/obvious work; dependsOn expresses ordering) · propose (set + render the plan panel + ask the user to approve/reject through the UI — free-text reply = change request; use for user-visible, multi-phase, risky, or preference-dependent plans, and never execute a rejected plan) · add (append a step) · start (mark a step doing; multiple independent steps may be doing in parallel) · complete (mark a step done, auto-advances) · remove (delete a step, dependencies renumber) · show · clear (when the task is finished/abandoned).',
      'index is optional for start/complete/remove: complete/remove default to the single current doing step; when multiple steps are doing, pass index. start defaults to the next runnable todo.',
    ].join('\n'),
    promptSnippet: 'Track a compaction-durable task-breakdown checklist (set/add/start/complete/remove/show/clear)',
    promptGuidelines: [
      'Explore first, ask second: when intent/scope/trade-offs stay open after a research pass, run plan(clarify) with ≤3 high-impact multiple-choice questions the repo can’t answer (mark a recommended default) — each answer is recorded in the durable decision log and renders on the plan page. Skip clarify for obvious work.',
      'When the think-first gate says decompose and execution is already approved/obvious, record the steps with plan(set:[...]); for user-visible, multi-phase, risky, or preference-dependent plans use plan(propose:[...]) first and wait for approval. For consequential work, use octocode-rfc-generator to research/write the RFC or implementation plan first, discuss it with the user, revise missing points, and wait for approval before deriving plan steps from that accepted document — then pass consequential:true and rfcPath (the .octocode/rfc/<name>/ dir or its RFC.md) so the plan page renders the RFC and the gate is satisfied. The tool also auto-detects consequential-looking plans (≥5 steps or risk terms) and blocks them without an RFC; to skip deliberately, pass consequential:false with a short reason (logged). Then work the active step and plan(complete) it — with no index it completes the single current step, so the serial loop is: work, plan(complete), repeat.',
      'Keep the checklist truthful as scope shifts: plan(add) newly discovered document-backed steps, plan(remove) obsolete ones, and clear the plan (plan clear) once the task is done or abandoned so a stale checklist does not linger. If Awareness task/work state exists, update it in the same turn so local plan and shared tasks do not diverge; shared tasks should point back to the plan/RFC acceptance and verification anchors.',
      'For independent lanes, encode ordering with dependsOn, start runnable lanes with plan(start:N) before batching/spawning, and pass explicit indices when completing parallel steps.',
      'Optionally give each step an activeForm (present-continuous label, e.g. "Editing file") — it is shown in the live plan panel while that step runs; propose also shows the full checklist below the editor before the approval prompt. The plan widget/doc should make the flow gate visible: RFC/research → discuss + approve → derive plan/tasks → verify.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['set', 'propose', 'clarify', 'add', 'start', 'complete', 'remove', 'clear', 'show'], description: 'set|propose|clarify|add|start|complete|remove|clear|show' }),
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
      dependsOn: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'For action:add — 1-based indices of steps that must be done first.' })),
      index: Type.Optional(Type.Integer({ minimum: 1, description: '1-based step number for start/complete/remove. Omit to target the current doing step (complete/remove) or the next runnable todo (start).' })),
      consequential: Type.Optional(Type.Boolean({ description: 'For set/propose: mark the work consequential (multi-phase, public-contract, architecture, migration, risky, or preference-dependent). When true — or when the steps look consequential (≥5 steps or risk terms) — an accepted RFC is required (pass rfcPath) or the call is blocked. Pass false to declare trivial.' })),
      reason: Type.Optional(Type.String({ description: 'Required with consequential:false when the steps still look consequential — a short justification for skipping the RFC (recorded in the decision log).' })),
      rfcPath: Type.Optional(Type.String({ description: 'For set/propose: the accepted RFC this plan derives from — a `.octocode/rfc/<name>/` folder or its RFC.md. The plan page renders this document; must live under the workspace .octocode/rfc/ tree.' })),
      questions: Type.Optional(Type.Array(
        Type.Object({
          prompt: Type.String({ description: 'A high-impact question the repo cannot answer (skip anything answerable by reading code).' }),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String(),
            value: Type.Optional(Type.String()),
            description: Type.Optional(Type.String()),
            recommended: Type.Optional(Type.Boolean({ description: 'Marks the recommended default; lands the cursor here.' })),
            pros: Type.Optional(Type.Array(Type.String())),
            cons: Type.Optional(Type.Array(Type.String())),
          }), { description: 'Multiple-choice options; omit for a free-text question. A free-text escape is always offered.' })),
        }),
        { description: 'For action:clarify — up to 3 high-impact questions asked via inline cards; answers are recorded in the plan decision log.' },
      )),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext) {
      const p = raw as unknown as PlanParams;
      const scope = activePlanScope(ctx);
      let steps: PlanStep[];

      // ── Clarify phase (interview) ────────────────────────────────────────────
      // Ask ≤3 high-impact questions via the inline ask card, record each answer
      // into the durable decision log, and steer toward a decision-complete
      // propose. Precedes plan(propose); never mutates steps.
      if (p.action === 'clarify') {
        const clarifyResult = (text: string, isError = false): ToolCallResult => ({
          content: [{ type: 'text' as const, text }],
          ...(isError ? { isError: true } : {}),
          details: { action: 'clarify', decisions: getPlanDecisions(scope) },
        }) as unknown as ToolCallResult;
        const questions = (Array.isArray(p.questions) ? p.questions : []).filter((q) => q && String(q.prompt ?? '').trim()).slice(0, MAX_CLARIFY);
        if (questions.length === 0) {
          return clarifyResult('[PLAN] clarify needs a questions[] list (≤3 high-impact questions the repo can’t answer). Skip clarify for obvious work.', true);
        }
        if (!ctx) {
          return clarifyResult(`[PLAN] this host cannot prompt — ask these inline and continue:\n${questions.map((q, i) => `${i + 1}. ${q.prompt}`).join('\n')}`);
        }
        const recorded: string[] = [];
        let halted: string | undefined;
        for (const [i, q] of questions.entries()) {
          const prompt = String(q.prompt).trim();
          const options = (Array.isArray(q.options) ? q.options : [])
            .map((o) => ({ value: String(o.value ?? o.label ?? '').trim(), label: o.label, description: o.description, recommended: o.recommended, pros: o.pros, cons: o.cons }))
            .filter((o) => o.value);
          // Number the questions so the interview reads as a bounded sequence, not
          // a stream of disconnected prompts. The decision log keeps the clean prompt.
          const shown = questions.length > 1 ? `(${i + 1}/${questions.length}) ${prompt}` : prompt;
          const outcome = await runAskPrompt(ctx, { question: shown, options });
          if (!outcome || outcome.status === 'unavailable') {
            halted = `This host cannot prompt — ask the remaining question(s) inline: ${prompt}`;
            break;
          }
          if (outcome.status === 'cancelled') { halted = 'Interview cancelled — proceed only with what is already decided.'; break; }
          const answer = outcome.status === 'text' ? String(outcome.value ?? '').trim() : String(outcome.label ?? outcome.value ?? '').trim();
          if (answer) { addPlanDecision(scope, prompt, answer); recorded.push(`${prompt} → ${answer}`); }
        }
        refreshPlanUi(ctx);
        const head = recorded.length ? `[PLAN] recorded ${recorded.length} decision(s):\n${recorded.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '[PLAN] no decisions recorded';
        const tail = halted ? `\n${halted}` : '\nWhen intent + approach are decision-complete, call plan(propose) — the decisions travel with the plan and render on its page.';
        return clarifyResult(`${head}${tail}`);
      }

      // ── RFC gate (set/propose only) ──────────────────────────────────────────
      // Symmetric with the write-tool block in plan mode: consequential work may
      // not be planned without an accepted RFC. Resolves any supplied rfcPath,
      // falls back to a previously-linked RFC, and blocks (without mutating the
      // plan or exiting plan mode) when the work is declared consequential but no
      // valid RFC is present. Returns the resolved absolute path to associate.
      const resolveGate = (): { rfc?: string; hasNewRfc: boolean; error?: ToolCallResult } => {
        const gateError = (text: string): ToolCallResult => ({
          content: [{ type: 'text' as const, text }],
          isError: true,
          details: { action: p.action, error: 'rfc-gate' },
        }) as unknown as ToolCallResult;
        const supplied = typeof p.rfcPath === 'string' ? p.rfcPath.trim() : '';
        if (supplied) {
          const res = resolveRfcPath(planWorkspace(scope), supplied);
          if (res.error) {
            return { hasNewRfc: false, error: gateError(`[PLAN] rfcPath did not resolve: ${res.error}. Point rfcPath at the accepted RFC under .octocode/rfc/ (the folder or its RFC.md).`) };
          }
          return { rfc: res.path, hasNewRfc: true };
        }
        const existing = getPlanRfc(scope);
        // Heuristic: does the step list *look* consequential even if the caller
        // didn't say so? This makes the RFC precondition harder to skip by simply
        // omitting `consequential` — the trigger no longer rests only on self-report.
        const { consequential: inferred, signals } = inferConsequential(Array.isArray(p.steps) ? p.steps : []);
        const treatConsequential = p.consequential === true || (inferred && p.consequential !== false);
        if (treatConsequential && !existing) {
          const why = p.consequential === true
            ? 'consequential work'
            : `this looks consequential (${signals.join('; ')})`;
          return { hasNewRfc: false, error: gateError(`[PLAN] ${why} needs an accepted RFC first. Load octocode-rfc-generator, write or update the RFC, then re-call plan with rfcPath pointing at it (…/.octocode/rfc/<name>/RFC.md). If this is genuinely trivial, pass consequential:false with a short reason.`) };
        }
        // Skipping the RFC despite consequential signals costs a justification —
        // recorded in the decision log so a rubber-stamp skip is at least visible.
        if (inferred && p.consequential === false) {
          const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
          if (!reason) {
            return { hasNewRfc: false, error: gateError(`[PLAN] this looks consequential (${signals.join('; ')}) but consequential:false was set. To skip the RFC, pass reason:"…" explaining why it's safe; otherwise write an RFC and pass rfcPath.`) };
          }
          addPlanDecision(scope, `Skipped RFC despite consequential signals (${signals.join('; ')})`, reason);
        }
        return { rfc: existing, hasNewRfc: false };
      };

      switch (p.action) {
        case 'set': {
          const gate = resolveGate();
          if (gate.error) return gate.error;
          steps = setPlan(scope, Array.isArray(p.steps) ? p.steps : []);
          if (gate.hasNewRfc) setPlanRfc(scope, gate.rfc);
          writeCurrentPlanArtifacts(scope, steps, 'active');
          break;
        }
        case 'propose': {
          // Plan WITH the user first: set the plan (panel renders the checklist
          // below the editor) and ask for sign-off. No browser here — the
          // free-text row is the adjust channel.
          const gate = resolveGate();
          if (gate.error) return gate.error;
          steps = setPlan(scope, Array.isArray(p.steps) ? p.steps : [], 'draft');
          if (gate.hasNewRfc) setPlanRfc(scope, gate.rfc);
          const artifacts = writeCurrentPlanArtifacts(scope, steps, 'draft');
          refreshPlanUi(ctx);
          const outcome = ctx
            ? await runAskPrompt(ctx, {
                question: `Approve this plan? (${steps.length} steps in the panel below — ${PLAN_PROPOSE_HINT})`,
                options: [
                  { value: 'approve', label: PLAN_APPROVE_LABEL, description: PLAN_APPROVE_DESC, recommended: true },
                  { value: 'reject', label: PLAN_REJECT_LABEL, description: PLAN_REJECT_DESC },
                ],
              })
            : undefined;
          const approved = outcome?.status === 'selected' && outcome.value === 'approve';
          if (approved) {
            steps = activatePlan(scope);
            refreshPlanUi(ctx);
          }
          const verdict = (() => {
            if (!outcome || outcome.status === 'unavailable') {
              return '[PLAN] proposed, but this host cannot prompt — present the plan inline and get approval in your reply before executing.';
            }
            if (approved) {
              // The approval IS the exit from plan mode: write tools come back.
              exitPlanMode(ctx);
              return '[PLAN] approved — begin executing; keep steps updated via start/complete.';
            }
            if (outcome.status === 'text' && outcome.value) {
              return `[PLAN] adjust requested: ${outcome.value}\nRevise the plan and re-propose.`;
            }
            return '[PLAN] rejected — do not execute. Ask the user how to proceed.';
          })();

          // The draft doc is written before approval so the user can review it
          // from disk. Once approved, rewrite it with approved metadata, then ask
          // separately whether to view it. We serve over local http (not file://)
          // so the page live-reloads as the plan changes.
          let pageNote = artifacts
            ? `\nPlan doc: ${artifacts.mdPath}`
            : '\nPlan doc could not be written — continuing with the in-terminal plan.';
          if (approved) {
            const approvedArtifacts = writeCurrentPlanArtifacts(scope, steps, 'approved');
            if (approvedArtifacts) pageNote = `\nPlan doc: ${approvedArtifacts.mdPath}`;
            const wantsBrowser = ctx?.hasUI && ctx.mode === 'tui'
              ? await runAskPrompt(ctx, {
                  question: 'Show the approved plan in your browser? (hosted locally, live-updates as the plan changes)',
                  options: [
                    { value: 'yes', label: 'Open in browser', description: 'serve the plan page on localhost and open it', recommended: true },
                    { value: 'no', label: 'Not now', description: 'keep it to the terminal — /octocode-plan html opens it later' },
                  ],
                })
              : undefined;
            if (wantsBrowser?.status === 'selected' && wantsBrowser.value === 'yes') {
              const url = await servePlanPage(ctx, scope);
              pageNote = url
                ? `\nLive plan page: ${url} (local server, updates as the plan changes)`
                : '\nCould not start the local plan server — /octocode-plan html retries.';
            } else {
              pageNote += '\nTip for the user: /octocode-plan html serves it in the browser.';
            }
          }
          return {
            content: [{ type: 'text', text: `${verdict}\n${renderList(steps)}${pageNote}` }],
            details: { action: p.action, steps, addendum: renderActivePlanAddendum(scope), verdict },
          } as unknown as ToolCallResult;
        }
        case 'add':
          steps = addStep(scope, String(p.text ?? ''), p.activeForm, p.dependsOn);
          writeCurrentPlanArtifacts(scope, steps, 'active');
          break;
        case 'start':
        case 'complete':
        case 'remove': {
          const current = getPlan(scope);
          const planError = (msg: string, error: string) => ({
            content: [{ type: 'text' as const, text: `${msg}\n${renderList(current)}` }],
            isError: true,
            details: { action: p.action, steps: current, addendum: renderActivePlanAddendum(scope), error },
          }) as unknown as ToolCallResult;
          if (current.length === 0) {
            return planError(`[PLAN] no active plan — nothing to ${p.action}. Use plan set first.`, 'invalid-index');
          }
          let idx: number;
          if (p.index === undefined || p.index === null) {
            // Default targets: complete/remove act on the single current doing step;
            // start advances to the next runnable todo. Parallel doing lanes require
            // an explicit index so the wrong lane is not completed/removed silently.
            if (p.action === 'start') {
              idx = current.findIndex((s) => s.status === 'todo' && depsMet(s, current)) + 1;
            } else {
              const doing = current.map((s, i) => ({ step: s, index: i + 1 })).filter(({ step }) => step.status === 'doing');
              if (doing.length > 1) {
                return planError(`[PLAN] ${doing.length} steps are in progress — pass index to ${p.action} a specific lane. Run plan show for indices.`, 'ambiguous-target');
              }
              idx = doing[0]?.index ?? 0;
            }
            if (idx < 1) {
              const why = p.action === 'start'
                ? '[PLAN] no runnable todo step (all done or blocked)'
                : '[PLAN] no step is in progress';
              return planError(`${why} — pass index to target a specific step. Run plan show for indices.`, 'no-target');
            }
          } else {
            idx = Number(p.index);
            if (!Number.isInteger(idx) || idx < 1 || idx > current.length) {
              return planError(`[PLAN] no such step ${p.index} — plan has ${current.length} step(s). Run plan show for indices.`, 'invalid-index');
            }
            if (p.action === 'start' && !depsMet(current[idx - 1]!, current)) {
              return planError(`[PLAN] step ${idx} is blocked by dependencies — complete its prerequisites before starting it.`, 'blocked-step');
            }
          }
          steps = p.action === 'start' ? startStep(scope, idx) : p.action === 'complete' ? completeStep(scope, idx) : removeStep(scope, idx);
          writeCurrentPlanArtifacts(scope, steps, 'active');
          break;
        }
        case 'clear':
          clearPlan(scope);
          tearDownPlanHtml(scope);
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
      // Bigger plans read better as a diagram — surface the page once per set.
      const artifactHint = (p.action === 'set' || p.action === 'add' || p.action === 'start' || p.action === 'complete' || p.action === 'remove') && steps.length > 0
        ? `\nPlan doc: ${path.join(planArtifactsDir(scope), 'plan.md')}`
        : '';
      const htmlHint = p.action === 'set' && steps.length >= 4
        ? '\nTip for the user: /octocode-plan html opens a live visual plan page.'
        : '';
      return {
        content: [{ type: 'text', text: `${header}\n${renderList(steps)}${artifactHint}${htmlHint}` }],
        details: { action: p.action, steps, addendum: renderActivePlanAddendum(scope) },
      } as unknown as ToolCallResult;
    },

    renderCall(raw: unknown, theme?: PiTheme) {
      const p = raw as PlanParams;
      const extra = p.action === 'set' || p.action === 'propose' ? ` (${(p.steps ?? []).length} steps)` : p.index ? ` #${p.index}` : '';
      // Lead with the brand-painted tool title + dim args, matching bash/edit/write/memory.
      const title = cliToolTitle(theme, 'plan');
      return makeRenderer((w) => [truncateToWidth(`${title}${paint(theme, 'dim', `(${p.action}${extra})`)}`, w)]);
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
