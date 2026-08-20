/**
 * Octocode branded TUI renderers for Pi extension tool rows.
 *
 * Wrap point: `registerUniqueTool` in src/tools/octocode-tools.ts — the single
 * funnel through which every Octocode extension tool registration passes. Decorating
 * there means zero per-tool changes and zero risk of missing a future tool.
 *
 * Strategy: only inject branded renderCall / renderResult when the tool definition
 * does not already provide its own. Custom renderers in individual tool files are
 * preserved as-is; this decorator fills only the gaps.
 */

import {
  buildOctocodeRenderCall,
  buildOctocodeRenderResult,
} from '../tools/render-helpers.js';
import type { ToolDefinition, PiTheme, RenderContext, ToolCallResult, RenderResultOptions } from '../types.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface WithOctocodeRenderOpts {
  /**
   * Override the display name shown in the title line.
   * Defaults to `def.name`.
   */
  displayName?: string;
}

/**
 * Decorator that adds Octocode-branded `renderCall` / `renderResult` to a tool
 * definition when that definition does not already supply its own renderers.
 *
 * Signature: `withOctocodeRender(def, opts?) → def`
 *
 * The returned object is the same reference with slots filled in-place so
 * downstream code that holds the reference sees the updated renderers.
 */
export function withOctocodeRender<T extends ToolDefinition>(
  def: T,
  opts: WithOctocodeRenderOpts = {},
): T {
  const displayName = opts.displayName ?? def.name;

  if (!def.renderCall) {
    def.renderCall = function brandedRenderCall(
      args: unknown,
      theme?: PiTheme,
      _context?: RenderContext,
    ) {
      return buildOctocodeRenderCall(displayName, args, theme);
    };
  }

  if (!def.renderResult) {
    def.renderResult = function brandedRenderResult(
      result: ToolCallResult,
      opts: RenderResultOptions,
      theme?: PiTheme,
      _context?: RenderContext,
    ) {
      return buildOctocodeRenderResult(displayName, result, opts, theme);
    };
  }

  return def;
}
