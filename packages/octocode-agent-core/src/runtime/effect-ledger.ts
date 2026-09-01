import { RuntimeFailure } from '../contracts/errors.js';
import type { TrustSnapshot } from '../contracts/events.js';
import { contextSha256 } from '../contracts/context-artifacts.js';
import { createEffectSet, type EffectSet, type ToolEffect } from '../contracts/tools.js';
import type { PermissionDecision } from '../contracts/permissions.js';
import type { PolicyReceipt } from './policy.js';

export type EffectLedgerState = 'started' | 'committed' | 'failed' | 'cancelled' | 'uncertain';
export interface EffectAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly operation: string;
  readonly input: unknown;
  readonly effects: EffectSet;
  /** Additive v1 metadata. Legacy receipts omit all three fields together. */
  readonly digest?: string;
  readonly expiresAt?: number;
  readonly policyRevision?: number;
  readonly policy: {
    readonly trust: TrustSnapshot;
    readonly approval: 'never' | 'on-request' | 'always';
    readonly approved: true;
    readonly permission?: PermissionDecision;
    readonly plan: { readonly authority: 'runtime'; readonly active: boolean; readonly revision: number };
    readonly lockTargets: readonly string[];
    readonly receipts: readonly PolicyReceipt[];
  };
}
export type EffectAdmissionReceiptInput = Omit<
  EffectAdmissionReceipt,
  'digest' | 'expiresAt' | 'policyRevision'
>;
export interface EffectAdmissionBinding {
  readonly expiresAt: number;
  readonly policyRevision: number;
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw new RuntimeFailure('validation', `Effect admission ${name} has an unknown field`);
}
function boundedString(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0'))
    throw new RuntimeFailure('validation', `Effect admission ${name} is invalid`);
  return value;
}
function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new RuntimeFailure('validation', `Effect admission ${name} is invalid`);
  return Number(value);
}
function assertPermissionDecision(value: unknown): void {
  if (!record(value)) throw new RuntimeFailure('validation', 'Effect admission permission receipt is invalid');
  exactKeys(value, [
    'schemaVersion', 'mode', 'approval', 'outcome', 'source', 'reason', 'reviewer', 'failedGuards',
  ], 'permission receipt');
  if (value['schemaVersion'] !== 1
    || !['strict', 'default', 'allow-all', 'invalid'].includes(String(value['mode']))
    || !['auto', 'prompt', 'mandatory', 'deny', 'invalid'].includes(String(value['approval']))
    || !['allow', 'prompt', 'deny'].includes(String(value['outcome']))
    || !['validation', 'guard', 'risk', 'mode', 'reviewer-unavailable'].includes(String(value['source'])))
    throw new RuntimeFailure('validation', 'Effect admission permission receipt is invalid');
  boundedString(value['reason'], 'permission reason');
  const reviewer = value['reviewer'];
  if (!record(reviewer)) throw new RuntimeFailure('validation', 'Effect admission permission reviewer is invalid');
  exactKeys(reviewer, ['availability', 'required'], 'permission reviewer');
  if (!['available', 'unavailable', 'invalid'].includes(String(reviewer['availability']))
    || typeof reviewer['required'] !== 'boolean')
    throw new RuntimeFailure('validation', 'Effect admission permission reviewer is invalid');
  if (!Array.isArray(value['failedGuards'])
    || value['failedGuards'].some((guard) => !['trust', 'managed', 'capability', 'sandbox', 'plan', 'lock'].includes(String(guard)))
    || new Set(value['failedGuards']).size !== value['failedGuards'].length)
    throw new RuntimeFailure('validation', 'Effect admission permission failedGuards are invalid');
}
function assertPolicyReceipt(value: unknown, expectedOrder: number): void {
  if (!record(value)) throw new RuntimeFailure('validation', 'Effect admission policy receipt is invalid');
  exactKeys(value, ['policy', 'decision', 'order'], 'policy receipt');
  boundedString(value['policy'], 'policy receipt name');
  if (value['order'] !== expectedOrder)
    throw new RuntimeFailure('validation', 'Effect admission policy receipt order is invalid');
  const decision = value['decision'];
  if (!record(decision)) throw new RuntimeFailure('validation', 'Effect admission policy decision is invalid');
  if (decision['effect'] === 'allow') exactKeys(decision, ['effect'], 'policy decision');
  else if (decision['effect'] === 'deny') {
    exactKeys(decision, ['effect', 'reason', 'category'], 'policy decision');
    boundedString(decision['reason'], 'policy denial reason');
    if (!['trust', 'approval', 'plan-policy', 'peer-lock', 'policy'].includes(String(decision['category'])))
      throw new RuntimeFailure('validation', 'Effect admission policy decision category is invalid');
  } else throw new RuntimeFailure('validation', 'Effect admission policy decision is invalid');
}
function assertPolicy(value: unknown): void {
  if (!record(value)) throw new RuntimeFailure('validation', 'Effect admission policy is invalid');
  exactKeys(value, ['trust', 'approval', 'approved', 'permission', 'plan', 'lockTargets', 'receipts'], 'policy');
  const trust = value['trust'];
  if (!record(trust)) throw new RuntimeFailure('validation', 'Effect admission trust snapshot is invalid');
  exactKeys(trust, ['workspace', 'managedOnly'], 'trust snapshot');
  if (!['trusted', 'untrusted', 'unknown'].includes(String(trust['workspace'])) || typeof trust['managedOnly'] !== 'boolean')
    throw new RuntimeFailure('validation', 'Effect admission trust snapshot is invalid');
  if (!['never', 'on-request', 'always'].includes(String(value['approval'])) || value['approved'] !== true)
    throw new RuntimeFailure('validation', 'Effect admission approval is invalid');
  if (value['permission'] !== undefined) assertPermissionDecision(value['permission']);
  const plan = value['plan'];
  if (!record(plan)) throw new RuntimeFailure('validation', 'Effect admission plan snapshot is invalid');
  exactKeys(plan, ['authority', 'active', 'revision'], 'plan snapshot');
  if (plan['authority'] !== 'runtime' || typeof plan['active'] !== 'boolean')
    throw new RuntimeFailure('validation', 'Effect admission plan snapshot is invalid');
  nonNegativeInteger(plan['revision'], 'plan revision');
  if (!Array.isArray(value['lockTargets'])
    || value['lockTargets'].some((target) => typeof target !== 'string' || target.trim().length === 0 || target.length > 4_096)
    || new Set(value['lockTargets']).size !== value['lockTargets'].length)
    throw new RuntimeFailure('validation', 'Effect admission lock targets are invalid');
  if (!Array.isArray(value['receipts']) || value['receipts'].length > 1_024)
    throw new RuntimeFailure('validation', 'Effect admission policy receipts are invalid');
  value['receipts'].forEach(assertPolicyReceipt);
}

/** Digest every execution-relevant receipt field except the digest itself. */
export function effectAdmissionDigest(value: EffectAdmissionReceipt): string {
  const { digest: _digest, ...bound } = value;
  return contextSha256(canonicalJson(bound));
}

/** Strictly validate either the legacy v1 shape or the additive integrity-bound v1 shape. */
export function assertEffectAdmissionReceipt(value: unknown): EffectAdmissionReceipt {
  if (!record(value)) throw new RuntimeFailure('validation', 'Effect admission receipt is invalid');
  exactKeys(value, [
    'schemaVersion', 'operation', 'input', 'effects', 'policy', 'digest', 'expiresAt', 'policyRevision',
  ], 'receipt');
  if (value['schemaVersion'] !== 1) throw new RuntimeFailure('validation', 'Effect admission schemaVersion is invalid');
  boundedString(value['operation'], 'operation');
  canonicalJson(value['input']);
  if (!Array.isArray(value['effects'])) throw new RuntimeFailure('validation', 'Effect admission effects are invalid');
  const canonicalEffects = createEffectSet(...value['effects'] as ToolEffect[]);
  if (canonicalJson(canonicalEffects) !== canonicalJson(value['effects']))
    throw new RuntimeFailure('validation', 'Effect admission effects are not canonical');
  assertPolicy(value['policy']);
  const metadataCount = ['digest', 'expiresAt', 'policyRevision']
    .filter((key) => value[key] !== undefined).length;
  if (metadataCount !== 0 && metadataCount !== 3)
    throw new RuntimeFailure('validation', 'Effect admission receipt metadata must be complete');
  if (metadataCount === 3) {
    const digest = value['digest'];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
      throw new RuntimeFailure('validation', 'Effect admission receipt digest is invalid');
    nonNegativeInteger(value['expiresAt'], 'receipt expiresAt');
    nonNegativeInteger(value['policyRevision'], 'policy revision');
    if (effectAdmissionDigest(value as unknown as EffectAdmissionReceipt) !== digest)
      throw new RuntimeFailure('validation', 'Effect admission receipt digest does not match');
  }
  return value as unknown as EffectAdmissionReceipt;
}

/** Add integrity, authorization-expiry, and policy-revision evidence without invalidating legacy readers. */
export function createEffectAdmissionReceipt(
  input: EffectAdmissionReceiptInput,
  binding: EffectAdmissionBinding,
): EffectAdmissionReceipt {
  assertEffectAdmissionReceipt(input);
  const draft = {
    ...structuredClone(input),
    expiresAt: nonNegativeInteger(binding.expiresAt, 'receipt expiresAt'),
    policyRevision: nonNegativeInteger(binding.policyRevision, 'policy revision'),
  } as EffectAdmissionReceipt;
  const receipt = freezeDeep({ ...draft, digest: effectAdmissionDigest(draft) });
  return assertEffectAdmissionReceipt(receipt);
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
    assertEffectAdmissionReceipt(receipt);
    const existing = this.#records.get(key);
    const fingerprint = canonicalJson(receipt);
    if (existing) return canonicalJson(existing.receipt) === fingerprint ? existing.state : 'mismatch';
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new RuntimeFailure('internal-invariant', 'Effect ledger clock is invalid');
    if (receipt.expiresAt !== undefined && receipt.expiresAt <= now)
      throw new RuntimeFailure('conflict', `Effect ${key} admission receipt expired`);
    const record = { key, receipt: freezeDeep(structuredClone(receipt)), state: 'started' as const, updatedAt: now };
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
