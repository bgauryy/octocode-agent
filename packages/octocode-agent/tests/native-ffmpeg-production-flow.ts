import fs from 'node:fs/promises';
import path from 'node:path';

import { sessionId, toolCallId } from '@octocodeai/agent-core';

import { createNativeFfmpegTool } from '../src/native-ffmpeg-tool.js';
import { NativeRustFileSystemClient } from '../src/native-rust-file-system.js';

async function main(): Promise<void> {
  const workspace = process.argv[2];
  const rustBinary = process.argv[3];
  if (!workspace || !rustBinary) throw new Error('usage: native-ffmpeg-production-flow <workspace> <octocode-agent-fs>');
  const client = new NativeRustFileSystemClient({ binaryPath: path.resolve(rustBinary), workspace: path.resolve(workspace) });
  const updates: unknown[] = [];
  const signal = new AbortController().signal;
  const context = {
    sessionId: sessionId('production:ffmpeg'),
    cwd: workspace,
    mode: 'headless' as const,
    trust: { workspace: 'trusted' as const, managedOnly: false },
    signal,
  };
  try {
    await client.ready();
    const tool = createNativeFfmpegTool({ workspace, fileSystem: client });
    const encode = await tool.execute({
      input: {
        binary: 'ffmpeg',
        args: ['-y', '-i', '{{input:0}}', '-c:a', 'libmp3lame', '{{output:0}}'],
        inputs: ['input.wav'],
        outputs: ['output.mp3'],
      },
      callId: toolCallId('production:encode'), context, signal,
      update: async (update) => { updates.push(update); },
    });
    const probe = await tool.execute({
      input: {
        binary: 'ffprobe',
        args: ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', '-i', '{{input:0}}'],
        inputs: ['output.mp3'],
        captureStdout: true,
      },
      callId: toolCallId('production:probe'), context, signal,
      update: async () => undefined,
    });
    const stat = await fs.stat(path.join(workspace, 'output.mp3'));
    process.stdout.write(`${JSON.stringify({ encode, probe, outputBytes: stat.size, progressUpdates: updates.length })}\n`);
    if (!encode.ok || !probe.ok || stat.size === 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
