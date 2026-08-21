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
  const id = ctx?.model?.id;
  if (!id) return [];
  const provider = ctx?.model?.provider;
  const label = provider ? `${provider}/${id}` : id;
  const think = ctx?.model?.reasoning ? '  ·  thinking' : '';
  return [paint(theme, 'muted', `model: ${label}${think}`)];
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

export function refreshStatusPanel(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  if (panelSuppressed) {
    ctx.ui?.setWidget?.(WIDGET_NAME, undefined);
    return;
  }
  const cwd = ctx.cwd ?? process.cwd();
  const planScope = activePlanScope(ctx);
  const hasPlan = getPlan(planScope).length > 0;
  const hasAgents = agentPanelLines().length > 0;
  const hasAwareness = hasCachedAwarenessSignal(cwd);
  const hasModel = !!ctx.model?.id;
  if (!hasPlan && !hasAgents && !hasAwareness && !hasModel) {
    ctx.ui?.setWidget?.(WIDGET_NAME, undefined);
    return;
  }
  ctx.ui?.setWidget?.(
    WIDGET_NAME,
    (_tui: unknown, theme: PiTheme) =>
      makeRenderer(() => {
        const lines = composeSections([
          modelPanelLines(ctx, theme),
          collapseSection(planPanelLines(getPlan(planScope), theme), PLAN_MAX_ROWS, 'steps'),
          awarenessPanelLines(cwd, theme),
          agentPanelLines(theme),
        ]);
        // makeRenderer already truncates every emitted line to width, so no inner pass.
        return lines.length > 0 ? lines : [''];
      }),
    { placement: 'belowEditor' },
  );
}
