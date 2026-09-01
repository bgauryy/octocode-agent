import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionId, toolCallId, type ToolExecutionInput } from '@octocodeai/agent-core';

import { createNativeFfmpegTool, type NativeFfmpegProcessPort } from '../src/native-ffmpeg-tool.js';
import { createNodeNativeFileSystemPort } from '../src/native-file-tool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-native-ffmpeg-'));
  roots.push(root);
  return root;
}

function execution(cwd: string, input: unknown, signal = new AbortController().signal): ToolExecutionInput {
  return {
    input,
    callId: toolCallId('ffmpeg:test'),
    context: {
      sessionId: sessionId('ffmpeg:test'),
      cwd,
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe('native runFfmpeg tool', () => {
  it('publishes input-sensitive effects, lock targets, and a dedicated process lane', async () => {
    const root = await workspace();
    const tool = createNativeFfmpegTool({
      workspace: root,
      fileSystem: createNodeNativeFileSystemPort(root),
      resolveBinary: () => '/opt/tools/ffmpeg',
      process: { run: vi.fn() },
    });

    expect(tool.policy.resolve?.({ binary: 'ffprobe', args: ['-i', '{{input:0}}'], inputs: ['clip.mp4'] })).toEqual({
      effects: ['read', 'process'],
      trust: 'workspace',
      approval: 'on-request',
    });
    expect(tool.policy.resolve?.({ binary: 'ffmpeg', args: ['-i', '{{input:0}}', '{{output:0}}'], inputs: ['clip.mp4'], outputs: ['out.mp4'] })).toEqual({
      effects: ['read', 'process', 'write'],
      trust: 'workspace',
      approval: 'on-request',
    });
    expect(tool.policy.lockTarget?.({ outputs: ['out.mp4', 'nested/out.wav'] })).toEqual(['nested/out.wav', 'out.mp4']);
    expect(tool.policy.concurrency?.({})).toEqual({ lane: 'native-ffmpeg', maxActive: 1 });
  });

  it('authorizes declared paths, substitutes every placeholder, and preserves progress plus stdout', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'clip.mp4'), 'fixture');
    const run = vi.fn<NativeFfmpegProcessPort['run']>(async (request) => {
      request.onProgress?.({ frame: '2', out_time: '00:00:00.100000', speed: '1x' });
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.from('probe-output'),
        stderr: '',
        stderrTruncated: false,
        timedOut: false,
        cancelled: false,
        durationMs: 12,
      };
    });
    const tool = createNativeFfmpegTool({
      workspace: root,
      fileSystem: createNodeNativeFileSystemPort(root),
      resolveBinary: (name) => `/opt/tools/${name}`,
      process: { run },
    });
    const request = execution(root, {
      binary: 'ffprobe',
      args: ['-v', 'error', '-i', '{{input:0}}'],
      inputs: ['clip.mp4'],
      captureStdout: true,
    });

    const result = await tool.execute(request);

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/opt/tools/ffprobe',
      args: expect.arrayContaining(['-hide_banner', path.join(await fs.realpath(root), 'clip.mp4')]),
    }));
    expect(result.content).toMatchObject({
      binary: 'ffprobe',
      exitCode: 0,
      stdout: { encoding: 'base64', value: Buffer.from('probe-output').toString('base64'), byteLength: 12 },
    });
    expect(request.update).toHaveBeenCalledWith(expect.objectContaining({ kind: 'progress', message: expect.stringContaining('time=') }));
  });

  it('fails closed on undeclared path-like argv, traversal, protocols, devices, and malformed placeholders', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'clip.mp4'), 'fixture');
    const process: NativeFfmpegProcessPort = { run: vi.fn() };
    const tool = createNativeFfmpegTool({
      workspace: root,
      fileSystem: createNodeNativeFileSystemPort(root),
      resolveBinary: () => '/opt/tools/ffmpeg',
      process,
    });
    const inputs = [
      { args: ['-i', 'clip.mp4'], inputs: ['clip.mp4'] },
      { args: ['-i', '{{input:0}}'], inputs: ['../clip.mp4'] },
      { args: ['-i', 'https://example.com/video.mp4'] },
      { args: ['-f', 'avfoundation', '-i', '1'] },
      { args: ['-i', '{{input:9}}'], inputs: ['clip.mp4'] },
    ];
    for (const input of inputs) {
      await expect(tool.execute(execution(root, { binary: 'ffmpeg', ...input }))).rejects.toThrow();
    }
    expect(process.run).not.toHaveBeenCalled();
  });

  it('returns explicit timeout and cancellation outcomes without hiding process state', async () => {
    const root = await workspace();
    const process: NativeFfmpegProcessPort = {
      run: vi.fn(async () => ({
        exitCode: null,
        signal: 'SIGKILL' as NodeJS.Signals,
        stdout: Buffer.alloc(0),
        stderr: 'terminated',
        stderrTruncated: false,
        timedOut: true,
        cancelled: false,
        durationMs: 250,
      })),
    };
    const tool = createNativeFfmpegTool({
      workspace: root,
      fileSystem: createNodeNativeFileSystemPort(root),
      resolveBinary: () => '/opt/tools/ffmpeg',
      process,
    });
    const result = await tool.execute(execution(root, { binary: 'ffmpeg', args: ['-version'] }));
    expect(result).toMatchObject({ ok: false, category: 'timeout', content: { timedOut: true, cancelled: false, signal: 'SIGKILL' } });
  });
});
