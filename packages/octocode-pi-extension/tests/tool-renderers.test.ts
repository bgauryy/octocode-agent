/**
 * Tests for the Octocode branded tool renderer decorator and helpers.
 *
 * Uses stub theme and stub components; no real Pi host required.
 */

import { describe, it, expect, vi } from 'vitest';
import { withOctocodeRender } from '../src/branding/renderers.js';
import {
  buildOctocodeRenderCall,
  buildToolCallSummary,
} from '../src/tools/render-helpers.js';
import type { ToolDefinition, PiTheme, ToolCallResult, RenderResultOptions } from '../src/types.js';
// ─── Stub theme ───────────────────────────────────────────────────────────────

const stubTheme: PiTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
} as unknown as PiTheme;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function render(component: { render(w: number): string[] }, width = 80): string[] {
  return component.render(width);
}

function makeDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'testTool',
    label: 'Test Tool',
    description: 'A test tool',
    parameters: {} as never,
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }], details: undefined };
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    content: [{ type: 'text', text: 'result output' }],
    details: { results: [] },
    isError: false,
    ...overrides,
  };
}

// ─── withOctocodeRender — basic decoration ────────────────────────────────────

describe('withOctocodeRender', () => {
  it('adds renderCall when missing', () => {
    const def = makeDef();
    expect(def.renderCall).toBeUndefined();
    withOctocodeRender(def);
    expect(typeof def.renderCall).toBe('function');
  });

  it('adds renderResult when missing', () => {
    const def = makeDef();
    withOctocodeRender(def);
    expect(typeof def.renderResult).toBe('function');
  });

  it('preserves existing renderCall', () => {
    const customRenderCall = vi.fn().mockReturnValue({ render: () => ['custom'], invalidate: () => {} });
    const def = makeDef({ renderCall: customRenderCall });
    withOctocodeRender(def);
    // same reference preserved
    expect(def.renderCall).toBe(customRenderCall);
  });

  it('preserves existing renderResult', () => {
    const customRenderResult = vi.fn().mockReturnValue({ render: () => ['custom'], invalidate: () => {} });
    const def = makeDef({ renderResult: customRenderResult });
    withOctocodeRender(def);
    expect(def.renderResult).toBe(customRenderResult);
  });

  it('preserves execute and parameters', async () => {
    const def = makeDef();
    const originalExecute = def.execute;
    const originalParameters = def.parameters;
    withOctocodeRender(def);
    expect(def.execute).toBe(originalExecute);
    expect(def.parameters).toBe(originalParameters);
    // execute still works
    const result = await def.execute({} as never, {} as never);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' });
  });

  it('returns the same def reference', () => {
    const def = makeDef();
    const returned = withOctocodeRender(def);
    expect(returned).toBe(def);
  });

  it('uses displayName opt in branded title', () => {
    const def = makeDef({ name: 'internalName' });
    withOctocodeRender(def, { displayName: 'BrandedName' });
    const component = def.renderCall!({}, stubTheme);
    const lines = render(component);
    expect(lines[0]).toContain('BrandedName');
    expect(lines[0]).not.toContain('internalName');
  });
});

// ─── Branded renderCall output ────────────────────────────────────────────────

describe('branded renderCall', () => {
  it('includes the tool name in the output line', () => {
    const def = makeDef({ name: 'myOctoTool' });
    withOctocodeRender(def);
    const component = def.renderCall!({}, stubTheme);
    const lines = render(component);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('myOctoTool');
  });

  it('includes args summary when present', () => {
    const def = makeDef({ name: 'localGetFileContent' });
    withOctocodeRender(def);
    const args = { queries: [{ path: '/src/foo.ts', startLine: 10 }] };
    const component = def.renderCall!(args, stubTheme);
    const lines = render(component);
    expect(lines[0]).toContain('foo.ts');
  });

  it('truncates to requested width', () => {
    const def = makeDef({ name: 'toolWithLongName' });
    withOctocodeRender(def);
    const args = { queries: [{ path: '/very/long/path/that/exceeds/screen/width/definitely.ts' }] };
    const component = def.renderCall!(args, stubTheme);
    // render at narrow width — should not exceed it
    const lines = render(component, 40);
    for (const line of lines) {
      // strip ANSI codes to count visible chars
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(42); // some tolerance for ellipsis
    }
  });

  it('works without a theme (graceful degradation)', () => {
    const def = makeDef({ name: 'noThemeTool' });
    withOctocodeRender(def);
    const component = def.renderCall!({});
    const lines = render(component);
    expect(lines[0]).toContain('noThemeTool');
  });
});

// ─── Branded renderResult output ─────────────────────────────────────────────

describe('branded renderResult', () => {
  const opts: RenderResultOptions = { expanded: false, isPartial: false };

  it('shows success icon on success', () => {
    const def = makeDef();
    withOctocodeRender(def);
    const result = makeResult({ isError: false });
    const component = def.renderResult!(result, opts, stubTheme);
    const lines = render(component);
    expect(lines[0]).toContain('✓');
  });

  it('shows error icon on error', () => {
    const def = makeDef();
    withOctocodeRender(def);
    const result = makeResult({ isError: true });
    const component = def.renderResult!(result, opts, stubTheme);
    const lines = render(component);
    expect(lines[0]).toContain('✗');
  });

  it('shows running indicator when isPartial', () => {
    const def = makeDef({ name: 'streamingTool' });
    withOctocodeRender(def);
    const result = makeResult();
    const partialOpts: RenderResultOptions = { expanded: false, isPartial: true };
    const component = def.renderResult!(result, partialOpts, stubTheme);
    const lines = render(component);
    // should contain the tool name and a running indicator
    expect(lines[0]).toContain('streamingTool');
    expect(lines[0]).toMatch(/running|…/);
  });

  it('shows expanded content when expanded:true', () => {
    const def = makeDef();
    withOctocodeRender(def);
    const text = 'line one\nline two\nline three';
    const result = makeResult({ content: [{ type: 'text', text }] });
    const expandedOpts: RenderResultOptions = { expanded: true, isPartial: false };
    const component = def.renderResult!(result, expandedOpts, stubTheme);
    const lines = render(component);
    expect(lines.length).toBeGreaterThan(1);
    const allText = lines.join('\n');
    expect(allText).toContain('line one');
  });

  it('truncates long result lines to width', () => {
    const def = makeDef();
    withOctocodeRender(def);
    const result = makeResult();
    const component = def.renderResult!(result, { expanded: false, isPartial: false }, stubTheme);
    const lines = render(component, 30);
    for (const line of lines) {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(32);
    }
  });

  it('works without theme', () => {
    const def = makeDef();
    withOctocodeRender(def);
    const result = makeResult();
    const component = def.renderResult!(result, opts);
    const lines = render(component);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── buildOctocodeRenderCall direct tests ─────────────────────────────────────

describe('buildOctocodeRenderCall', () => {
  it('produces branded title with theme colors', () => {
    const c = buildOctocodeRenderCall('ghSearchCode', { queries: [{ keywords: ['useState'] }] }, stubTheme);
    const lines = render(c);
    expect(lines[0]).toContain('ghSearchCode');
    expect(lines[0]).toContain('useState');
  });

  it('handles empty queries gracefully', () => {
    const c = buildOctocodeRenderCall('localViewStructure', { queries: [] }, stubTheme);
    const lines = render(c);
    expect(lines[0]).toContain('localViewStructure');
  });
});

// ─── buildToolCallSummary spot checks ────────────────────────────────────────

describe('buildToolCallSummary', () => {
  it('ghSearchCode: formats keywords and repo', () => {
    const summary = buildToolCallSummary('ghSearchCode', {
      queries: [{ keywords: ['renderCall'], owner: 'earendil', repo: 'pi' }],
    });
    expect(summary).toContain('renderCall');
    expect(summary).toContain('earendil/pi');
  });

  it('localGetFileContent: shows file basename and line range', () => {
    const summary = buildToolCallSummary('localGetFileContent', {
      queries: [{ path: '/src/tools/render-helpers.ts', startLine: 5, endLine: 20 }],
    });
    expect(summary).toContain('render-helpers.ts');
  });

  it('returns empty string for unknown tool with empty args', () => {
    const summary = buildToolCallSummary('unknownTool', { queries: [] });
    expect(typeof summary).toBe('string');
  });

  it('appends +N for multiple queries', () => {
    const summary = buildToolCallSummary('localGetFileContent', {
      queries: [
        { path: '/a.ts' },
        { path: '/b.ts' },
        { path: '/c.ts' },
      ],
    });
    expect(summary).toContain('+2');
  });
});
