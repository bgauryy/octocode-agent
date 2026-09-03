import { NATIVE_DESIGN_LAYOUT } from '../../presentation/design/tokens.js';

const SEMANTIC_SURFACE_LAYOUT = Object.freeze({
  minimumWidthColumns: 20,
  maximumWidthColumns: 240,
  maximumViewportRows: 16,
  reservedRows: 8,
  wideWidthRatio: 0.66,
});

const WIDE_RAIL_LAYOUT = Object.freeze({
  minimumWidthColumns: 30,
  maximumWidthColumns: 56,
  widthRatio: 0.35,
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

/** Keep the inspector useful without allowing it to displace the conversation. */
export function resolveOpenTuiRailWidth(widthColumns: number): number {
  const width = positiveDimension(widthColumns, 'terminal width');
  return Math.min(
    WIDE_RAIL_LAYOUT.maximumWidthColumns,
    Math.max(
      WIDE_RAIL_LAYOUT.minimumWidthColumns,
      Math.floor(width * WIDE_RAIL_LAYOUT.widthRatio),
    ),
  );
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
