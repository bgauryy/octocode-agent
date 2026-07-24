import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface AssetPaths {
  baseDir: string;
  docsDir: string;
  skillsDir: string;
  systemPrompt: string;
  /** Absolute path to the bundled octocode CLI entry point (dist/cli/octocode.js). */
  cliPath: string;
  /** Absolute path to the bundled Awareness CLI entry point (dist/awareness/octocode-awareness.js). */
  awarenessCliPath: string;
}

export function getAssetPaths(baseDir = extensionDir): AssetPaths {
  return {
    baseDir,
    docsDir: path.join(baseDir, 'docs'),
    skillsDir: path.join(baseDir, 'skills'),
    systemPrompt: path.join(baseDir, 'system', 'SYSTEM_PROMPT.md'),
    cliPath: path.join(baseDir, 'cli', 'octocode.js'),
    awarenessCliPath: path.join(baseDir, 'awareness', 'octocode-awareness.js'),
  };
}

/**
 * Returns the absolute path to the bundled octocode CLI entry point.
 * Agents run it with: `node <cliPath> <command>`
 * Also exposed via the OCTOCODE_CLI env var (set at extension load).
 */
export function getCLIPath(baseDir = extensionDir): string {
  // Prefer the build-bundled CLI (dist/cli/octocode.js) — present when the sibling
  // `octocode` package is built in the same monorepo. In checkouts without that
  // sibling, the published `octocode` CLI is a runtime dependency and is resolved
  // from node_modules here, so the agent-facing $OCTOCODE_CLI contract holds either way.
  const bundled = path.join(baseDir, 'cli', 'octocode.js');
  if (fs.existsSync(bundled)) return bundled;
  try {
    const pkgPath = require.resolve('octocode/package.json');
    const root = path.dirname(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.octocode ?? 'out/octocode.js');
    const resolved = path.join(root, bin);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // octocode not installed (pre-install or dev without the dep) — fall through.
  }
  console.warn(
    `[octocode-pi-extension] Warning: CLI not found at ${bundled} or in node_modules. ` +
      `node $OCTOCODE_CLI calls will ENOENT. Run \`yarn install\` or ` +
      `\`yarn workspace @octocodeai/pi-extension build\` to resolve.`,
  );
  return bundled;
}

function resolvePackageBin(packageName: string, defaultBin: string, binName = packageName): string | null {
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const root = path.dirname(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.[binName] ?? defaultBin);
    const resolved = path.join(root, bin);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Some packages do not export package.json; fall back to the module export path.
  }
  try {
    const entryPath = require.resolve(packageName);
    const root = path.dirname(entryPath);
    const resolved = path.join(root, path.basename(defaultBin));
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Package unavailable in this checkout/install — caller handles warning/fallback.
  }
  return null;
}

/**
 * Returns the absolute path to the bundled Awareness CLI entry point.
 * Agents run it with: `node <awarenessCliPath> <noun> <verb> --compact`
 * Also exposed via the OCTOCODE_AWARENESS_CLI env var (set at extension load).
 */
export function getAwarenessCLIPath(baseDir = extensionDir): string {
  const bundled = path.join(baseDir, 'awareness', 'octocode-awareness.js');
  if (fs.existsSync(bundled)) return bundled;
  const resolved = resolvePackageBin('@octocodeai/octocode-awareness', 'out/octocode-awareness.js', '@octocodeai/octocode-awareness');
  if (resolved) return resolved;
  console.warn(
    `[octocode-pi-extension] Warning: Awareness CLI not found at ${bundled} or in node_modules. ` +
      `node $OCTOCODE_AWARENESS_CLI calls will ENOENT. Run \`yarn workspace @octocodeai/octocode-awareness build\` and ` +
      `\`yarn workspace @octocodeai/pi-extension build\` to resolve.`,
  );
  return bundled;
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
