import { NATIVE_DESIGN_LAYOUT } from '../../presentation/design/tokens.js';

const SEMANTIC_SURFACE_LAYOUT = Object.freeze({
  minimumWidthColumns: 20,
  maximumWidthColumns: 240,
  maximumViewportRows: 16,
  reservedRows: 8,
  wideWidthRatio: 0.66,
});

export interface OpenTuiLayoutViewport {
  readonly widthColumns: number;
  readonly heightRows: number;
}

export interface OpenTuiSurfaceViewport {
  readonly widthColumns: number;
  readonly viewportRows: number;
}

function positiveDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function isNarrowOpenTuiLayout(widthColumns: number): boolean {
  return positiveDimension(widthColumns, 'terminal width') < NATIVE_DESIGN_LAYOUT.wideColumns;
}

export function resolveOpenTuiSurfaceViewport(
  viewport: OpenTuiLayoutViewport,
): OpenTuiSurfaceViewport {
  const widthColumns = positiveDimension(viewport.widthColumns, 'terminal width');
  const heightRows = positiveDimension(viewport.heightRows, 'terminal height');
  const desiredWidth = isNarrowOpenTuiLayout(widthColumns)
    ? widthColumns
    : Math.floor(widthColumns * SEMANTIC_SURFACE_LAYOUT.wideWidthRatio);
  return Object.freeze({
    widthColumns: Math.min(
      SEMANTIC_SURFACE_LAYOUT.maximumWidthColumns,
      Math.max(SEMANTIC_SURFACE_LAYOUT.minimumWidthColumns, desiredWidth),
    ),
    viewportRows: Math.max(
      1,
      Math.min(
        SEMANTIC_SURFACE_LAYOUT.maximumViewportRows,
        heightRows - SEMANTIC_SURFACE_LAYOUT.reservedRows,
      ),
    ),
  });
}
