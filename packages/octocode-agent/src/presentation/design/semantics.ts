export type NativeDesignTone = 'info' | 'success' | 'warning' | 'error' | 'count';

export const NATIVE_DESIGN_TONE_CUES = Object.freeze({
  info: Object.freeze({ marker: 'i', label: 'info' }),
  success: Object.freeze({ marker: '✓', label: 'success' }),
  warning: Object.freeze({ marker: '!', label: 'warning' }),
  error: Object.freeze({ marker: '×', label: 'error' }),
  count: Object.freeze({ marker: '#', label: 'count' }),
} satisfies Readonly<Record<NativeDesignTone, { readonly marker: string; readonly label: string }>>);

export function toolStatusTone(status: string): NativeDesignTone {
  if (status === 'success') return 'success';
  if (status === 'blocked') return 'warning';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'info';
}
