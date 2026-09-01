import { describe, expect, it } from 'vitest';

import { NATIVE_DESIGN_LAYOUT } from '../src/presentation/design/tokens.js';
import {
  isNarrowOpenTuiLayout,
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
});
