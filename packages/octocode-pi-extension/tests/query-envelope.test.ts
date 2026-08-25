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

function textResult(text: string, details?: unknown, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text }], details, isError };
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
    expect((result.details as { results: Array<{ index: number; reasoning: string; status: string; summary: string }> }).results).toMatchObject([
      { index: 0, reasoning: 'run one', status: 'success', summary: 'done a' },
      { index: 1, reasoning: 'run two', status: 'success', summary: 'done b' },
    ]);
    expect((result.content[0] as { text: string }).text).toMatch(/2 queries succeeded/);
  });

  it('stops on the first runtime failure and retains success, failure, and not-run rows', async () => {
    const applied: string[] = [];
    let failure: QueryBatchError | undefined;

    try {
      await executeQueryBatch({
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
          return textResult('first applied');
        },
      });
    } catch (error) {
      failure = error as QueryBatchError;
    }

    expect(failure).toBeInstanceOf(QueryBatchError);
    expect(failure).toMatchObject({
      name: 'QueryBatchError',
      failedIndex: 1,
      completedCount: 1,
      rows: [
        { index: 0, reasoning: 'apply first', status: 'success', summary: 'first applied' },
        { index: 1, reasoning: 'fail second', status: 'failed', summary: 'boom' },
        { index: 2, reasoning: 'never third', status: 'not-run', summary: 'not run' },
      ],
    });
    expect(failure?.message).toMatch(/\[0\].*first applied[\s\S]*\[1\].*boom[\s\S]*\[2\].*not run/);
    expect(applied).toEqual(['a']);
  });

  it('reports the real structured failure instead of the first successful progress line', async () => {
    let failure: QueryBatchError | undefined;
    try {
      await executeQueryBatch({
        toolCallId: 'call-3',
        raw: {
          queries: [
            { reasoning: 'measure source', value: 'wc' },
            { reasoning: 'build package', value: 'build' },
          ],
        },
        execute: async (_query, index) => index === 0
          ? textResult('118 15059 prompt.ts')
          : textResult(
            'Synced 11 skill(s) into skills\nTS2322: actual compilation failure\n(exit 2)',
            { code: 2, stdout: 'Synced 11 skill(s) into skills\n', stderr: 'building package\nTS2322: actual compilation failure' },
            true,
          ),
      });
    } catch (error) {
      failure = error as QueryBatchError;
    }

    expect(failure).toBeInstanceOf(QueryBatchError);
    expect(failure?.rows[1]).toMatchObject({
      index: 1,
      status: 'failed',
      summary: 'TS2322: actual compilation failure',
    });
    expect(failure?.message).toContain('TS2322: actual compilation failure');
    expect(failure?.message).not.toMatch(/failed[^\n]*Synced 11 skill/);
  });

  it('preserves the concise single-query error contract', async () => {
    try {
      await executeQueryBatch({
        toolCallId: 'call-4',
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
