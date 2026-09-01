import { describe, expect, it, vi } from 'vitest';

import { sessionId, toolCallId, type ToolExecutionInput } from '@octocodeai/agent-core';

import {
  createNativeArtifactMediaTool,
  type NativeArtifactMediaToolOptions,
} from '../src/native-artifact-media.js';
import type { NativeFfmpegProcessPort } from '../src/native-ffmpeg-tool.js';
import type { NativeFileBinarySnapshot, NativeFileSystemPort } from '../src/native-file-tool.js';

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function execution(input: unknown): ToolExecutionInput {
  const signal = new AbortController().signal;
  return {
    input,
    callId: toolCallId('artifact-media:test'),
    context: {
      sessionId: sessionId('artifact-media:test'),
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

function snapshot(path: string, bytes: Buffer, sha256 = 'a'.repeat(64)): NativeFileBinarySnapshot {
  return { path, contentBase64: bytes.toString('base64'), bytes: bytes.byteLength, sha256 };
}

function fileSystem(files: Readonly<Record<string, NativeFileBinarySnapshot>>): NativeFileSystemPort {
  return {
    authorizeExternalPath: vi.fn(async (requested, kind) => ({ path: requested, hostPath: `/cap/${requested}`, kind })),
    readBinary: vi.fn(async (requested) => files[requested] ?? null),
    snapshot: vi.fn(),
    replace: vi.fn(),
    delete: vi.fn(),
  };
}

function options(
  fs: NativeFileSystemPort,
  runner: NativeFfmpegProcessPort = { run: vi.fn() },
): NativeArtifactMediaToolOptions {
  return {
    workspace: process.cwd(),
    fileSystem: fs,
    resolveBinary: (name) => `/opt/bin/${name}`,
    process: runner,
  };
}

describe('native artifact media tool', () => {
  it('publishes bounded input-sensitive effects and output locks', () => {
    const tool = createNativeArtifactMediaTool(options(fileSystem({})));
    expect(tool.policy.resolve?.({ operation: 'inspect', path: 'image.png' })).toEqual({
      effects: ['read', 'process'], trust: 'workspace', approval: 'on-request',
    });
    expect(tool.policy.resolve?.({ operation: 'extract-frame', path: 'clip.mp4', outputPath: 'artifacts/frame.png' })).toEqual({
      effects: ['read', 'process', 'write'], trust: 'workspace', approval: 'on-request',
    });
    expect(tool.policy.lockTarget?.({ operation: 'extract-frame', outputPath: 'artifacts/frame.png' }))
      .toEqual(['artifacts/frame.png']);
    expect(tool.policy.concurrency?.({})).toEqual({ lane: 'native-ffmpeg', maxActive: 1 });
  });

  it('perceives a verified workspace image as inline image plus integrity-bound artifact', async () => {
    const fs = fileSystem({ 'image.png': snapshot('image.png', pngBytes) });
    const run = vi.fn<NativeFfmpegProcessPort['run']>();
    const tool = createNativeArtifactMediaTool(options(fs, { run }));
    const result = await tool.execute(execution({ operation: 'inspect', path: 'image.png' }));

    expect(result.ok).toBe(true);
    expect(result.content).toEqual({
      schemaVersion: 1,
      parts: [
        { type: 'text', text: 'Inspected image image.png (image/png, 8 bytes).' },
        {
          type: 'image', mediaType: 'image/png', data: { encoding: 'base64', value: pngBytes.toString('base64') },
          byteLength: 8, filename: 'image.png',
        },
        {
          type: 'artifact', artifact: {
            schemaVersion: 1, artifactId: `artifact-${'a'.repeat(20)}`, kind: 'image', path: 'image.png',
            mediaType: 'image/png', byteLength: 8, sha256: 'a'.repeat(64), title: 'image.png',
          },
        },
      ],
    });
    expect(fs.readBinary).toHaveBeenCalledWith('image.png', 67_108_864, expect.any(AbortSignal));
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the existing supervised ffprobe path for audio/video metadata', async () => {
    const media = Buffer.from('synthetic-media');
    const fs = fileSystem({ 'clip.mp4': snapshot('clip.mp4', media, 'b'.repeat(64)) });
    const run = vi.fn<NativeFfmpegProcessPort['run']>(async () => ({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.5' },
      })),
      stderr: '', stderrTruncated: false, timedOut: false, cancelled: false, durationMs: 12,
    }));
    const tool = createNativeArtifactMediaTool(options(fs, { run }));
    const result = await tool.execute(execution({ operation: 'inspect', path: 'clip.mp4' }));

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/opt/bin/ffprobe',
      args: expect.arrayContaining(['-show_streams', '-show_format', '/cap/clip.mp4']),
      maxStdoutBytes: 1_048_576,
      captureStdout: true,
    }));
    expect(result.content).toMatchObject({
      schemaVersion: 1,
      parts: [
        { type: 'text', text: expect.stringContaining('"codec_name":"h264"') },
        { type: 'artifact', artifact: { kind: 'video', mediaType: 'video/mp4', path: 'clip.mp4', sha256: 'b'.repeat(64) } },
      ],
    });
  });

  it('authors one frame through supervised FFmpeg then verifies the output through the filesystem port', async () => {
    const source = snapshot('clip.mp4', Buffer.from('clip'), 'b'.repeat(64));
    const output = snapshot('artifacts/frame.png', pngBytes, 'c'.repeat(64));
    const fs = fileSystem({ 'clip.mp4': source, 'artifacts/frame.png': output });
    const run = vi.fn<NativeFfmpegProcessPort['run']>(async () => ({
      exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: '', stderrTruncated: false,
      timedOut: false, cancelled: false, durationMs: 9,
    }));
    const tool = createNativeArtifactMediaTool(options(fs, { run }));
    const result = await tool.execute(execution({
      operation: 'extract-frame', path: 'clip.mp4', outputPath: 'artifacts/frame.png', atSeconds: 1.25,
    }));

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/opt/bin/ffmpeg',
      args: expect.arrayContaining(['-ss', '1.25', '-i', '/cap/clip.mp4', '-frames:v', '1', '/cap/artifacts/frame.png']),
    }));
    expect(fs.authorizeExternalPath).toHaveBeenCalledWith('clip.mp4', 'input', expect.any(AbortSignal));
    expect(fs.authorizeExternalPath).toHaveBeenCalledWith('artifacts/frame.png', 'output', expect.any(AbortSignal));
    expect(result.content).toMatchObject({
      parts: [
        { type: 'text', text: 'Extracted frame at 1.25 seconds to artifacts/frame.png.' },
        { type: 'image', mediaType: 'image/png', filename: 'frame.png' },
        { type: 'artifact', artifact: { path: 'artifacts/frame.png', sha256: 'c'.repeat(64) } },
      ],
    });
  });

  it('fails closed when FFprobe returns malformed or oversized metadata', async () => {
    const fs = fileSystem({ 'clip.mp4': snapshot('clip.mp4', Buffer.from('clip')) });
    const run = vi.fn<NativeFfmpegProcessPort['run']>(async () => ({
      exitCode: 0, signal: null, stdout: Buffer.from('{bad'), stderr: '', stderrTruncated: false,
      timedOut: false, cancelled: false, durationMs: 1,
    }));
    const tool = createNativeArtifactMediaTool(options(fs, { run }));
    await expect(tool.execute(execution({ operation: 'inspect', path: 'clip.mp4' })))
      .rejects.toThrow(/metadata/i);
  });
});
