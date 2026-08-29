import { describe, expect, it } from 'vitest';
import {
  InMemoryEffectLedger,
  RuntimeFailure,
  createEffectSet,
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

  it('keeps the first terminal effect outcome immutable', async () => {
    const ledger = new InMemoryEffectLedger(() => 42);
    expect(await ledger.begin('effect-terminal', receipt({ path: 'src/output.ts' }))).toBe('acquired');
    await ledger.settle('effect-terminal', 'committed');
    await expect(ledger.settle('effect-terminal', 'committed')).resolves.toBeUndefined();
    await expect(ledger.settle('effect-terminal', 'failed')).rejects.toMatchObject({ category: 'conflict' });
    await expect(ledger.get('effect-terminal')).resolves.toMatchObject({ state: 'committed' });
  });
});
