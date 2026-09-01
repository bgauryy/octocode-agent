import { describe, expect, it } from 'vitest';
import {
  InMemoryEffectLedger,
  RuntimeFailure,
  assertEffectAdmissionReceipt,
  createEffectSet,
  createEffectAdmissionReceipt,
  effectAdmissionDigest,
  type EffectAdmissionReceipt,
} from '../src/index.js';

const receipt = (input: unknown): EffectAdmissionReceipt => ({
  schemaVersion: 1,
  operation: 'tool:publish',
  input,
  effects: createEffectSet('write', 'network'),
  policy: {
    trust: { workspace: 'trusted', managedOnly: false },
    approval: 'always',
    approved: true,
    plan: { authority: 'runtime', active: true, revision: 7 },
    lockTargets: ['src/output.ts'],
    receipts: [{ policy: 'managed', order: 0, decision: { effect: 'allow' } }],
  },
});

describe('effect admission', () => {
  it('canonicalizes composite effects and rejects an empty capability', () => {
    expect(createEffectSet('network', 'write', 'network')).toEqual(['network', 'write']);
    expect(() => createEffectSet()).toThrow(RuntimeFailure);
    expect(() => createEffectSet('read', 'filesystem' as never)).toThrow(/unknown tool effect/i);
  });

  it('binds admission to final input, composite effects, and policy evidence', async () => {
    const ledger = new InMemoryEffectLedger(() => 42);
    expect(await ledger.begin('effect-1', receipt({ path: 'src/output.ts', body: 'one' }))).toBe('acquired');
    await ledger.settle('effect-1', 'committed');

    expect(await ledger.begin('effect-1', receipt({ body: 'one', path: 'src/output.ts' }))).toBe('committed');
    expect(await ledger.begin('effect-1', receipt({ path: 'src/output.ts', body: 'changed' }))).toBe('mismatch');
    expect(ledger.list()).toEqual([
      expect.objectContaining({
        key: 'effect-1',
        state: 'committed',
        updatedAt: 42,
        receipt: expect.objectContaining({ effects: ['network', 'write'] }),
      }),
    ]);
  });

  it('binds expiry and policy revision into a verified digest', () => {
    const bound = createEffectAdmissionReceipt(
      receipt({ path: 'src/output.ts', body: 'one' }),
      { expiresAt: 100, policyRevision: 3 },
    );

    expect(bound).toMatchObject({
      expiresAt: 100,
      policyRevision: 3,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(effectAdmissionDigest(bound)).toBe(bound.digest);
    expect(assertEffectAdmissionReceipt(bound)).toBe(bound);
    expect(() => assertEffectAdmissionReceipt({ ...bound, digest: '0'.repeat(64) }))
      .toThrow(/digest/i);
  });

  it('strictly rejects partial metadata, unknown fields, and expired first admission', async () => {
    expect(() => assertEffectAdmissionReceipt({
      ...receipt({ path: 'src/output.ts' }),
      expiresAt: 100,
    })).toThrow(/metadata/i);
    expect(() => assertEffectAdmissionReceipt({
      ...receipt({ path: 'src/output.ts' }),
      unexpected: true,
    })).toThrow(/field/i);

    const ledger = new InMemoryEffectLedger(() => 100);
    const expired = createEffectAdmissionReceipt(
      receipt({ path: 'src/output.ts' }),
      { expiresAt: 100, policyRevision: 1 },
    );
    await expect(ledger.begin('expired', expired)).rejects.toMatchObject({ category: 'conflict' });
    expect(ledger.list()).toEqual([]);
  });

  it('never treats expiry as permission to replay an admitted effect', async () => {
    let now = 99;
    const ledger = new InMemoryEffectLedger(() => now);
    const bound = createEffectAdmissionReceipt(
      receipt({ path: 'src/output.ts' }),
      { expiresAt: 100, policyRevision: 1 },
    );
    await expect(ledger.begin('crash-left', bound)).resolves.toBe('acquired');
    now = 100;
    await expect(ledger.begin('crash-left', bound)).resolves.toBe('started');
    await ledger.settle('crash-left', 'uncertain');
    await expect(ledger.begin('crash-left', bound)).resolves.toBe('uncertain');
  });

  it('keeps the first terminal effect outcome immutable', async () => {
    const ledger = new InMemoryEffectLedger(() => 42);
    expect(await ledger.begin('effect-terminal', receipt({ path: 'src/output.ts' }))).toBe('acquired');
    await ledger.settle('effect-terminal', 'committed');
    await expect(ledger.settle('effect-terminal', 'committed')).resolves.toBeUndefined();
    await expect(ledger.settle('effect-terminal', 'failed')).rejects.toMatchObject({ category: 'conflict' });
    await expect(ledger.get('effect-terminal')).resolves.toMatchObject({ state: 'committed' });
  });
});
