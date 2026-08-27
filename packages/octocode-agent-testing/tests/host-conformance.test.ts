import { describe, expect, test } from 'vitest';
import {
  CANONICAL_HOST_SCENARIOS,
  EffectLedger,
  compareHostTraces,
  createCanonicalHostAdapter,
  normalizeHostTrace,
  runCanonicalHostConformance,
  runHostConformance,
  type CanonicalScenarioHandlers,
  type HostConformanceAdapter,
} from '../src/host-conformance.js';

function canonicalHandlers(suffix = ''): CanonicalScenarioHandlers {
  return Object.fromEntries(CANONICAL_HOST_SCENARIOS.map((scenario) => [
    scenario.id,
    (_scenario, context) => {
      context.emit('scenario.started', {
        scenario: scenario.id,
        cwd: suffix ? '/native/workspace' : '/pi/workspace',
        timestamp: suffix ? 99 : 10,
      });
      context.effect({ id: `${scenario.id}:effect`, kind: 'projection', effectful: false });
      context.emit('scenario.finished', { scenario: scenario.id, outcome: `ok${suffix}` });
    },
  ])) as CanonicalScenarioHandlers;
}

describe('canonical host scenario matrix', () => {
  test('freezes the RFC 14-scenario inventory with distinct ids', () => {
    expect(CANONICAL_HOST_SCENARIOS).toHaveLength(14);
    expect(new Set(CANONICAL_HOST_SCENARIOS.map(({ id }) => id)).size).toBe(14);
    expect(CANONICAL_HOST_SCENARIOS.map(({ id }) => id)).toEqual([
      'lifecycle-clean-start-stop',
      'deterministic-model-turn',
      'streaming-tool-flow',
      'policy-denial-matrix',
      'tool-failure-matrix',
      'cancellation-boundaries',
      'steer-and-follow-up',
      'session-lifecycle',
      'compaction-matrix',
      'ui-semantics',
      'transport-corpus',
      'persistence-restart',
      'codex-hook-lifecycle',
      'plugin-lifecycle',
    ]);
    for (const scenario of CANONICAL_HOST_SCENARIOS) {
      expect(scenario.requirements.length).toBeGreaterThan(0);
      expect(scenario.input).toBeTypeOf('object');
    }
  });

  test('runs all canonical scenarios through reusable structural Pi/native adapters', async () => {
    const report = await runCanonicalHostConformance({
      baseline: createCanonicalHostAdapter('pi', canonicalHandlers()),
      candidate: createCanonicalHostAdapter('native', canonicalHandlers()),
      normalization: { workspaceRoots: ['/pi/workspace', '/native/workspace'] },
    });

    expect(report.matched).toBe(true);
    expect(report.results).toHaveLength(14);
    expect(report.results.every((result) => result.trace.matched && result.effects.matched)).toBe(true);
    expect(report.results.every((result) => result.trace.baselineHash === result.trace.candidateHash)).toBe(true);
  });

  test('fails closed when a canonical adapter omits a scenario handler', async () => {
    const handlers = canonicalHandlers() as Partial<CanonicalScenarioHandlers>;
    delete handlers['plugin-lifecycle'];
    const adapter = createCanonicalHostAdapter('incomplete', handlers as CanonicalScenarioHandlers);
    await expect(adapter.execute(CANONICAL_HOST_SCENARIOS.at(-1)!, {
      emit: () => undefined,
      effect: () => undefined,
      signal: new AbortController().signal,
    })).rejects.toThrow(/missing canonical handler.*plugin-lifecycle/i);
  });

  test('rejects scenario ids outside the canonical inventory', async () => {
    const adapter = createCanonicalHostAdapter('pi', canonicalHandlers());
    await expect(adapter.execute({ id: 'invented', input: {} }, {
      emit: () => undefined,
      effect: () => undefined,
      signal: new AbortController().signal,
    })).rejects.toThrow(/unknown canonical host scenario/i);
  });
});

describe('trace normalization and comparison', () => {
  test('normalizes volatile fields, paths, ANSI, errors, maps, and sets deterministically', () => {
    const first = normalizeHostTrace([{ sequence: 9, timestamp: 10, kind: 'ready', data: {
      cwd: '/one', text: '\u001b[31mok\u001b[0m', nested: { sessionId: 'a', value: 1 },
      error: new Error('boom'), map: new Map([['b', 2], ['a', 1]]), set: new Set(['b', 'a']),
    } }], { workspaceRoots: ['/one'] });
    const second = normalizeHostTrace([{ sequence: 1, timestamp: 99, kind: 'ready', data: {
      cwd: '/two', text: 'ok', nested: { sessionId: 'b', value: 1 },
      error: new Error('boom'), map: new Map([['a', 1], ['b', 2]]), set: new Set(['a', 'b']),
    } }], { workspaceRoots: ['/two'] });

    expect(first).toEqual(second);
    expect(compareHostTraces(first, second)).toMatchObject({ matched: true, firstDivergence: null });
  });

  test('reports stable hashes and the first semantic divergence', async () => {
    const adapter = (name: string, outcome: string): HostConformanceAdapter => ({
      name,
      async execute(_scenario, context) {
        context.emit('turn.started', { requestId: `${name}-request` });
        context.emit('turn.finished', { outcome });
      },
    });
    const report = await runHostConformance({
      baseline: adapter('pi', 'ok'), candidate: adapter('native', 'different'),
      scenarios: [CANONICAL_HOST_SCENARIOS[1]!],
    });

    expect(report.matched).toBe(false);
    expect(report.results[0]?.trace.firstDivergence).toMatchObject({
      index: 1, path: '$[1].data.outcome', baseline: 'ok', candidate: 'different',
    });
    expect(report.results[0]?.trace.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.results[0]?.trace.candidateHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('effect ledger', () => {
  test('rejects duplicate effect ids and effectful shadow operations', () => {
    const live = new EffectLedger('live');
    live.record({ id: 'effect-1', kind: 'tool', effectful: true });
    expect(() => live.record({ id: 'effect-1', kind: 'tool', effectful: true })).toThrow(/duplicate effect/i);
    const shadow = new EffectLedger('shadow');
    expect(() => shadow.record({ id: 'effect-2', kind: 'model', effectful: true })).toThrow(/shadow/i);
    expect(() => shadow.record({ id: 'pure-1', kind: 'projection', effectful: false })).not.toThrow();
  });

  test('compares effect ledgers independently from traces', async () => {
    const adapter = (name: string, kind: string): HostConformanceAdapter => ({
      name,
      async execute(_scenario, context) {
        context.emit('same');
        context.effect({ id: 'effect-1', kind, effectful: false });
      },
    });
    const report = await runHostConformance({
      baseline: adapter('pi', 'projection'), candidate: adapter('native', 'different'),
      scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
    });
    expect(report.results[0]?.trace.matched).toBe(true);
    expect(report.results[0]?.effects.matched).toBe(false);
    expect(report.results[0]?.effects.firstDivergence?.path).toBe('$[0].kind');
  });

  test('aborts before invoking adapters when the signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    const adapter = createCanonicalHostAdapter('pi', canonicalHandlers());
    await expect(runHostConformance({
      baseline: adapter, candidate: adapter, scenarios: [CANONICAL_HOST_SCENARIOS[0]!], signal: controller.signal,
    })).rejects.toThrow('stop now');
  });

  test('accepts legacy event arrays and structured adapter receipts', async () => {
    const baseline: HostConformanceAdapter = {
      name: 'pi',
      async execute() {
        return [{ kind: 'same', data: { cwd: '/pi' } }];
      },
    };
    const candidate: HostConformanceAdapter = {
      name: 'native',
      async execute() {
        return {
          events: [{ kind: 'same', data: { cwd: '/native' } }],
          effects: [{ id: 'pure', kind: 'projection', effectful: false }],
        };
      },
    };
    const report = await runHostConformance({
      baseline: {
        ...baseline,
        async execute(scenario, context) {
          context.effect({ id: 'pure', kind: 'projection', effectful: false });
          return baseline.execute(scenario, context);
        },
      },
      candidate,
      scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
      normalization: { workspaceRoots: ['/pi', '/native'] },
    });
    expect(report.matched).toBe(true);
  });
});
