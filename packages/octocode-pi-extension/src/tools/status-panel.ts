/**
 * status-panel — the single unified below-editor "Octocode" panel.
 *
 * Rather than three separate widgets (plan / awareness / agents) stacking under
 * the editor, this composes them into ONE widget with blank-line-separated
 * sections, so the live status reads as a cohesive block. Each source module
 * exposes a pure `*PanelLines(theme)` builder and delegates its widget rendering
 * here; this module owns the sole `octocode-status-panel` widget.
 *
 * Sections (in order): Model → Plan → Awareness → Agents. Empty sections are
 * omitted; when all are empty the widget is cleared entirely.
 *
 * Uses runtime-only imports of the section builders (called inside the renderer,
 * never at module load) so the mutual module references stay cycle-safe.
 */

import type { PiContext, PiTheme } from '../types.js';
import { paint } from '../tui/cli-design.js';
import { makeRenderer } from './render-helpers.js';
import { activePlanScope, getPlan } from './active-plan.js';
import { planPanelLines } from './plan-tool.js';
import { agentPanelLines } from './agent-tools.js';
import { awarenessPanelLines, hasCachedAwarenessSignal } from './awareness-status.js';

const WIDGET_NAME = 'octocode-status-panel';

// Height budgets so the panel never crowds the editor.
const PLAN_MAX_ROWS = 12; // step rows shown before collapsing (header excluded)
const PANEL_MAX_LINES = 24; // hard cap on total panel lines

interface BuiltPanel {
  lines: string[];
  hasVolatileSections: boolean;
}

/**
 * Collapse a header+rows section to at most maxRows rows, appending a muted
 * "… N more" line when trimmed. `section[0]` is treated as the header.
 */
export function collapseSection(section: string[], maxRows: number, noun: string): string[] {
  if (section.length <= maxRows + 1) return section;
  const [header, ...rows] = section;
  const shown = rows.slice(0, maxRows);
  return [header!, ...shown, `… ${rows.length - maxRows} more ${noun}`];
}

/**
 * The current main-agent model line (top of the panel) so the operator always sees
 * which model/provider is driving this session. Empty when the model is unknown.
 */
export function modelPanelLines(ctx: PiContext | undefined, theme?: PiTheme): string[] {
  // Only what pi does NOT already show: pi's own status row renders
  // `model: <id>` and our octocode-thinking status carries the thinking flag,
  // so this line exists solely to surface the PROVIDER when one is known.
  const id = ctx?.model?.id;
  const provider = ctx?.model?.provider;
  if (!id || !provider) return [];
  return [paint(theme, 'muted', `model: ${provider}/${id}`)];
}

/** Join non-empty sections with a single blank-line separator, within the total budget. */
function composeSections(sections: string[][]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(...section);
  }
  if (lines.length <= PANEL_MAX_LINES) return lines;
  return [...lines.slice(0, PANEL_MAX_LINES - 1), `… ${lines.length - (PANEL_MAX_LINES - 1)} more`];
}

export function composeStatusPanelLines(ctx: PiContext, theme: PiTheme | undefined, width?: number): BuiltPanel {
  const cwd = ctx.cwd ?? process.cwd();
  // Resolve the plan scope at render time, not registration time: /tree, /fork,
  // resume, and compaction can move the active branch while the widget remains
  // registered exactly once.
  const planSection = collapseSection(planPanelLines(getPlan(activePlanScope(ctx)), theme, width), PLAN_MAX_ROWS, 'steps');
  const awarenessSection = awarenessPanelLines(cwd, theme, width);
  const agentSection = agentPanelLines(theme, 6, width);
  return {
    lines: composeSections([
      modelPanelLines(ctx, theme),
      planSection,
      awarenessSection,
      agentSection,
    ]),
    hasVolatileSections: planSection.length > 0 || awarenessSection.length > 0 || agentSection.length > 0,
  };
}

/**
 * Re-render the unified below-editor status panel from live state (plan +
 * awareness + agents). Clears the widget when every section is empty. Safe to
 * call from any refresh trigger; never throws.
 */
// Set during session_shutdown so late async callbacks (worker close events,
// awareness CLI refreshes) cannot resurrect the widget into the next session.
let panelSuppressed = false;
export function suppressStatusPanel(): void {
  panelSuppressed = true;
}
export function resumeStatusPanel(): void {
  panelSuppressed = false;
}

// Register-once per session ctx (pi docs: set a widget/footer ONCE and repaint
// via tui.requestRender). Re-calling setWidget with a fresh factory on every
// refresh — every 1s ledger tick, every plan mutation — rebuilt the component
// each time, which showed up as below-editor flicker and scroll jumps mid-turn.
// Keyed by ctx so a new session re-registers; cleared when the panel empties.
const panelRegisteredCtxs = new WeakSet<object>();
const panelRequestRenderByCtx = new WeakMap<object, () => void>();
const panelMinHeightByCtx = new WeakMap<object, Map<number, number>>();

function stabilizePanelHeight(ctx: PiContext, width: number, built: BuiltPanel): string[] {
  const lines = built.lines;
  // Model-only is the stable baseline. Do not keep blank rows from a finished
  // plan/agent/awareness burst forever; once volatile sections are gone, reset
  // the remembered height to the actual model-only height.
  if (!built.hasVolatileSections) {
    panelMinHeightByCtx.set(ctx, new Map([[width, lines.length]]));
    return lines;
  }
  let heights = panelMinHeightByCtx.get(ctx);
  if (!heights) {
    heights = new Map<number, number>();
    panelMinHeightByCtx.set(ctx, heights);
  }
  const previous = heights.get(width) ?? 0;
  const next = Math.min(PANEL_MAX_LINES, Math.max(previous, lines.length));
  heights.set(width, next);
  return lines.length >= next ? lines : [...lines, ...Array.from({ length: next - lines.length }, () => '')];
}

export function resetStatusPanelStateForTests(): void {
  panelSuppressed = false;
}

function clearPanel(ctx: PiContext): void {
  ctx.ui?.setWidget?.(WIDGET_NAME, undefined);
  panelRegisteredCtxs.delete(ctx);
  panelRequestRenderByCtx.delete(ctx);
  panelMinHeightByCtx.delete(ctx);
}

export function refreshStatusPanel(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  if (panelSuppressed) {
    clearPanel(ctx);
    return;
  }
  const cwd = ctx.cwd ?? process.cwd();
  const hasPlan = getPlan(activePlanScope(ctx)).length > 0;
  const hasAgents = agentPanelLines().length > 0;
  const hasAwareness = hasCachedAwarenessSignal(cwd);
  const hasModel = modelPanelLines(ctx).length > 0;
  if (!hasPlan && !hasAgents && !hasAwareness && !hasModel) {
    clearPanel(ctx);
    return;
  }
  if (panelRegisteredCtxs.has(ctx)) {
    // Live update: the registered renderer reads state at render time — just repaint.
    panelRequestRenderByCtx.get(ctx)?.();
    return;
  }
  panelRegisteredCtxs.add(ctx);
  ctx.ui?.setWidget?.(
    WIDGET_NAME,
    (tui: unknown, theme: PiTheme) => {
      panelRequestRenderByCtx.set(ctx, () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.());
      return makeRenderer((width) => {
        // Width flows into every section builder so lines are clipped at the
        // source (pi errors on over-wide lines); makeRenderer stays the net.
        const built = composeStatusPanelLines(ctx, theme, width);
        const lines = stabilizePanelHeight(ctx, width, built);
        return lines.length > 0 ? lines : [''];
      });
    },
    { placement: 'belowEditor' },
  );
}
