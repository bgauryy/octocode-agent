import { describe, expect, it } from 'vitest';

import { NATIVE_DESIGN_LAYOUT } from '../src/presentation/design/tokens.js';
import {
  isNarrowOpenTuiLayout,
  resolveOpenTuiRailWidth,
  resolveOpenTuiSurfaceViewport,
} from '../src/terminal/opentui/layout-policy.js';

describe('OpenTUI layout policy', () => {
  it('consumes the canonical wide breakpoint', () => {
    expect(isNarrowOpenTuiLayout(NATIVE_DESIGN_LAYOUT.wideColumns - 1)).toBe(true);
    expect(isNarrowOpenTuiLayout(NATIVE_DESIGN_LAYOUT.wideColumns)).toBe(false);
  });

  it('owns bounded semantic-surface viewport sizing', () => {
    expect(resolveOpenTuiSurfaceViewport({ widthColumns: 60, heightRows: 20 }))
      .toEqual({ widthColumns: 60, viewportRows: 12 });
    expect(resolveOpenTuiSurfaceViewport({ widthColumns: 80, heightRows: 24 }))
      .toEqual({ widthColumns: 52, viewportRows: 16 });
    expect(resolveOpenTuiSurfaceViewport({ widthColumns: 1_000, heightRows: 1_000 }))
      .toEqual({ widthColumns: 240, viewportRows: 16 });
  });

  it('caps the wide activity rail so conversation remains the primary surface', () => {
    expect(resolveOpenTuiRailWidth(72)).toBe(30);
    expect(resolveOpenTuiRailWidth(80)).toBe(30);
    expect(resolveOpenTuiRailWidth(120)).toBe(42);
    expect(resolveOpenTuiRailWidth(240)).toBe(56);
    expect(resolveOpenTuiRailWidth(1_000)).toBe(56);
  });
});
