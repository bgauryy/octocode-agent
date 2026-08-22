/**
 * compaction-artifacts — durable markdown breadcrumbs for compacted sessions.
 *
 * Pi's compaction entry stays in the JSONL transcript, but a small markdown copy
 * under Octocode home gives humans and resumed agents a stable path to reopen
 * after context is cleared. These artifacts are best-effort: compaction must
 * never fail because a temp doc could not be written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getOctocodeHome } from '../env.js';
import type { CompactionCheckpointDetails } from './custom-messages.js';

export interface CompactionArtifact {
  path: string;
  latestPath: string;
}

export interface CompactionArtifactSession {
  getSessionId?(): string | undefined;
  getSessionFile?(): string | undefined;
}

function safeFilename(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'checkpoint';
}

function mdList(items: string[] | undefined): string {
  if (!items || items.length === 0) return '(none)';
  return items.map((item) => `- ${item}`).join('\n');
}

function sessionFilename(session?: CompactionArtifactSession): string {
  const sessionId = session?.getSessionId?.();
  const sessionFile = session?.getSessionFile?.();
  const raw = sessionId || (sessionFile ? path.basename(sessionFile) : 'unknown-session');
  return safeFilename(raw);
}

export function compactionArtifactsDir(): string {
  return path.join(getOctocodeHome(), 'tmp', 'compaction');
}

export function buildCompactionMarkdown(details: CompactionCheckpointDetails, createdAt = new Date()): string {
  const source = details.fromExtension === undefined ? 'unknown' : details.fromExtension ? 'octocode' : 'pi';
  return [
    `# Compaction checkpoint ${details.label}`,
    '',
    `Created: ${createdAt.toISOString()}`,
    details.reason ? `Reason: ${details.reason}` : undefined,
    details.tokensBefore !== undefined ? `Tokens before: ${details.tokensBefore}` : undefined,
    `Source: ${source}`,
    '',
    '## Summary',
    '',
    details.summary?.trim() || '(summary unavailable)',
    '',
    '## Read files',
    '',
    mdList(details.readFiles),
    '',
    '## Modified files',
    '',
    mdList(details.modifiedFiles),
    '',
    '## Resume',
    '',
    'Re-orient from this checkpoint. Continue active work only if the compacted summary says work remains; otherwise stop and wait for the user.',
    '',
  ].filter((line): line is string => line !== undefined).join('\n');
}

/**
 * Write `<checkpoint>.md` plus a per-session `sessions/<session>/latest.md` pointer.
 * Never throws.
 */
export function writeCompactionArtifact(
  details: CompactionCheckpointDetails,
  session?: CompactionArtifactSession,
): CompactionArtifact | undefined {
  try {
    const dir = compactionArtifactsDir();
    const sessionDir = path.join(dir, 'sessions', sessionFilename(session));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(dir, `${safeFilename(details.label)}.md`);
    const latestPath = path.join(sessionDir, 'latest.md');
    const markdown = buildCompactionMarkdown(details);
    fs.writeFileSync(filePath, markdown, 'utf8');
    fs.writeFileSync(latestPath, markdown, 'utf8');
    return { path: filePath, latestPath };
  } catch {
    return undefined;
  }
}
