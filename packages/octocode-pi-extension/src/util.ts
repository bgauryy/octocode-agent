import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from '@earendil-works/pi-coding-agent';

export interface TextResult<T = unknown> {
  content: Array<{ type: 'text'; text: string }>;
  details: T;
}

export function textResult<T = undefined>(text: string, details?: T): TextResult<T> {
  return { content: [{ type: 'text', text }], details: details as T };
}

/** Keep tool output inside Pi's per-result budget and say when it was cut. */
export function capOutput(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): string {
  const cut = truncateHead(text, { maxBytes, maxLines });
  if (!cut.truncated) return cut.content;
  return `${cut.content}\n\n[Output truncated: ${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}).]`;
}

export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
