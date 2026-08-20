import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromExtension = createRequire(import.meta.url);

export const AWARENESS_LITE_PACKAGE = '@octocodeai/octocode-awareness-lite';

export interface AwarenessLiteCommandSpec {
  cmd: string;
  args: string[];
}

export function resolveAwarenessLiteCliPath(): string {
  const mainPath = requireFromExtension.resolve(AWARENESS_LITE_PACKAGE);
  return path.join(path.dirname(mainPath), 'cli.js');
}

export function buildAwarenessLiteCommand(args: string[] = []): AwarenessLiteCommandSpec {
  return { cmd: process.execPath, args: [resolveAwarenessLiteCliPath(), ...args] };
}

export interface AssetPaths {
  baseDir: string;
  docsDir: string;
  skillsDir: string;
  systemPrompt: string;
  /** Agent-facing Awareness Lite command display string. */
  awarenessCliPath: string;
}

export function getAssetPaths(baseDir = extensionDir): AssetPaths {
  return {
    baseDir,
    docsDir: path.join(baseDir, 'docs'),
    skillsDir: path.join(baseDir, 'skills'),
    systemPrompt: path.join(baseDir, 'system', 'SYSTEM_PROMPT.md'),
    awarenessCliPath: getAwarenessCLIPath(baseDir),
  };
}

/**
 * Returns the agent-facing Awareness Lite command. Kept under the historical
 * name because launcher/status code imports it, but runtime calls use the
 * installed scoped package directly instead of an unscoped npx lookup.
 */
export function getAwarenessCLIPath(_baseDir = extensionDir): string {
  return `${process.execPath} ${resolveAwarenessLiteCliPath()}`;
}

export function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw error;
  }
}

export function listBundledSkills(baseDir = extensionDir): string[] {
  const { skillsDir } = getAssetPaths(baseDir);
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) =>
      fs.existsSync(path.join(skillsDir, skillName, 'SKILL.md')),
    )
    .sort();
}

export function getInstallSource(baseDir = extensionDir): string {
  const packageRoot = path.dirname(baseDir);
  if (
    packageRoot.includes(
      path.join('node_modules', '@octocodeai', 'pi-extension'),
    )
  ) {
    return 'npm:@octocodeai/pi-extension';
  }
  return packageRoot;
}
