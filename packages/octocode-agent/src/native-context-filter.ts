export type NativeContextFilterReason =
  | 'accepted'
  | 'invalid'
  | 'unattributed'
  | 'duplicate'
  | 'oversized'
  | 'terminal-status'
  | 'stale'
  | 'irrelevant-scope';

export type NativeContextFilterDecision =
  | { readonly decision: 'accept'; readonly reason: 'accepted' }
  | { readonly decision: 'reject'; readonly reason: Exclude<NativeContextFilterReason, 'accepted'> };

export interface NativeContextEventCandidate {
  readonly eventId: unknown;
  readonly text: unknown;
  readonly provenance: unknown;
  readonly timestamp?: number | string;
  readonly status?: string;
  readonly scope?: string;
}

export interface NativeContextFilterOptions {
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly maxTextBytes?: number;
  readonly seenEventIds?: ReadonlySet<string> | readonly string[];
  readonly relevantScopes?: readonly string[];
}

const TERMINAL_STATUSES = new Set([
  'cancelled',
  'closed',
  'completed',
  'done',
  'failed',
  'rejected',
  'resolved',
  'terminal',
]);

function reject(reason: Exclude<NativeContextFilterReason, 'accepted'>): NativeContextFilterDecision {
  return { decision: 'reject', reason };
}

function parseEnvelope(text: string): ReadonlyMap<string, string> {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine.startsWith('[') || !firstLine.endsWith(']')) return new Map();

  const metadata = new Map<string, string>();
  for (const field of firstLine.slice(1, -1).split(';')) {
    const separator = field.indexOf(':');
    if (separator < 1) continue;
    const key = field.slice(0, separator).trim().toLowerCase();
    const value = field.slice(separator + 1).trim();
    if (key && value && !metadata.has(key)) metadata.set(key, value);
  }
  return metadata;
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim().toLowerCase();
  return result || undefined;
}

function parseTimestamp(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  return Date.parse(trimmed);
}

function containsEventId(seen: NativeContextFilterOptions['seenEventIds'], eventId: string): boolean {
  if (!seen) return false;
  return Array.isArray(seen)
    ? seen.includes(eventId)
    : (seen as ReadonlySet<string>).has(eventId);
}

/**
 * Decides whether attributed peer context is suitable for model-visible persistence.
 * This function does not mutate dedupe state; callers record accepted event IDs.
 */
export function filterNativeContextEvent(
  candidate: NativeContextEventCandidate,
  options: NativeContextFilterOptions = {},
): NativeContextFilterDecision {
  const eventId = typeof candidate.eventId === 'string' ? candidate.eventId.trim() : '';
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
  if (!eventId || !text) return reject('invalid');
  if (options.maxTextBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxTextBytes) || options.maxTextBytes < 1) return reject('invalid');
    if (new TextEncoder().encode(text).byteLength > options.maxTextBytes) return reject('oversized');
  }

  const envelope = parseEnvelope(text);
  const peer = envelope.get('peer')?.trim();
  if (candidate.provenance !== 'peer-attributed-data' || !peer) return reject('unattributed');
  if (containsEventId(options.seenEventIds, eventId)) return reject('duplicate');

  const status = normalized(candidate.status) ?? normalized(envelope.get('status'));
  if (status && TERMINAL_STATUSES.has(status)) return reject('terminal-status');

  const rawTimestamp = candidate.timestamp ?? envelope.get('timestamp');
  const timestamp = parseTimestamp(rawTimestamp);
  if (timestamp !== undefined && !Number.isFinite(timestamp)) return reject('invalid');
  if (options.maxAgeMs !== undefined) {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) return reject('invalid');
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now)) return reject('invalid');
    if (timestamp !== undefined && now - timestamp > options.maxAgeMs) return reject('stale');
  }

  const scope = normalized(candidate.scope) ?? normalized(envelope.get('scope'));
  if (scope && options.relevantScopes && options.relevantScopes.length > 0) {
    const relevantScopes = new Set(options.relevantScopes.map(normalized).filter((value): value is string => value !== undefined));
    if (!relevantScopes.has(scope)) return reject('irrelevant-scope');
  }

  return { decision: 'accept', reason: 'accepted' };
}
