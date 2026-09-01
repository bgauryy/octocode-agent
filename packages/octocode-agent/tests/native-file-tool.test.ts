import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonSchemaError, sessionId, type ToolExecutionInput } from '@octocodeai/agent-core';
import {
  createNativeFileTool,
  createNodeNativeFileSystemPort,
  type NativeFileSystemPort,
  type NativeFileToolOptions,
} from '../src/native-file-tool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-native-file-'));
  roots.push(root);
  return root;
}

function request(input: unknown, cwd: string, signal = new AbortController().signal): ToolExecutionInput {
  return {
    input,
    callId: 'file-call' as never,
    context: {
      sessionId: sessionId('file-session'),
      cwd,
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

function nodeTool(options: Omit<NativeFileToolOptions, 'fileSystem'>) {
  return createNativeFileTool({
    ...options,
    fileSystem: createNodeNativeFileSystemPort(options.workspace),
  });
}

describe('native file tool', () => {
  it('keeps model-facing edit semantics in TypeScript while delegating filesystem commits through the port', async () => {
    const root = await workspace();
    const baseline = {
      path: 'a.txt',
      content: 'one one',
      validUtf8: true,
      bytes: 7,
      sha256: '1'.repeat(64),
    };
    const fileSystem: NativeFileSystemPort = {
      authorizeExternalPath: vi.fn(),
      readBinary: vi.fn(),
      snapshot: vi.fn(async () => baseline),
      replace: vi.fn(async (input) => ({
        path: input.path,
        bytes: Buffer.byteLength(input.content),
        sha256: '2'.repeat(64),
        previousSha256: input.expectedSha256,
      })),
      delete: vi.fn(async () => ({ path: 'a.txt', previousSha256: '1'.repeat(64) })),
    };
    const tool = createNativeFileTool({ workspace: root, fileSystem });

    const result = await tool.execute(
      request(
        {
          operation: 'edit',
          path: 'a.txt',
          oldText: 'one',
          newText: 'two',
          replaceAll: true,
          expectedSha256: baseline.sha256,
        },
        root,
      ),
    );

    expect(fileSystem.snapshot).toHaveBeenCalledWith('a.txt', 1024 * 1024, expect.any(AbortSignal));
    expect(fileSystem.replace).toHaveBeenCalledWith(
      {
        path: 'a.txt',
        content: 'two two',
        expectedSha256: baseline.sha256,
        maxBytes: 1024 * 1024,
      },
      expect.any(AbortSignal),
    );
    expect(result.content).toEqual({
      operation: 'edit',
      path: 'a.txt',
      sha256: '2'.repeat(64),
      bytes: 7,
      previousSha256: baseline.sha256,
    });
  });

  it('publishes strict operation schemas and input-sensitive policy metadata', async () => {
    const root = await workspace();
    const tool = nodeTool({ workspace: root });

    expect(jsonSchemaError({ operation: 'read', path: 'a.txt' }, tool.inputSchema)).toBeUndefined();
    expect(
      jsonSchemaError(
        {
          operation: 'write',
          path: 'a.txt',
          content: 'a',
          expectedSha256: null,
        },
        tool.inputSchema,
      ),
    ).toBeUndefined();
    expect(
      jsonSchemaError(
        {
          operation: 'edit',
          path: 'a.txt',
          oldText: 'a',
          newText: 'b',
          expectedSha256: 'a'.repeat(64),
        },
        tool.inputSchema,
      ),
    ).toBeUndefined();
    expect(jsonSchemaError({ operation: 'delete', path: 'a.txt', expectedSha256: 'a'.repeat(64) }, tool.inputSchema)).toBeUndefined();
    expect(jsonSchemaError({ operation: 'read', path: 'a.txt', extra: true }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ operation: 'write', path: 'a.txt', content: 'a' }, tool.inputSchema)).toBeDefined();
    expect(
      jsonSchemaError(
        {
          operation: 'edit',
          path: 'a.txt',
          oldText: '',
          newText: 'b',
          expectedSha256: 'a'.repeat(64),
        },
        tool.inputSchema,
      ),
    ).toBeDefined();

    expect(tool.policy.resolve?.({ operation: 'read', path: 'a.txt' })).toEqual({
      effects: ['read'],
      trust: 'none',
      approval: 'never',
    });
    expect(tool.policy.resolve?.({ operation: 'write', path: 'a.txt' })).toEqual({
      effects: ['write'],
      trust: 'workspace',
      approval: 'on-request',
    });
    expect(tool.policy.resolve?.({ operation: 'delete', path: 'a.txt' })).toEqual({
      effects: ['write', 'destructive'],
      trust: 'workspace',
      approval: 'on-request',
    });
    expect(tool.policy.concurrency?.({ operation: 'read', path: 'a.txt' })).toEqual({ lane: 'native-file-read', maxActive: 4 });
    expect(tool.policy.concurrency?.({ operation: 'edit', path: 'a.txt' })).toEqual({ lane: 'native-file-mutate', maxActive: 1 });
    expect(tool.policy.lockTarget?.({ operation: 'write', path: 'a.txt' })).toEqual([
      path.join(await fs.realpath(root), 'a.txt'),
    ]);
    expect(tool.policy.lockTarget?.({ operation: 'write', path: '../outside.txt' })).toEqual([]);
  });

  it('reads bounded UTF-8 content with a stable SHA-256 precondition', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    const tool = nodeTool({ workspace: root, maxReadBytes: 5 });
    const result = await tool.execute(request({ operation: 'read', path: 'a.txt' }, root));

    expect(result.content).toEqual({
      operation: 'read',
      path: 'a.txt',
      content: 'hello',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    await fs.writeFile(path.join(root, 'big.txt'), '123456');
    await expect(tool.execute(request({ operation: 'read', path: 'big.txt' }, root))).rejects.toThrow(/maximum.*bytes/i);
  });

  it('rejects lexical escapes and every symlink traversal', async () => {
    const root = await workspace();
    const outside = await workspace();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'escape'));
    const tool = nodeTool({ workspace: root });

    await expect(tool.execute(request({ operation: 'read', path: '../secret.txt' }, root))).rejects.toThrow(/workspace/i);
    await expect(tool.execute(request({ operation: 'read', path: 'escape/secret.txt' }, root))).rejects.toThrow(/symbolic link/i);
  });

  it('atomically writes, edits, and deletes only with current preconditions', async () => {
    const root = await workspace();
    const tool = nodeTool({ workspace: root });
    const created = await tool.execute(
      request(
        {
          operation: 'write',
          path: 'a.txt',
          content: 'one one',
          expectedSha256: null,
        },
        root,
      ),
    );
    const first = created.content as { sha256: string };
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one one');

    await expect(
      tool.execute(
        request(
          {
            operation: 'write',
            path: 'a.txt',
            content: 'lost',
            expectedSha256: null,
          },
          root,
        ),
      ),
    ).rejects.toThrow(/precondition/i);
    const edited = await tool.execute(
      request(
        {
          operation: 'edit',
          path: 'a.txt',
          oldText: 'one',
          newText: 'two',
          replaceAll: true,
          expectedSha256: first.sha256,
        },
        root,
      ),
    );
    const second = edited.content as { sha256: string };
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('two two');
    await expect(
      tool.execute(
        request(
          {
            operation: 'edit',
            path: 'a.txt',
            oldText: 'two',
            newText: 'three',
            expectedSha256: first.sha256,
          },
          root,
        ),
      ),
    ).rejects.toThrow(/stale|precondition/i);

    await tool.execute(request({ operation: 'delete', path: 'a.txt', expectedSha256: second.sha256 }, root));
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.readdir(root)).filter((name) => name.includes('.octocode-'))).toEqual([]);
  });

  it('rechecks the snapshot immediately before commit and honors cancellation', async () => {
    const root = await workspace();
    const target = path.join(root, 'a.txt');
    await fs.writeFile(target, 'one');
    const baseline = await nodeTool({ workspace: root }).execute(request({ operation: 'read', path: 'a.txt' }, root));
    const expectedSha256 = (baseline.content as { sha256: string }).sha256;
    const tool = nodeTool({
      workspace: root,
      beforeCommit: async () => {
        await fs.writeFile(target, 'raced');
      },
    });
    await expect(tool.execute(request({ operation: 'write', path: 'a.txt', content: 'two', expectedSha256 }, root))).rejects.toThrow(/changed|stale/i);
    expect(await fs.readFile(target, 'utf8')).toBe('raced');

    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute(request({ operation: 'read', path: 'a.txt' }, root, controller.signal))).rejects.toThrow(/cancelled/i);
  });
});
