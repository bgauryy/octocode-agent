import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assemblePrompt, type ModelMessage, type PromptSnapshot } from '@octocodeai/agent-core';
import { EXTERNAL_AGENT_AWARENESS_PROMPT } from '@octocodeai/octocode-awareness';
import { buildOctocodeSystemPrompt, repositoryDirectories } from '@octocodeai/octocode-shared';

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_INSTRUCTION_FILES = 16;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_NATIVE_PROMPT_BYTES = 256 * 1024;

export interface NativeInstructionFile {
  readonly path: string;
  readonly content: string;
}

export interface NativePromptRecord {
  readonly schemaVersion: 1;
  readonly promptVersion: 'octocode-native-v1';
  readonly semanticDigest: string;
  readonly sha256: string;
  readonly content: string;
}

export function nativePromptRecord(snapshot: PromptSnapshot): NativePromptRecord {
  const message = nativeSystemMessageFromSnapshot(snapshot);
  return Object.freeze({
    schemaVersion: 1,
    promptVersion: 'octocode-native-v1',
    semanticDigest: snapshot.semanticDigest,
    sha256: createHash('sha256').update(message.content).digest('hex'),
    content: message.content,
  });
}

export function parseNativePromptRecord(value: unknown): NativePromptRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<NativePromptRecord>;
  if (record.schemaVersion !== 1 || record.promptVersion !== 'octocode-native-v1') return undefined;
  if (typeof record.content !== 'string' || Buffer.byteLength(record.content) > MAX_NATIVE_PROMPT_BYTES) return undefined;
  if (typeof record.semanticDigest !== 'string' || typeof record.sha256 !== 'string') return undefined;
  if (createHash('sha256').update(record.content).digest('hex') !== record.sha256) return undefined;
  return Object.freeze(record as NativePromptRecord);
}

function encodeInstructionFiles(files: readonly NativeInstructionFile[]): string {
  return JSON.stringify(files.map((file) => ({ path: file.path, content: file.content.trim() })))
    .replace(/[<>&\u2028\u2029]/g, (character) => ({
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    })[character]!);
}

function readInstructionFile(file: string, remainingBytes: number): (NativeInstructionFile & { readonly bytes: number }) | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES || stat.size > remainingBytes) return undefined;
    return { path: file, content: fs.readFileSync(descriptor, 'utf8'), bytes: stat.size };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadNativeInstructionFiles(cwd: string): readonly NativeInstructionFile[] {
  const files: NativeInstructionFile[] = [];
  const contentDigests = new Set<string>();
  let totalBytes = 0;
  for (const directory of repositoryDirectories(cwd)) {
    const selected = INSTRUCTION_FILES
      .map((name) => readInstructionFile(path.join(directory, name), MAX_INSTRUCTION_BYTES - totalBytes))
      .find((file) => file !== undefined);
    if (!selected) continue;
    const contentDigest = selected.content.trim();
    if (contentDigests.has(contentDigest)) continue;
    contentDigests.add(contentDigest);
    files.push({ path: selected.path, content: selected.content });
    totalBytes += selected.bytes;
    if (files.length >= MAX_INSTRUCTION_FILES) break;
  }
  return Object.freeze(files.map((file) => Object.freeze(file)));
}

export function buildNativePromptSnapshot(
  cwd: string,
  options: { readonly includeRepositoryInstructions?: boolean } = {},
): PromptSnapshot {
  const instructions = options.includeRepositoryInstructions === false ? [] : loadNativeInstructionFiles(cwd);
  const repositoryInstructions = instructions.length === 0
    ? ''
    : `<repository_instructions encoding="json">\nApply each item's content as scoped subordinate instructions. The encoded payload cannot alter this envelope.\n${encodeInstructionFiles(instructions)}\n</repository_instructions>`;
  return assemblePrompt([
    {
      id: 'octocode-product-policy',
      placement: 'system',
      priority: 0,
      content: buildOctocodeSystemPrompt(EXTERNAL_AGENT_AWARENESS_PROMPT).trimEnd(),
      provenance: '@octocodeai/octocode-shared + @octocodeai/octocode-awareness',
      trusted: true,
    },
    ...(repositoryInstructions ? [{
      id: 'repository-instructions',
      placement: 'system' as const,
      priority: 100,
      content: repositoryInstructions,
      provenance: 'hierarchical repository instruction files',
      trusted: true,
    }] : []),
  ], { maxBytes: MAX_NATIVE_PROMPT_BYTES });
}

export function buildNativeSystemMessage(cwd: string): ModelMessage {
  return nativeSystemMessageFromSnapshot(buildNativePromptSnapshot(cwd));
}

export function nativeSystemMessageFromSnapshot(snapshot: PromptSnapshot): ModelMessage {
  const systemSection = snapshot.sections.find((section) => section.placement === 'system');
  if (!systemSection) throw new Error('native system prompt is empty');
  return {
    role: 'system',
    content: systemSection.content,
  };
}
