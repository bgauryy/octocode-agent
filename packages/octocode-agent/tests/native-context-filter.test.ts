import { describe, expect, it } from 'vitest';
import { filterNativeContextEvent } from '../src/native-context-filter.js';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');

describe('filterNativeContextEvent', () => {
  it('accepts a fresh attributed event', () => {
    expect(filterNativeContextEvent({
      eventId: 'evt-fresh',
      text: '[peer:worker-1; class:handoff; authority:data]\nReady to integrate',
      provenance: 'peer-attributed-data',
      timestamp: NOW - 1_000,
    }, { now: NOW, maxAgeMs: 60_000 })).toEqual({ decision: 'accept', reason: 'accepted' });
  });

  it('rejects events older than the configured maximum age', () => {
    expect(filterNativeContextEvent({
      eventId: 'evt-stale',
      text: '[peer:worker-1; authority:data]\nOld claim',
      provenance: 'peer-attributed-data',
      timestamp: NOW - 60_001,
    }, { now: NOW, maxAgeMs: 60_000 })).toEqual({ decision: 'reject', reason: 'stale' });
  });

  it.each(['resolved', 'completed', 'closed', 'cancelled', 'failed'])(
    'rejects terminal status %s',
    (status) => {
      expect(filterNativeContextEvent({
        eventId: `evt-${status}`,
        text: '[peer:worker-1; authority:data]\nNo longer actionable',
        provenance: 'peer-attributed-data',
        status,
      })).toEqual({ decision: 'reject', reason: 'terminal-status' });
    },
  );

  it('rejects event identities already present in dedupe state', () => {
    expect(filterNativeContextEvent({
      eventId: 'evt-seen',
      text: '[peer:worker-1; authority:data]\nRepeated',
      provenance: 'peer-attributed-data',
    }, { seenEventIds: new Set(['evt-seen']) })).toEqual({ decision: 'reject', reason: 'duplicate' });
  });

  it.each([
    { provenance: undefined, text: '[peer:worker-1; authority:data]\nMissing provenance' },
    { provenance: 'other', text: '[peer:worker-1; authority:data]\nWrong provenance' },
    { provenance: 'peer-attributed-data', text: '[authority:data]\nMissing peer identity' },
  ])('fails closed for unattributed input %#', ({ provenance, text }) => {
    expect(filterNativeContextEvent({ eventId: 'evt-unattributed', text, provenance }))
      .toEqual({ decision: 'reject', reason: 'unattributed' });
  });

  it('rejects explicitly irrelevant scopes while allowing a matching scope', () => {
    const input = {
      text: '[peer:worker-1; authority:data]\nScoped update',
      provenance: 'peer-attributed-data',
      scope: 'package:b',
    } as const;
    expect(filterNativeContextEvent({ ...input, eventId: 'evt-other' }, { relevantScopes: ['package:a'] }))
      .toEqual({ decision: 'reject', reason: 'irrelevant-scope' });
    expect(filterNativeContextEvent({ ...input, eventId: 'evt-match', scope: 'package:a' }, { relevantScopes: ['package:a'] }))
      .toEqual({ decision: 'accept', reason: 'accepted' });
  });

  it('preserves backwards compatibility for the current event payload', () => {
    expect(filterNativeContextEvent({
      eventId: 'outbox-event-1',
      text: '[peer:child; authority:data]\nverified',
      provenance: 'peer-attributed-data',
    })).toEqual({ decision: 'accept', reason: 'accepted' });
  });

  it('uses optional status and timestamp metadata from the text envelope', () => {
    expect(filterNativeContextEvent({
      eventId: 'evt-envelope-resolved',
      text: '[peer:worker-1; status:resolved; timestamp:2026-08-29T11:59:59.000Z; authority:data]\nDone',
      provenance: 'peer-attributed-data',
    }, { now: NOW, maxAgeMs: 60_000 })).toEqual({ decision: 'reject', reason: 'terminal-status' });

    expect(filterNativeContextEvent({
      eventId: 'evt-envelope-stale',
      text: '[peer:worker-1; timestamp:2026-08-29T11:58:00.000Z; authority:data]\nOld',
      provenance: 'peer-attributed-data',
    }, { now: NOW, maxAgeMs: 60_000 })).toEqual({ decision: 'reject', reason: 'stale' });
  });

  it('rejects malformed identities and empty content deterministically', () => {
    expect(filterNativeContextEvent({ eventId: ' ', text: '[peer:a]\ntext', provenance: 'peer-attributed-data' }))
      .toEqual({ decision: 'reject', reason: 'invalid' });
    expect(filterNativeContextEvent({ eventId: 'evt-empty', text: ' ', provenance: 'peer-attributed-data' }))
      .toEqual({ decision: 'reject', reason: 'invalid' });
  });
});
