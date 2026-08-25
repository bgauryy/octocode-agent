import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import {
  buildQueryEnvelopeSchema,
  executeQueryBatch,
  prepareQueryBatch,
  QueryBatchError,
} from '../src/tools/query-envelope.js';
import type { ToolCallResult } from '../src/types.js';

const typeBuilder = Type as unknown as (typeof import('typebox'))['Type'];

function textResult(text: string, details?: unknown): ToolCallResult {
  return { content: [{ type: 'text', text }], details };
}

describe('query envelope', () => {
  it('builds the one-field top-level contract and requires concise reasoning per query', () => {
    const schema = buildQueryEnvelopeSchema(
      typeBuilder,
      Type.Object({ value: Type.String() }, { additionalProperties: false }),
    ) as {
      properties?: {
        queries?: {
          minItems?: number;
          maxItems?: number;
          items?: {
            properties?: Record<string, { minLength?: number; maxLength?: number }>;
            required?: string[];
          };
        };
      };
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(Object.keys(schema.properties ?? {})).toEqual(['queries']);
    expect(schema.required).toContain('queries');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.queries?.minItems).toBe(1);
    expect(schema.properties?.queries?.maxItems).toBe(100);
    expect(schema.properties?.queries?.items?.properties?.reasoning).toMatchObject({
      minLength: 1,
      maxLength: 240,
    });
    expect(schema.properties?.queries?.items?.required).toEqual(['reasoning', 'value']);
    expect(schema.properties?.queries?.items?.properties).toHaveProperty('value');
  });

  it('preflights every query before execution and rejects invalid reasoning', async () => {
    const preflight = vi.fn(async (query: Record<string, unknown>, index: number) => {
      if (query.value === 'bad') throw new Error(`bad ${index}`);
    });

    await expect(prepareQueryBatch(
      { queries: [{ reasoning: 'first', value: 'ok' }, { reasoning: 'second', value: 'bad' }] },
      { preflight },
    )).rejects.toThrow(/queries\[1\].*bad 1/);
    expect(preflight).toHaveBeenCalledTimes(2);

    await expect(prepareQueryBatch(
      { queries: [{ reasoning: '   ', value: 'ok' }] },
    )).rejects.toThrow(/queries\[0\].*reasoning/);

    await expect(prepareQueryBatch(
      { queries: [{ reasoning: 'x'.repeat(241), value: 'ok' }] },
    )).rejects.toThrow(/at most 240/);
  });

  it('executes prepared queries in order with indexed progress and aggregate results', async () => {
    const events: unknown[] = [];
    const execute = vi.fn(async (query: Record<string, unknown>, index: number, _itemId: string) => {
      return textResult(`done ${String(query.value)}`, { index });
    });

    const result = await executeQueryBatch({
      toolCallId: 'call-1',
      raw: {
        queries: [
          { reasoning: 'run one', value: 'a' },
          { reasoning: 'run two', value: 'b' },
        ],
      },
      execute,
      onUpdate: (update) => events.push(update),
    });

    expect(execute.mock.calls.map((call) => [call[0].value, call[1], call[2]])).toEqual([
      ['a', 0, 'call-1:0'],
      ['b', 1, 'call-1:1'],
    ]);
    expect(events).toHaveLength(2);
    expect((result.details as { results: Array<{ index: number; reasoning: string }> }).results).toMatchObject([
      { index: 0, reasoning: 'run one' },
      { index: 1, reasoning: 'run two' },
    ]);
    expect((result.content[0] as { text: string }).text).toMatch(/2 queries succeeded/);
  });

  it('stops on the first runtime failure and reports retained prior effects', async () => {
    const applied: string[] = [];

    await expect(executeQueryBatch({
      toolCallId: 'call-2',
      raw: {
        queries: [
          { reasoning: 'apply first', value: 'a' },
          { reasoning: 'fail second', value: 'b' },
          { reasoning: 'never third', value: 'c' },
        ],
      },
      execute: async (query, index) => {
        if (index === 1) throw new Error('boom');
        applied.push(String(query.value));
        return textResult('ok');
      },
    })).rejects.toMatchObject({
      name: 'QueryBatchError',
      failedIndex: 1,
      completedCount: 1,
    });

    expect(applied).toEqual(['a']);

    try {
      await executeQueryBatch({
        toolCallId: 'call-3',
        raw: { queries: [{ reasoning: 'fail now', value: 'x' }] },
        execute: async () => { throw new Error('bad'); },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(QueryBatchError);
      expect((error as Error).message).toMatch(/queries\[0\] failed after 0 prior queries succeeded: bad/);
    }
  });

  it('does not execute when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => textResult('no'));

    await expect(executeQueryBatch({
      toolCallId: 'call-4',
      raw: { queries: [{ reasoning: 'would run', value: 'x' }] },
      signal: controller.signal,
      execute,
    })).rejects.toThrow(/aborted/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
