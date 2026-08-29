import { RuntimeFailure } from '../contracts/errors.js';
import type { TrustSnapshot } from '../contracts/events.js';
import type { EffectSet } from '../contracts/tools.js';
import type { PolicyReceipt } from './policy.js';

export type EffectLedgerState = 'started' | 'committed' | 'failed' | 'cancelled' | 'uncertain';
export interface EffectAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly operation: string;
  readonly input: unknown;
  readonly effects: EffectSet;
  readonly policy: {
    readonly trust: TrustSnapshot;
    readonly approval: 'never' | 'on-request' | 'always';
    readonly approved: true;
    readonly plan: { readonly authority: 'runtime'; readonly active: boolean; readonly revision: number };
    readonly lockTargets: readonly string[];
    readonly receipts: readonly PolicyReceipt[];
  };
}
export interface EffectLedgerRecord { readonly key: string; readonly state: EffectLedgerState; readonly updatedAt: number; readonly receipt: EffectAdmissionReceipt; }
export type EffectAdmissionResult = 'acquired' | EffectLedgerState | 'mismatch';
export interface EffectLedgerPort {
  begin(key: string, receipt: EffectAdmissionReceipt): Promise<EffectAdmissionResult>;
  settle(key: string, state: Exclude<EffectLedgerState, 'started'>): Promise<void>;
  get(key: string): Promise<EffectLedgerRecord | undefined>;
}
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuntimeFailure('validation', 'Effect admission receipt requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new RuntimeFailure('validation', 'Effect admission receipt must be acyclic');
    seen.add(value);
    try { return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`; }
    finally { seen.delete(value); }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new RuntimeFailure('validation', 'Effect admission receipt must be acyclic');
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
    } finally { seen.delete(value); }
  }
  throw new RuntimeFailure('validation', 'Effect admission receipt must be JSON-compatible');
}
function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}
export class InMemoryEffectLedger implements EffectLedgerPort {
  readonly #records = new Map<string, EffectLedgerRecord>();
  readonly #now: () => number;
  constructor(now: () => number) { this.#now = now; }
  async begin(key: string, receipt: EffectAdmissionReceipt): Promise<EffectAdmissionResult> {
    const existing = this.#records.get(key);
    const fingerprint = canonicalJson(receipt);
    if (existing) return canonicalJson(existing.receipt) === fingerprint ? existing.state : 'mismatch';
    const record = { key, receipt: freezeDeep(structuredClone(receipt)), state: 'started' as const, updatedAt: this.#now() };
    this.#records.set(key, Object.freeze(record));
    return 'acquired';
  }
  async settle(key: string, state: Exclude<EffectLedgerState, 'started'>): Promise<void> {
    const current = this.#records.get(key);
    if (!current) throw new RuntimeFailure('internal-invariant', `Effect ${key} was not admitted`);
    if (current.state !== 'started') {
      if (current.state === state) return;
      throw new RuntimeFailure('conflict', `Effect ${key} is already terminal with state ${current.state}`);
    }
    this.#records.set(key, Object.freeze({ ...current, state, updatedAt: this.#now() }));
  }
  async get(key: string): Promise<EffectLedgerRecord | undefined> { return this.#records.get(key); }
  list(): readonly EffectLedgerRecord[] { return [...this.#records.values()]; }
}
